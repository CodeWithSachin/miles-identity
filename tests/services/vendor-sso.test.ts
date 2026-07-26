/**
 * Authorization, domain-matching and JIT-scope logic in
 * src/services/vendor-sso.ts, driven through injected fakes (same style as
 * tests/services/access.test.ts) — fast, no database, no live Better Auth
 * instance. The collaborators' own real-Postgres behaviour is proven
 * separately in tests/db/vendor.test.ts.
 */

import { test, expect, describe, mock } from "bun:test";
import {
  createVendor,
  disableVendor,
  provisionVendorUser,
  registerVendorSsoProvider,
  verifyVendorDomain,
  type CreateVendorDeps,
  type DisableVendorDeps,
  type ProvisionVendorUserDeps,
  type RegisterProviderDeps,
  type VerifyDomainDeps,
} from "@/services/vendor-sso";
import { ForbiddenError, IntegrationError, NotFoundError, ValidationError } from "@/lib/errors";
import type { UserIdentityRow, UserProductAccessRow, VendorRow } from "@/db/types";

const ADMIN = "usr_admin";
const VENDOR_ID = "vnd_1";

function vendorRow(overrides: Partial<VendorRow> = {}): VendorRow {
  return {
    id: VENDOR_ID,
    name: "Acme Prep",
    sso_provider_id: "ssp_1",
    allowed_email_domains: ["acmeprep.example"],
    domain_verified_at: null,
    status: "pending",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ── createVendor ────────────────────────────────────────────────────────────────

function createVendorDeps(overrides: Partial<CreateVendorDeps> = {}): CreateVendorDeps {
  return {
    hasProductAdmin: mock(async () => true),
    createVendor: mock(async () => vendorRow()),
    ...overrides,
  };
}

describe("createVendor", () => {
  test("creates when the actor is ADMIN for masterclass", async () => {
    const deps = createVendorDeps();
    const vendor = await createVendor(ADMIN, { name: "Acme Prep", domain: "acmeprep.example" }, deps);
    expect(vendor.status).toBe("pending");
  });

  test("throws ForbiddenError for a non-ADMIN actor", async () => {
    const deps = createVendorDeps({ hasProductAdmin: mock(async () => false) });
    await expect(
      createVendor(ADMIN, { name: "Acme Prep", domain: "acmeprep.example" }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.createVendor).not.toHaveBeenCalled();
  });
});

// ── registerVendorSsoProvider ───────────────────────────────────────────────────

function registerDeps(overrides: Partial<RegisterProviderDeps> = {}): RegisterProviderDeps {
  return {
    hasProductAdmin: mock(async () => true),
    getVendorById: mock(async () => vendorRow()),
    setVendorSsoProvider: mock(async () => vendorRow({ sso_provider_id: "ssp_new" })),
    registerProvider: mock(async () => ({ domainVerificationToken: "token-abc" })),
    ...overrides,
  };
}

describe("registerVendorSsoProvider", () => {
  test("registers and returns DNS TXT instructions", async () => {
    const deps = registerDeps();
    const result = await registerVendorSsoProvider(
      ADMIN,
      { vendorId: VENDOR_ID, issuer: "https://idp.acmeprep.example", oidcConfig: { clientId: "x", clientSecret: "y" } },
      deps,
    );
    expect(result.dnsRecordHost).toBe("_better-auth-token.acmeprep.example");
    expect(result.dnsRecordValue).toBe("token-abc");
    expect(deps.setVendorSsoProvider).toHaveBeenCalledTimes(1);
  });

  test("throws ForbiddenError for a non-ADMIN actor", async () => {
    const deps = registerDeps({ hasProductAdmin: mock(async () => false) });
    await expect(
      registerVendorSsoProvider(ADMIN, { vendorId: VENDOR_ID, issuer: "https://idp.example", oidcConfig: {} }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.registerProvider).not.toHaveBeenCalled();
  });

  test("throws NotFoundError when the vendor does not exist", async () => {
    const deps = registerDeps({ getVendorById: mock(async () => null) });
    await expect(
      registerVendorSsoProvider(ADMIN, { vendorId: "vnd_missing", issuer: "https://idp.example", oidcConfig: {} }, deps),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("throws ValidationError when both oidcConfig and samlConfig are supplied", async () => {
    const deps = registerDeps();
    await expect(
      registerVendorSsoProvider(
        ADMIN,
        { vendorId: VENDOR_ID, issuer: "https://idp.example", oidcConfig: {}, samlConfig: {} },
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(deps.registerProvider).not.toHaveBeenCalled();
  });

  test("throws ValidationError when neither oidcConfig nor samlConfig is supplied", async () => {
    const deps = registerDeps();
    await expect(
      registerVendorSsoProvider(ADMIN, { vendorId: VENDOR_ID, issuer: "https://idp.example" }, deps),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ── verifyVendorDomain ──────────────────────────────────────────────────────────

function verifyDeps(overrides: Partial<VerifyDomainDeps> = {}): VerifyDomainDeps {
  return {
    hasProductAdmin: mock(async () => true),
    getVendorById: mock(async () => vendorRow()),
    activateVendor: mock(async () => vendorRow({ status: "active", domain_verified_at: new Date() })),
    verifyDomain: mock(async () => {}),
    ...overrides,
  };
}

describe("verifyVendorDomain", () => {
  test("activates the vendor on success", async () => {
    const deps = verifyDeps();
    const result = await verifyVendorDomain(ADMIN, VENDOR_ID, deps);
    expect(result.status).toBe("active");
  });

  test("throws ForbiddenError for a non-ADMIN actor", async () => {
    const deps = verifyDeps({ hasProductAdmin: mock(async () => false) });
    await expect(verifyVendorDomain(ADMIN, VENDOR_ID, deps)).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.verifyDomain).not.toHaveBeenCalled();
  });

  test("throws ValidationError when the vendor has no registered provider", async () => {
    const deps = verifyDeps({ getVendorById: mock(async () => vendorRow({ sso_provider_id: null })) });
    await expect(verifyVendorDomain(ADMIN, VENDOR_ID, deps)).rejects.toBeInstanceOf(ValidationError);
    expect(deps.verifyDomain).not.toHaveBeenCalled();
  });

  test("treats Better Auth's 409 (already verified) as success and still activates", async () => {
    const deps = verifyDeps({
      verifyDomain: mock(async () => {
        throw { statusCode: 409, body: { message: "already verified" } };
      }),
    });
    const result = await verifyVendorDomain(ADMIN, VENDOR_ID, deps);
    expect(result.status).toBe("active");
  });

  test("maps Better Auth's 502 (DNS lookup failed) to IntegrationError", async () => {
    const deps = verifyDeps({
      verifyDomain: mock(async () => {
        throw { statusCode: 502, body: { message: "TXT record not found" } };
      }),
    });
    await expect(verifyVendorDomain(ADMIN, VENDOR_ID, deps)).rejects.toBeInstanceOf(IntegrationError);
  });

  test("maps Better Auth's 404 to NotFoundError", async () => {
    const deps = verifyDeps({
      verifyDomain: mock(async () => {
        throw { statusCode: 404, body: { message: "provider not found" } };
      }),
    });
    await expect(verifyVendorDomain(ADMIN, VENDOR_ID, deps)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── disableVendor ───────────────────────────────────────────────────────────────

function disableDeps(overrides: Partial<DisableVendorDeps> = {}): DisableVendorDeps {
  return {
    hasProductAdmin: mock(async () => true),
    getVendorById: mock(async () => vendorRow({ status: "active" })),
    disableVendorRow: mock(async () => vendorRow({ status: "disabled", sso_provider_id: null })),
    deleteProvider: mock(async () => {}),
    ...overrides,
  };
}

describe("disableVendor", () => {
  test("deletes the underlying Better Auth provider and disables the vendor row", async () => {
    const deps = disableDeps();
    const result = await disableVendor(ADMIN, VENDOR_ID, deps);
    expect(result.status).toBe("disabled");
    expect(deps.deleteProvider).toHaveBeenCalledTimes(1);
  });

  test("throws ForbiddenError for a non-ADMIN actor", async () => {
    const deps = disableDeps({ hasProductAdmin: mock(async () => false) });
    await expect(disableVendor(ADMIN, VENDOR_ID, deps)).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.deleteProvider).not.toHaveBeenCalled();
  });

  test("throws NotFoundError when the vendor does not exist", async () => {
    const deps = disableDeps({ getVendorById: mock(async () => null) });
    await expect(disableVendor(ADMIN, VENDOR_ID, deps)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── provisionVendorUser ─────────────────────────────────────────────────────────

function identityRow(): UserIdentityRow {
  return {
    id: "idt_1",
    user_id: "usr_new",
    type: "email",
    value: "person@acmeprep.example",
    is_primary: true,
    is_verified: true,
    source: "masterclass",
    verified_at: new Date(),
    created_at: new Date(),
  };
}

function accessRow(): UserProductAccessRow {
  return {
    id: "acc_1",
    user_id: "usr_new",
    product_id: "masterclass",
    role: "VENDOR",
    vendor_id: VENDOR_ID,
    status: "active",
    granted_by: "system:vendor-sso",
    granted_at: new Date(),
    revoked_at: null,
  };
}

function provisionDeps(overrides: Partial<ProvisionVendorUserDeps> = {}): ProvisionVendorUserDeps {
  return {
    getVendorBySsoProviderId: mock(async () => vendorRow({ status: "active" })),
    createVerifiedIdentity: mock(async () => identityRow()),
    grantAccess: mock(async () => accessRow()),
    ...overrides,
  };
}

describe("provisionVendorUser", () => {
  test("grants exactly masterclass/VENDOR for a matching-domain, active vendor", async () => {
    const deps = provisionDeps();
    await provisionVendorUser({ userId: "usr_new", email: "Person@AcmePrep.example", ssoProviderId: "ssp_1" }, deps);

    expect(deps.createVerifiedIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "usr_new", type: "email", value: "person@acmeprep.example", source: "masterclass" }),
    );
    expect(deps.grantAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "usr_new",
        productId: "masterclass",
        role: "VENDOR",
        vendorId: VENDOR_ID,
        grantedBy: "system:vendor-sso",
      }),
    );
  });

  // Negative: no vendor row for this ssoProviderId at all.
  test("throws and grants nothing when no vendor is registered for this provider", async () => {
    const deps = provisionDeps({ getVendorBySsoProviderId: mock(async () => null) });
    await expect(
      provisionVendorUser({ userId: "usr_new", email: "person@acmeprep.example", ssoProviderId: "ssp_unknown" }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.createVerifiedIdentity).not.toHaveBeenCalled();
    expect(deps.grantAccess).not.toHaveBeenCalled();
  });

  // Negative: vendor exists but is pending (domain not yet verified).
  test("throws and grants nothing when the vendor is pending", async () => {
    const deps = provisionDeps({ getVendorBySsoProviderId: mock(async () => vendorRow({ status: "pending" })) });
    await expect(
      provisionVendorUser({ userId: "usr_new", email: "person@acmeprep.example", ssoProviderId: "ssp_1" }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.grantAccess).not.toHaveBeenCalled();
  });

  // Negative: vendor disabled.
  test("throws and grants nothing when the vendor is disabled", async () => {
    const deps = provisionDeps({ getVendorBySsoProviderId: mock(async () => vendorRow({ status: "disabled" })) });
    await expect(
      provisionVendorUser({ userId: "usr_new", email: "person@acmeprep.example", ssoProviderId: "ssp_1" }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.grantAccess).not.toHaveBeenCalled();
  });

  // Negative: the actual takeover-path-4 case — an out-of-domain email.
  test("throws and grants nothing when the asserted email's domain is not allowed", async () => {
    const deps = provisionDeps();
    await expect(
      provisionVendorUser({ userId: "usr_new", email: "person@evil.example", ssoProviderId: "ssp_1" }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.createVerifiedIdentity).not.toHaveBeenCalled();
    expect(deps.grantAccess).not.toHaveBeenCalled();
  });
});
