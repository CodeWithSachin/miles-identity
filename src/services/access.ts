/**
 * Product access RBAC — Layer 1 (AGENTS.md roadmap step 8). Business logic only;
 * no `Request`/`Response` here (AGENTS.md architecture rule). The HTTP shaping
 * lives in `src/routes/admin/access.ts`, the SQL in `src/db/access.ts`.
 *
 * DB collaborators are injected (same reasoning as `src/services/otp-signin.ts`)
 * so the authorization and validation logic is testable without a live database;
 * the collaborators' own real-Postgres behaviour is proven separately in
 * `tests/db/access.test.ts`.
 */

import {
  getActiveAccessForUser,
  grantAccess as dbGrantAccess,
  hasProductAdmin as dbHasProductAdmin,
  revokeAccess as dbRevokeAccess,
  userExists as dbUserExists,
  type ProductAccessClaim,
} from "@/db/access";
import { VENDOR_ROLES } from "@/db/types";
import type { ProductId, Role, UserProductAccessRow } from "@/db/types";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/logger";

export type GrantInput = { userId: string; productId: ProductId; role: Role; vendorId?: string | undefined };
export type RevokeInput = { userId: string; productId: ProductId; role: Role };

export type GrantDeps = {
  hasProductAdmin: (userId: string, productId: ProductId) => Promise<boolean>;
  userExists: (userId: string) => Promise<boolean>;
  grantAccess: (input: {
    userId: string;
    productId: ProductId;
    role: Role;
    vendorId: string | null;
    grantedBy: string;
  }) => Promise<UserProductAccessRow>;
};

export type RevokeDeps = {
  hasProductAdmin: (userId: string, productId: ProductId) => Promise<boolean>;
  revokeAccess: (input: RevokeInput) => Promise<UserProductAccessRow | null>;
};

const defaultGrantDeps: GrantDeps = {
  hasProductAdmin: dbHasProductAdmin,
  userExists: dbUserExists,
  grantAccess: dbGrantAccess,
};

const defaultRevokeDeps: RevokeDeps = {
  hasProductAdmin: dbHasProductAdmin,
  revokeAccess: dbRevokeAccess,
};

/**
 * Mirrors `ck_access_vendor_scope` in application code, so a bad request fails
 * with a clean 400 instead of surfacing a raw constraint-violation message. The
 * database constraint remains the actual enforcement point (belt and suspenders,
 * not a replacement).
 */
function assertVendorScope(role: Role, vendorId: string | undefined): void {
  const needsVendor = (VENDOR_ROLES as readonly string[]).includes(role);
  if (needsVendor && vendorId === undefined) {
    throw new ValidationError(`role ${role} requires vendor_id`);
  }
  if (!needsVendor && vendorId !== undefined) {
    throw new ValidationError(`role ${role} must not carry vendor_id`);
  }
}

/**
 * Grant (or reactivate) a `user_product_access` row.
 *
 * `actorUserId` must hold an active ADMIN row for the SAME `product_id` — the
 * privilege-escalation guard (security.md): an ADMIN for one product cannot
 * grant or revoke access on another.
 */
export async function grantProductAccess(
  actorUserId: string,
  input: GrantInput,
  deps: GrantDeps = defaultGrantDeps,
): Promise<UserProductAccessRow> {
  if (!(await deps.hasProductAdmin(actorUserId, input.productId))) {
    throw new ForbiddenError(`${actorUserId} is not an ADMIN for product ${input.productId}`);
  }
  assertVendorScope(input.role, input.vendorId);
  if (!(await deps.userExists(input.userId))) {
    throw new NotFoundError(`user ${input.userId} not found`);
  }

  const row = await deps.grantAccess({
    userId: input.userId,
    productId: input.productId,
    role: input.role,
    vendorId: input.vendorId ?? null,
    grantedBy: actorUserId,
  });

  log.info("access_granted", {
    actorUserId,
    targetUserId: input.userId,
    productId: input.productId,
    role: input.role,
  });
  return row;
}

/** Same authorization gate as `grantProductAccess`; 404s when there is no active row to revoke. */
export async function revokeProductAccess(
  actorUserId: string,
  input: RevokeInput,
  deps: RevokeDeps = defaultRevokeDeps,
): Promise<UserProductAccessRow> {
  if (!(await deps.hasProductAdmin(actorUserId, input.productId))) {
    throw new ForbiddenError(`${actorUserId} is not an ADMIN for product ${input.productId}`);
  }

  const row = await deps.revokeAccess(input);
  if (!row) {
    throw new NotFoundError(
      `no active access row for user ${input.userId} / ${input.productId} / ${input.role}`,
    );
  }

  log.info("access_revoked", {
    actorUserId,
    targetUserId: input.userId,
    productId: input.productId,
    role: input.role,
  });
  return row;
}

export type AccessTokenUser = { id: string; email: string; emailVerified: boolean };

/**
 * The `customAccessTokenClaims` body, extracted so it is testable without a real
 * OAuth flow or a live database — `getAccess` is injectable for exactly that.
 *
 * `src/auth.ts` step-6 comment: token claims stayed identity-only "until
 * `user_product_access` has read helpers" — this is that wiring.
 */
export async function buildAccessTokenClaims(
  user: AccessTokenUser | undefined,
  getAccess: (userId: string) => Promise<ProductAccessClaim[]> = getActiveAccessForUser,
): Promise<Record<string, unknown>> {
  if (!user) return {};
  const products = await getAccess(user.id);
  return {
    email: user.email,
    email_verified: user.emailVerified,
    products: products.map(p => ({ product_id: p.product_id, role: p.role, vendor_id: p.vendor_id })),
  };
}
