/**
 * /api/admin/vendors* — status-code mapping, driven through an injected
 * SessionResolver and injected service functions so this suite needs neither a
 * live Better Auth session store nor a database (same style as
 * tests/routes/admin/access.test.ts). The service logic itself is proven in
 * tests/services/vendor-sso.test.ts; the SQL in tests/db/vendor.test.ts.
 */

import { test, expect, describe, mock } from "bun:test";
import {
  createVendorRoute,
  disableVendorRoute,
  registerVendorSsoProviderRoute,
  verifyVendorDomainRoute,
  type SessionResolver,
  type VendorServices,
} from "@/routes/admin/vendors";
import { ForbiddenError, IntegrationError, NotFoundError, ValidationError } from "@/lib/errors";
import type { VendorRow } from "@/db/types";

const VENDOR_ID = "vnd_1";

const ROW: VendorRow = {
  id: VENDOR_ID,
  name: "Acme Prep",
  sso_provider_id: "ssp_1",
  allowed_email_domains: ["acmeprep.example"],
  domain_verified_at: null,
  status: "pending",
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
};

function services(overrides: Partial<VendorServices> = {}): VendorServices {
  return {
    createVendor: mock(async () => ROW),
    registerVendorSsoProvider: mock(async () => ({
      providerId: "ssp_1",
      domainVerificationToken: "token-abc",
      dnsRecordHost: "_better-auth-token.acmeprep.example",
      dnsRecordValue: "token-abc",
    })),
    verifyVendorDomain: mock(async () => ({ ...ROW, status: "active" as const, domain_verified_at: new Date("2026-01-02T00:00:00.000Z") })),
    disableVendor: mock(async () => ({ ...ROW, status: "disabled" as const, sso_provider_id: null })),
    ...overrides,
  };
}

const authedSession: SessionResolver = async () => ({ userId: "usr_admin" });
const noSession: SessionResolver = async () => null;

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/vendors", () => {
  test("401s with no session", async () => {
    const res = await createVendorRoute(post("/api/admin/vendors", { name: "Acme Prep", domain: "acmeprep.example" }), noSession);
    expect(res.status).toBe(401);
  });

  test("400s on a malformed body", async () => {
    const res = await createVendorRoute(post("/api/admin/vendors", { name: "" }), authedSession);
    expect(res.status).toBe(400);
  });

  test("403s when the service reports the actor is not admin for masterclass", async () => {
    const svc = services({ createVendor: mock(async () => { throw new ForbiddenError("nope"); }) });
    const res = await createVendorRoute(
      post("/api/admin/vendors", { name: "Acme Prep", domain: "acmeprep.example" }),
      authedSession,
      svc,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("200s on success, with cache-control: no-store", async () => {
    const res = await createVendorRoute(
      post("/api/admin/vendors", { name: "Acme Prep", domain: "acmeprep.example" }),
      authedSession,
      services(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ id: VENDOR_ID, status: "pending" });
  });
});

describe("POST /api/admin/vendors/:vendorId/sso-provider", () => {
  test("401s with no session", async () => {
    const res = await registerVendorSsoProviderRoute(
      post("/api/admin/vendors/vnd_1/sso-provider", { issuer: "https://idp.example", oidcConfig: {} }),
      VENDOR_ID,
      noSession,
    );
    expect(res.status).toBe(401);
  });

  test("400s when neither oidcConfig nor samlConfig is supplied", async () => {
    const res = await registerVendorSsoProviderRoute(
      post("/api/admin/vendors/vnd_1/sso-provider", { issuer: "https://idp.example" }),
      VENDOR_ID,
      authedSession,
    );
    expect(res.status).toBe(400);
  });

  test("404s when the service reports the vendor is not found", async () => {
    const svc = services({ registerVendorSsoProvider: mock(async () => { throw new NotFoundError("nope"); }) });
    const res = await registerVendorSsoProviderRoute(
      post("/api/admin/vendors/vnd_missing/sso-provider", { issuer: "https://idp.example", oidcConfig: {} }),
      "vnd_missing",
      authedSession,
      svc,
    );
    expect(res.status).toBe(404);
  });

  test("200s with DNS TXT instructions on success", async () => {
    const res = await registerVendorSsoProviderRoute(
      post("/api/admin/vendors/vnd_1/sso-provider", { issuer: "https://idp.example", oidcConfig: { clientId: "x", clientSecret: "y" } }),
      VENDOR_ID,
      authedSession,
      services(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider_id: "ssp_1",
      dns_record_host: "_better-auth-token.acmeprep.example",
      dns_record_value: "token-abc",
    });
  });
});

describe("POST /api/admin/vendors/:vendorId/verify-domain", () => {
  test("401s with no session", async () => {
    const res = await verifyVendorDomainRoute(post("/api/admin/vendors/vnd_1/verify-domain", {}), VENDOR_ID, noSession);
    expect(res.status).toBe(401);
  });

  test("502s when the service reports the DNS lookup failed", async () => {
    const svc = services({ verifyVendorDomain: mock(async () => { throw new IntegrationError("better-auth-sso", "lookup failed"); }) });
    const res = await verifyVendorDomainRoute(post("/api/admin/vendors/vnd_1/verify-domain", {}), VENDOR_ID, authedSession, svc);
    expect(res.status).toBe(502);
  });

  test("400s when the service reports no provider registered", async () => {
    const svc = services({ verifyVendorDomain: mock(async () => { throw new ValidationError("no provider"); }) });
    const res = await verifyVendorDomainRoute(post("/api/admin/vendors/vnd_1/verify-domain", {}), VENDOR_ID, authedSession, svc);
    expect(res.status).toBe(400);
  });

  test("200s with the activated vendor on success", async () => {
    const res = await verifyVendorDomainRoute(post("/api/admin/vendors/vnd_1/verify-domain", {}), VENDOR_ID, authedSession, services());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("active");
  });
});

describe("POST /api/admin/vendors/:vendorId/disable", () => {
  test("401s with no session", async () => {
    const res = await disableVendorRoute(post("/api/admin/vendors/vnd_1/disable", {}), VENDOR_ID, noSession);
    expect(res.status).toBe(401);
  });

  test("404s when the service reports the vendor is not found", async () => {
    const svc = services({ disableVendor: mock(async () => { throw new NotFoundError("nope"); }) });
    const res = await disableVendorRoute(post("/api/admin/vendors/vnd_1/disable", {}), VENDOR_ID, authedSession, svc);
    expect(res.status).toBe(404);
  });

  test("200s with the disabled vendor on success", async () => {
    const res = await disableVendorRoute(post("/api/admin/vendors/vnd_1/disable", {}), VENDOR_ID, authedSession, services());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; sso_provider_id: string | null };
    expect(body.status).toBe("disabled");
    expect(body.sso_provider_id).toBeNull();
  });
});
