/**
 * `user_product_access` queries — Layer 1 (RBAC) reads and writes. All of OUR SQL
 * lives here (AGENTS.md: only db/ writes SQL). `Bun.sql`, parameterised.
 *
 * Revocation is a status flip, never a DELETE (migration 0004 comment / AGENTS.md
 * data model) — `revokeAccess` enforces that by construction: it can only ever
 * UPDATE.
 */

import { sql, type SQL } from "bun";
import { newId } from "@/db/types";
import type { ProductId, Role, UserProductAccessRow } from "@/db/types";

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
  const rows = (await client`
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
  return rows[0]!;
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
  const rows = (await client`
    UPDATE user_product_access
    SET status = 'revoked', revoked_at = now()
    WHERE user_id = ${input.userId} AND product_id = ${input.productId} AND role = ${input.role} AND status = 'active'
    RETURNING *
  `) as UserProductAccessRow[];
  return rows[0] ?? null;
}
