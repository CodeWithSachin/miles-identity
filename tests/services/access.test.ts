/**
 * Authorization and validation logic in src/services/access.ts, driven through
 * injected fakes (same style as tests/services/otp-signin.test.ts) — fast, no
 * database. The collaborators' own real-Postgres behaviour is proven separately
 * in tests/db/access.test.ts.
 */

import { test, expect, describe, mock } from "bun:test";
import {
  grantProductAccess,
  revokeProductAccess,
  buildAccessTokenClaims,
  type GrantDeps,
  type RevokeDeps,
} from "@/services/access";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import type { UserProductAccessRow } from "@/db/types";

const ADMIN = "usr_admin";
const TARGET = "usr_target";

function row(overrides: Partial<UserProductAccessRow> = {}): UserProductAccessRow {
  return {
    id: "acc_1",
    user_id: TARGET,
    product_id: "lms",
    role: "CPA",
    vendor_id: null,
    status: "active",
    granted_by: ADMIN,
    granted_at: new Date(),
    revoked_at: null,
    ...overrides,
  };
}

function grantDeps(overrides: Partial<GrantDeps> = {}): GrantDeps {
  return {
    hasProductAdmin: mock(async () => true),
    userExists: mock(async () => true),
    grantAccess: mock(async () => row()),
    ...overrides,
  };
}

function revokeDeps(overrides: Partial<RevokeDeps> = {}): RevokeDeps {
  return {
    hasProductAdmin: mock(async () => true),
    revokeAccess: mock(async () => row({ status: "revoked", revoked_at: new Date() })),
    ...overrides,
  };
}

describe("grantProductAccess", () => {
  test("grants when the actor is ADMIN for this exact product", async () => {
    const deps = grantDeps();
    const result = await grantProductAccess(ADMIN, { userId: TARGET, productId: "lms", role: "CPA" }, deps);
    expect(result.status).toBe("active");
    expect(deps.grantAccess).toHaveBeenCalledTimes(1);
  });

  // The escalation case: an ADMIN for one product must not be able to grant on another.
  test("throws ForbiddenError when the actor is not ADMIN for this product", async () => {
    const deps = grantDeps({ hasProductAdmin: mock(async () => false) });
    await expect(
      grantProductAccess(ADMIN, { userId: TARGET, productId: "masterclass", role: "CPA" }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.grantAccess).not.toHaveBeenCalled();
  });

  test("throws ValidationError when a VENDOR role is granted without vendor_id", async () => {
    const deps = grantDeps();
    await expect(
      grantProductAccess(ADMIN, { userId: TARGET, productId: "masterclass", role: "VENDOR" }, deps),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(deps.grantAccess).not.toHaveBeenCalled();
  });

  test("throws ValidationError when a non-vendor role carries a vendor_id", async () => {
    const deps = grantDeps();
    await expect(
      grantProductAccess(ADMIN, { userId: TARGET, productId: "lms", role: "CPA", vendorId: "vnd_1" }, deps),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("accepts a VENDOR role with vendor_id", async () => {
    const deps = grantDeps();
    await grantProductAccess(
      ADMIN,
      { userId: TARGET, productId: "masterclass", role: "VENDOR", vendorId: "vnd_1" },
      deps,
    );
    expect(deps.grantAccess).toHaveBeenCalledTimes(1);
  });

  test("throws NotFoundError when the target user does not exist", async () => {
    const deps = grantDeps({ userExists: mock(async () => false) });
    await expect(
      grantProductAccess(ADMIN, { userId: "usr_ghost", productId: "lms", role: "CPA" }, deps),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(deps.grantAccess).not.toHaveBeenCalled();
  });
});

describe("revokeProductAccess", () => {
  test("revokes when the actor is ADMIN for this exact product", async () => {
    const deps = revokeDeps();
    const result = await revokeProductAccess(ADMIN, { userId: TARGET, productId: "lms", role: "CPA" }, deps);
    expect(result.status).toBe("revoked");
  });

  test("throws ForbiddenError when the actor is not ADMIN for this product", async () => {
    const deps = revokeDeps({ hasProductAdmin: mock(async () => false) });
    await expect(
      revokeProductAccess(ADMIN, { userId: TARGET, productId: "lms", role: "CPA" }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.revokeAccess).not.toHaveBeenCalled();
  });

  test("throws NotFoundError when there is no active row to revoke", async () => {
    const deps = revokeDeps({ revokeAccess: mock(async () => null) });
    await expect(
      revokeProductAccess(ADMIN, { userId: TARGET, productId: "lms", role: "CPA" }, deps),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("buildAccessTokenClaims", () => {
  test("returns no claims when there is no user", async () => {
    expect(await buildAccessTokenClaims(undefined)).toEqual({});
  });

  test("includes email claims and the products claim from active access rows", async () => {
    const getAccess = mock(async () => [
      { product_id: "lms" as const, role: "CPA" as const, vendor_id: null },
      { product_id: "masterclass" as const, role: "VENDOR" as const, vendor_id: "vnd_1" },
    ]);

    const claims = await buildAccessTokenClaims(
      { id: "usr_1", email: "a@example.com", emailVerified: true },
      getAccess,
    );

    expect(claims).toEqual({
      email: "a@example.com",
      email_verified: true,
      products: [
        { product_id: "lms", role: "CPA", vendor_id: null },
        { product_id: "masterclass", role: "VENDOR", vendor_id: "vnd_1" },
      ],
    });
    expect(getAccess).toHaveBeenCalledWith("usr_1");
  });

  // A revoked row must never surface — getAccess only returning active rows is
  // the db-layer's job (tests/db/access.test.ts); here we prove the claim is a
  // direct, unfiltered pass-through of whatever it is given.
  test("carries no products claim beyond what getAccess returns", async () => {
    const claims = await buildAccessTokenClaims(
      { id: "usr_1", email: "a@example.com", emailVerified: true },
      mock(async () => []),
    );
    expect(claims["products"]).toEqual([]);
  });
});
