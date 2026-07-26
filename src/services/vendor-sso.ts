/**
 * Inbound vendor SSO — roadmap step 11 (prompts/011). Business logic only; no
 * `Request`/`Response` here (AGENTS.md architecture rule). HTTP shaping lives in
 * `src/routes/admin/vendors.ts`, vendor-table SQL in `src/db/vendor.ts`.
 *
 * DB and Better-Auth collaborators are injected (same DI pattern as
 * `src/services/access.ts`), so authorization, domain-matching and JIT-scope
 * logic are testable without a live database or a live Better Auth instance.
 * The default deps' Better-Auth calls lazily import `@/auth` — this module is
 * itself imported (dynamically, from `src/auth.ts`'s `provisionUser`) by that
 * same instance, so a top-level `import { auth } from "@/auth"` here would be
 * circular at module-eval time. Lazy import resolves once `auth` is fully
 * constructed, same reasoning as `getRedis`/`getAccessTokenClaimsBuilder` in
 * `src/auth.ts`.
 */

import { normaliseEmail } from "@/identity/normalise";
import {
  activateVendor as dbActivateVendor,
  createVendor as dbCreateVendor,
  disableVendorRow as dbDisableVendorRow,
  getVendorById as dbGetVendorById,
  getVendorBySsoProviderId as dbGetVendorBySsoProviderId,
  setVendorSsoProvider as dbSetVendorSsoProvider,
} from "@/db/vendor";
import { grantAccess as dbGrantAccess, hasProductAdmin as dbHasProductAdmin } from "@/db/access";
import { createVerifiedIdentity as dbCreateVerifiedIdentity } from "@/db/identity";
import { newId } from "@/db/types";
import type { VendorRow } from "@/db/types";
import { ForbiddenError, IntegrationError, NotFoundError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/logger";

/** The Better-Auth-owned system actor for a JIT grant — no `user` row initiates it. */
const SYSTEM_ACTOR = "system:vendor-sso";

/**
 * Deliberately loose — Better Auth's own `registerSSOProvider` zod schema is
 * the actual, authoritative validation of an OIDC/SAML config's required
 * fields (clientId/clientSecret, entryPoint/cert/callbackUrl, ...); it throws
 * a typed error the caller maps to a 400 if the config is malformed. Mirroring
 * that schema field-for-field here would just be a second, driftable copy of it.
 */
type OidcConfig = Record<string, unknown>;
type SamlConfig = Record<string, unknown>;

async function getAuthApi() {
  return (await import("@/auth")).auth.api;
}

/** Any error Better Auth's own SSO endpoints throw carries a numeric `statusCode`. */
function isBetterAuthApiError(error: unknown): error is { statusCode: number; body?: { message?: string } } {
  return typeof error === "object" && error !== null && "statusCode" in error;
}

// ── registerVendorSsoProvider ──────────────────────────────────────────────────

export type RegisterProviderInput = {
  vendorId: string;
  issuer: string;
  oidcConfig?: OidcConfig;
  samlConfig?: SamlConfig;
};

export type RegisterProviderResult = {
  providerId: string;
  domainVerificationToken: string;
  dnsRecordHost: string;
  dnsRecordValue: string;
};

export type RegisterProviderDeps = {
  hasProductAdmin: (userId: string, productId: "masterclass") => Promise<boolean>;
  getVendorById: (id: string) => Promise<VendorRow | null>;
  setVendorSsoProvider: (id: string, ssoProviderId: string) => Promise<VendorRow | null>;
  registerProvider: (input: {
    providerId: string;
    issuer: string;
    domain: string;
    oidcConfig?: OidcConfig;
    samlConfig?: SamlConfig;
  }) => Promise<{ domainVerificationToken: string }>;
};

const defaultRegisterProviderDeps: RegisterProviderDeps = {
  hasProductAdmin: dbHasProductAdmin,
  getVendorById: dbGetVendorById,
  setVendorSsoProvider: dbSetVendorSsoProvider,
  registerProvider: async (input) => {
    const api = await getAuthApi();
    // `body` is cast: our own `OidcConfig`/`SamlConfig` types are deliberately
    // loose (see the comment above them) — Better Auth's own zod schema is the
    // real validation and throws a typed error on a malformed config.
    const body = {
      providerId: input.providerId,
      issuer: input.issuer,
      domain: input.domain,
      ...(input.oidcConfig ? { oidcConfig: input.oidcConfig } : {}),
      ...(input.samlConfig ? { samlConfig: input.samlConfig } : {}),
    };
    const result = await api.registerSSOProvider({ body } as Parameters<typeof api.registerSSOProvider>[0]);
    return { domainVerificationToken: result.domainVerificationToken };
  },
};

/**
 * Registers (or re-registers, e.g. after `disableVendor`) the Better Auth SSO
 * provider a vendor's employees will sign in through. Requires the caller to
 * hold ADMIN for `masterclass` (security.md: every admin handler performs its
 * own explicit check).
 */
export async function registerVendorSsoProvider(
  actorUserId: string,
  input: { vendorId: string; issuer: string; oidcConfig?: OidcConfig; samlConfig?: SamlConfig },
  deps: RegisterProviderDeps = defaultRegisterProviderDeps,
): Promise<RegisterProviderResult> {
  if (!(await deps.hasProductAdmin(actorUserId, "masterclass"))) {
    throw new ForbiddenError(`${actorUserId} is not an ADMIN for product masterclass`);
  }

  const hasOidc = input.oidcConfig !== undefined;
  const hasSaml = input.samlConfig !== undefined;
  if (hasOidc === hasSaml) {
    throw new ValidationError("exactly one of oidcConfig or samlConfig is required");
  }

  const vendor = await deps.getVendorById(input.vendorId);
  if (!vendor) {
    throw new NotFoundError(`vendor ${input.vendorId} not found`);
  }

  const domain = vendor.allowed_email_domains[0];
  if (!domain) {
    throw new ValidationError(`vendor ${input.vendorId} has no allowed_email_domains entry`);
  }

  const providerId = newId("vendorSso");
  const { domainVerificationToken } = await deps.registerProvider({
    providerId,
    issuer: input.issuer,
    domain,
    ...(input.oidcConfig ? { oidcConfig: input.oidcConfig } : {}),
    ...(input.samlConfig ? { samlConfig: input.samlConfig } : {}),
  });

  await deps.setVendorSsoProvider(vendor.id, providerId);

  log.info("vendor_sso_provider_registered", { vendorId: vendor.id, providerId });

  return {
    providerId,
    domainVerificationToken,
    dnsRecordHost: `_better-auth-token.${domain}`,
    dnsRecordValue: domainVerificationToken,
  };
}

// ── verifyVendorDomain ──────────────────────────────────────────────────────────

export type VerifyDomainDeps = {
  hasProductAdmin: (userId: string, productId: "masterclass") => Promise<boolean>;
  getVendorById: (id: string) => Promise<VendorRow | null>;
  activateVendor: (id: string) => Promise<VendorRow | null>;
  verifyDomain: (input: { providerId: string }) => Promise<void>;
};

const defaultVerifyDomainDeps: VerifyDomainDeps = {
  hasProductAdmin: dbHasProductAdmin,
  getVendorById: dbGetVendorById,
  activateVendor: dbActivateVendor,
  verifyDomain: async (input) => {
    const api = await getAuthApi();
    await api.verifyDomain({ body: { providerId: input.providerId } });
  },
};

/**
 * Triggers Better Auth's own DNS TXT lookup for a vendor's registered provider,
 * then activates the vendor row on success. Better Auth's `verifyDomain` throws
 * a typed error (404 unknown provider, 409 already verified, 502 lookup failed)
 * — mapped here to our own AppError types rather than leaking a raw Better Auth
 * error to the admin console.
 */
export async function verifyVendorDomain(
  actorUserId: string,
  vendorId: string,
  deps: VerifyDomainDeps = defaultVerifyDomainDeps,
): Promise<VendorRow> {
  if (!(await deps.hasProductAdmin(actorUserId, "masterclass"))) {
    throw new ForbiddenError(`${actorUserId} is not an ADMIN for product masterclass`);
  }

  const vendor = await deps.getVendorById(vendorId);
  if (!vendor) {
    throw new NotFoundError(`vendor ${vendorId} not found`);
  }
  if (!vendor.sso_provider_id) {
    throw new ValidationError(`vendor ${vendorId} has no registered SSO provider to verify`);
  }

  try {
    await deps.verifyDomain({ providerId: vendor.sso_provider_id });
  } catch (error) {
    if (isBetterAuthApiError(error)) {
      if (error.statusCode === 409) {
        // Already verified — proceed to (re)activate our row rather than fail.
      } else if (error.statusCode === 404) {
        throw new NotFoundError(error.body?.message ?? "SSO provider not found");
      } else {
        throw new IntegrationError("better-auth-sso", error.body?.message ?? "domain verification failed", {
          cause: error,
        });
      }
    } else {
      throw error;
    }
  }

  const activated = await deps.activateVendor(vendor.id);
  if (!activated) {
    throw new ValidationError(`vendor ${vendorId} could not be activated (is it disabled?)`);
  }

  log.info("vendor_domain_verified", { vendorId: vendor.id });
  return activated;
}

// ── disableVendor ───────────────────────────────────────────────────────────────

export type DisableVendorDeps = {
  hasProductAdmin: (userId: string, productId: "masterclass") => Promise<boolean>;
  getVendorById: (id: string) => Promise<VendorRow | null>;
  disableVendorRow: (id: string) => Promise<VendorRow | null>;
  deleteProvider: (input: { providerId: string }) => Promise<void>;
};

const defaultDisableVendorDeps: DisableVendorDeps = {
  hasProductAdmin: dbHasProductAdmin,
  getVendorById: dbGetVendorById,
  disableVendorRow: dbDisableVendorRow,
  deleteProvider: async (input) => {
    const api = await getAuthApi();
    await api.deleteSSOProvider({ body: { providerId: input.providerId } });
  },
};

/**
 * Disables a vendor and deletes its underlying Better Auth `ssoProvider` row.
 * The deletion, not a status flag, is what blocks every future sign-in
 * immediately — `provisionUser` only runs for first-time registrations, so a
 * flag it alone checked would leave a returning vendor employee's second login
 * unaffected (prompts/011, Assumption 4).
 */
export async function disableVendor(
  actorUserId: string,
  vendorId: string,
  deps: DisableVendorDeps = defaultDisableVendorDeps,
): Promise<VendorRow> {
  if (!(await deps.hasProductAdmin(actorUserId, "masterclass"))) {
    throw new ForbiddenError(`${actorUserId} is not an ADMIN for product masterclass`);
  }

  const vendor = await deps.getVendorById(vendorId);
  if (!vendor) {
    throw new NotFoundError(`vendor ${vendorId} not found`);
  }

  if (vendor.sso_provider_id) {
    await deps.deleteProvider({ providerId: vendor.sso_provider_id });
  }

  const disabled = await deps.disableVendorRow(vendor.id);
  if (!disabled) {
    throw new NotFoundError(`vendor ${vendorId} not found`);
  }

  log.info("vendor_disabled", { vendorId: vendor.id });
  return disabled;
}

// ── createVendor (thin passthrough, kept here so the route stays a pure shim) ──

export type CreateVendorDeps = {
  hasProductAdmin: (userId: string, productId: "masterclass") => Promise<boolean>;
  createVendor: (input: { name: string; domain: string }) => Promise<VendorRow>;
};

const defaultCreateVendorDeps: CreateVendorDeps = {
  hasProductAdmin: dbHasProductAdmin,
  createVendor: dbCreateVendor,
};

export async function createVendor(
  actorUserId: string,
  input: { name: string; domain: string },
  deps: CreateVendorDeps = defaultCreateVendorDeps,
): Promise<VendorRow> {
  if (!(await deps.hasProductAdmin(actorUserId, "masterclass"))) {
    throw new ForbiddenError(`${actorUserId} is not an ADMIN for product masterclass`);
  }
  const vendor = await deps.createVendor(input);
  log.info("vendor_created", { vendorId: vendor.id });
  return vendor;
}

// ── provisionVendorUser — the `sso()` plugin's `provisionUser` body ────────────

export type ProvisionVendorUserInput = {
  userId: string;
  email: string;
  ssoProviderId: string;
};

export type ProvisionVendorUserDeps = {
  getVendorBySsoProviderId: (ssoProviderId: string) => Promise<VendorRow | null>;
  createVerifiedIdentity: typeof dbCreateVerifiedIdentity;
  grantAccess: typeof dbGrantAccess;
};

const defaultProvisionVendorUserDeps: ProvisionVendorUserDeps = {
  getVendorBySsoProviderId: dbGetVendorBySsoProviderId,
  createVerifiedIdentity: dbCreateVerifiedIdentity,
  grantAccess: dbGrantAccess,
};

/**
 * JIT-provisions a vendor employee on their first federated sign-in. Fails
 * closed (throws, granting nothing) for: an unknown or non-active vendor
 * (pending/disabled — defense in depth alongside Better Auth's own
 * `domainVerification` gate and the ssoProvider deletion on disable), and an
 * asserted email whose domain isn't one the vendor proved ownership of —
 * Better Auth's own domain check only affects account-linking trust, it does
 * not block a *new* user being created for an out-of-domain email.
 *
 * Grants EXACTLY `product_id: "masterclass"`, `role: "VENDOR"` — hardcoded,
 * never derived from any vendor- or IdP-supplied field, so there is no path
 * from a vendor assertion to LMS, Miles One, or ADMIN access (security.md).
 */
export async function provisionVendorUser(
  input: ProvisionVendorUserInput,
  deps: ProvisionVendorUserDeps = defaultProvisionVendorUserDeps,
): Promise<void> {
  const vendor = await deps.getVendorBySsoProviderId(input.ssoProviderId);
  if (!vendor || vendor.status !== "active") {
    throw new ForbiddenError(`sso provider ${input.ssoProviderId} has no active vendor`);
  }

  const email = normaliseEmail(input.email);
  const domain = email.split("@")[1];
  if (!domain || !vendor.allowed_email_domains.includes(domain)) {
    throw new ForbiddenError(`email domain not allowed for vendor ${vendor.id}`);
  }

  await deps.createVerifiedIdentity({ userId: input.userId, type: "email", value: email, source: "masterclass" });
  await deps.grantAccess({
    userId: input.userId,
    productId: "masterclass",
    role: "VENDOR",
    vendorId: vendor.id,
    grantedBy: SYSTEM_ACTOR,
  });

  log.info("vendor_user_provisioned", { userId: input.userId, vendorId: vendor.id });
}
