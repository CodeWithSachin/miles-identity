/**
 * /api/admin/vendors* — vendor lifecycle for inbound SSO (roadmap step 11;
 * prompts/011; .agents/skills/security.md). Every handler performs its own
 * explicit authorization check (ADMIN for `masterclass`) inside the service
 * layer — there is no middleware and no implicit default, mirroring
 * src/routes/admin/access.ts.
 *
 * ponytail: role-check only, no 2FA gate here — same pre-existing gap noted in
 * routes/admin/access.ts (the `twoFactor` plugin isn't mounted yet).
 */

import { z } from "zod";
import { auth } from "@/auth";
import {
  createVendor,
  disableVendor,
  registerVendorSsoProvider,
  verifyVendorDomain,
  type RegisterProviderInput,
} from "@/services/vendor-sso";
import { ForbiddenError, IntegrationError, NotFoundError, ValidationError } from "@/lib/errors";
import type { VendorRow } from "@/db/types";

const NO_STORE = { "cache-control": "no-store" } as const;

// Exported: the same objects the Scalar spec derives from (src/routes/docs.ts) —
// one definition, not a parallel one. See .agents/skills/scalar-api-docs.md.
export const createVendorBodySchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
});

const oidcConfigSchema = z.record(z.string(), z.unknown());
const samlConfigSchema = z.record(z.string(), z.unknown());

export const registerProviderBodySchema = z
  .object({
    issuer: z.string().min(1),
    oidcConfig: oidcConfigSchema.optional(),
    samlConfig: samlConfigSchema.optional(),
  })
  .refine((body) => (body.oidcConfig !== undefined) !== (body.samlConfig !== undefined), {
    message: "exactly one of oidcConfig or samlConfig is required",
  });

export const vendorResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  sso_provider_id: z.string().nullable(),
  allowed_email_domains: z.array(z.string()),
  domain_verified_at: z.string().nullable(),
  status: z.enum(["pending", "active", "disabled"]),
});

export const registerProviderResponseSchema = z.object({
  provider_id: z.string(),
  dns_record_host: z.string(),
  dns_record_value: z.string(),
});

/** A session lookup, injectable so route tests don't need a live Better Auth session store. */
export type SessionResolver = (req: Request) => Promise<{ userId: string } | null>;

const defaultSessionResolver: SessionResolver = async (req) => {
  const session = await auth.api.getSession({ headers: req.headers });
  return session ? { userId: session.user.id } : null;
};

/** Injectable so route tests exercise status-code mapping without a live database. */
export type VendorServices = {
  createVendor: typeof createVendor;
  registerVendorSsoProvider: typeof registerVendorSsoProvider;
  verifyVendorDomain: typeof verifyVendorDomain;
  disableVendor: typeof disableVendor;
};

const defaultServices: VendorServices = {
  createVendor,
  registerVendorSsoProvider,
  verifyVendorDomain,
  disableVendor,
};

function vendorResponseBody(row: VendorRow): z.infer<typeof vendorResponseSchema> {
  return vendorResponseSchema.parse({
    id: row.id,
    name: row.name,
    sso_provider_id: row.sso_provider_id,
    allowed_email_domains: row.allowed_email_domains,
    domain_verified_at: row.domain_verified_at ? row.domain_verified_at.toISOString() : null,
    status: row.status,
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ForbiddenError) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  if (error instanceof NotFoundError) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  if (error instanceof ValidationError) return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  if (error instanceof IntegrationError) return Response.json({ error: "domain_verification_failed" }, { status: 502, headers: NO_STORE });
  throw error;
}

async function requireSession(req: Request, getSession: SessionResolver): Promise<{ userId: string } | Response> {
  const session = await getSession(req);
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
  return session;
}

export async function createVendorRoute(
  req: Request,
  getSession: SessionResolver = defaultSessionResolver,
  services: VendorServices = defaultServices,
): Promise<Response> {
  const session = await requireSession(req, getSession);
  if (session instanceof Response) return session;

  const body = createVendorBodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  try {
    const vendor = await services.createVendor(session.userId, body.data);
    return Response.json(vendorResponseBody(vendor), { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function registerVendorSsoProviderRoute(
  req: Request,
  vendorId: string,
  getSession: SessionResolver = defaultSessionResolver,
  services: VendorServices = defaultServices,
): Promise<Response> {
  const session = await requireSession(req, getSession);
  if (session instanceof Response) return session;

  const body = registerProviderBodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  try {
    // The zod schema above only validates shape loosely (`z.record`) for Scalar
    // documentation purposes — the deeper field-by-field validation (clientId,
    // clientSecret, entryPoint, cert, ... required per config kind) is Better
    // Auth's own `registerSSOProvider` schema, which throws a typed error the
    // service maps to a 400/404/502 if the config is actually malformed.
    const input = { vendorId, ...body.data } as unknown as RegisterProviderInput;
    const result = await services.registerVendorSsoProvider(session.userId, input);
    return Response.json(
      registerProviderResponseSchema.parse({
        provider_id: result.providerId,
        dns_record_host: result.dnsRecordHost,
        dns_record_value: result.dnsRecordValue,
      }),
      { headers: NO_STORE },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function verifyVendorDomainRoute(
  req: Request,
  vendorId: string,
  getSession: SessionResolver = defaultSessionResolver,
  services: VendorServices = defaultServices,
): Promise<Response> {
  const session = await requireSession(req, getSession);
  if (session instanceof Response) return session;

  try {
    const vendor = await services.verifyVendorDomain(session.userId, vendorId);
    return Response.json(vendorResponseBody(vendor), { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function disableVendorRoute(
  req: Request,
  vendorId: string,
  getSession: SessionResolver = defaultSessionResolver,
  services: VendorServices = defaultServices,
): Promise<Response> {
  const session = await requireSession(req, getSession);
  if (session instanceof Response) return session;

  try {
    const vendor = await services.disableVendor(session.userId, vendorId);
    return Response.json(vendorResponseBody(vendor), { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
