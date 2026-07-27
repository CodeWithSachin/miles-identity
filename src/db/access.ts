/**
 * `user_product_access` queries — Layer 1 (RBAC) reads and writes. All of OUR SQL
 * lives here (AGENTS.md: only db/ writes SQL). `Bun.sql`, parameterised.
 *
 * Revocation is a status flip, never a DELETE (migration 0004 comment / AGENTS.md
 * data model) — `revokeAccess` enforces that by construction: it can only ever
 * UPDATE.
 */

import { sql, type SQL } from "bun";
import { newId, VENDOR_ROLES } from "@/db/types";
import type { ProductId, Role, UserProductAccessRow, VendorRole } from "@/db/types";

/** True for the only roles this repo currently syncs into OpenFGA tuples (vendor#admin/staff). */
function isVendorScopedRole(role: Role): role is VendorRole {
  return (VENDOR_ROLES as readonly string[]).includes(role);
}

/**
 * The `vendor_access` outbox payload `src/authz/tuples.ts` parses. Written
 * alongside the domain row, never separately (AGENTS.md: never write a tuple
 * from a request handler — that is a dual write and it will drift).
 * `null` when the row isn't one of the relations this repo syncs to OpenFGA.
 *
 * Returned as a plain object, not a `JSON.stringify`'d string — `Bun.sql`
 * encodes an object parameter as jsonb correctly by itself; stringifying it
 * first double-encodes it into a jsonb *string* scalar instead of an object,
 * which `payload->>'key'` (and `authz/tuples.ts`'s zod parse) would then see
 * as `null`/a type error.
 */
function vendorAccessOutboxPayload(
  row: Pick<UserProductAccessRow, "user_id" | "vendor_id" | "role">,
): Record<string, unknown> | null {
  if (!isVendorScopedRole(row.role) || row.vendor_id === null) return null;
  return { userId: row.user_id, vendorId: row.vendor_id, role: row.role };
}

export type ProductAccessClaim = {
  product_id: ProductId;
  role: Role;
  vendor_id: string | null;
};

/**
 * Every active row for a user — the read helper `src/auth.ts` was already written
 * to expect (step 7 comment), feeding the access token's `products` claim.
 */
export async function getActiveAccessForUser(userId: string, client: SQL = sql): Promise<ProductAccessClaim[]> {
  return (await client`
    SELECT product_id, role, vendor_id
    FROM user_product_access
    WHERE user_id = ${userId} AND status = 'active'
  `) as ProductAccessClaim[];
}

/**
 * True iff the user holds an active ADMIN row for exactly this product — the
 * authorization gate for the admin grant/revoke endpoint. Deliberately scoped to
 * one `product_id`: an ADMIN for `lms` must not be able to touch `masterclass`.
 */
export async function hasProductAdmin(userId: string, productId: ProductId, client: SQL = sql): Promise<boolean> {
  const rows = (await client`
    SELECT 1 AS present FROM user_product_access
    WHERE user_id = ${userId} AND product_id = ${productId} AND role = 'ADMIN' AND status = 'active'
    LIMIT 1
  `) as { present: number }[];
  return rows.length > 0;
}

/** Does the target of a grant/revoke exist at all, in the Better-Auth-owned `user` table. */
export async function userExists(userId: string, client: SQL = sql): Promise<boolean> {
  const rows = (await client`SELECT 1 AS present FROM "user" WHERE id = ${userId} LIMIT 1`) as { present: number }[];
  return rows.length > 0;
}

/**
 * Insert or reactivate. `ON CONFLICT` targets `uq_access_user_product_role`, so
 * granting an already-active role is idempotent (same row, refreshed granted_at)
 * rather than a duplicate-key error, and re-granting a revoked role reactivates it
 * in place instead of leaving a second, unreachable row behind.
 */
export async function grantAccess(
  input: { userId: string; productId: ProductId; role: Role; vendorId: string | null; grantedBy: string },
  client: SQL = sql,
): Promise<UserProductAccessRow> {
  return (await client.begin(async (tx) => {
    const rows = (await tx`
      INSERT INTO user_product_access (id, user_id, product_id, role, vendor_id, status, granted_by, granted_at, revoked_at)
      VALUES (${newId("access")}, ${input.userId}, ${input.productId}, ${input.role}, ${input.vendorId}, 'active', ${input.grantedBy}, now(), NULL)
      ON CONFLICT (user_id, product_id, role) DO UPDATE SET
        status = 'active',
        vendor_id = EXCLUDED.vendor_id,
        granted_by = EXCLUDED.granted_by,
        granted_at = now(),
        revoked_at = NULL
      RETURNING *
    `) as UserProductAccessRow[];
    const row = rows[0]!;

    const payload = vendorAccessOutboxPayload(row);
    if (payload !== null) {
      await tx`
        INSERT INTO outbox (aggregate, event_type, payload)
        VALUES ('vendor_access', 'granted', ${payload})
      `;
    }

    return row;
  })) as UserProductAccessRow;
}

/**
 * Flips an active row to revoked. Returns `null` when there was no active row to
 * revoke (already revoked, or never granted) — that is a 404 to the caller, not a
 * thrown error here; this function only ever describes what happened to the row.
 */
export async function revokeAccess(
  input: { userId: string; productId: ProductId; role: Role },
  client: SQL = sql,
): Promise<UserProductAccessRow | null> {
  return (await client.begin(async (tx) => {
    const rows = (await tx`
      UPDATE user_product_access
      SET status = 'revoked', revoked_at = now()
      WHERE user_id = ${input.userId} AND product_id = ${input.productId} AND role = ${input.role} AND status = 'active'
      RETURNING *
    `) as UserProductAccessRow[];
    const row = rows[0] ?? null;
    if (row === null) return null;

    const payload = vendorAccessOutboxPayload(row);
    if (payload !== null) {
      await tx`
        INSERT INTO outbox (aggregate, event_type, payload)
        VALUES ('vendor_access', 'revoked', ${payload})
      `;
    }

    return row;
  })) as UserProductAccessRow | null;
}

/**
 * Paginated read of every active, vendor-scoped access row — the shadow
 * reconciliation job's input (`src/authz/shadow.ts`). Keyset, not `OFFSET`
 * (postgres-migrations skill): ids are UUIDv7-based and lexically
 * time-ordered, so plain `id > cursor` pagination is valid here, same as
 * every other batch job in this codebase.
 */
export type VendorScopedAccessRow = { id: string; user_id: string; vendor_id: string; role: VendorRole };

export async function listActiveVendorScopedAccess(
  cursor: string,
  limit: number,
  client: SQL = sql,
): Promise<VendorScopedAccessRow[]> {
  return (await client`
    SELECT id, user_id, vendor_id, role
    FROM user_product_access
    WHERE status = 'active' AND vendor_id IS NOT NULL AND id > ${cursor}
    ORDER BY id
    LIMIT ${limit}
  `) as VendorScopedAccessRow[];
}
