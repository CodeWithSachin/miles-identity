/**
 * POST /api/admin/access — status-code mapping, driven through an injected
 * SessionResolver and injected service functions so this suite needs neither a
 * live Better Auth session store nor a database. The service logic itself is
 * proven in tests/services/access.test.ts; the SQL in tests/db/access.test.ts.
 */

import { test, expect, describe, mock } from "bun:test";
import { adminAccessRoute, type AccessServices, type SessionResolver } from "@/routes/admin/access";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import type { UserProductAccessRow } from "@/db/types";

const ROW: UserProductAccessRow = {
  id: "acc_1",
  user_id: "usr_target",
  product_id: "lms",
  role: "CPA",
  vendor_id: null,
  status: "active",
  granted_by: "usr_admin",
  granted_at: new Date("2026-01-01T00:00:00.000Z"),
  revoked_at: null,
};

function services(overrides: Partial<AccessServices> = {}): AccessServices {
  return {
    grantProductAccess: mock(async () => ROW),
    revokeProductAccess: mock(async () => ({ ...ROW, status: "revoked" as const, revoked_at: new Date("2026-01-02T00:00:00.000Z") })),
    ...overrides,
  };
}

const authedSession: SessionResolver = async () => ({ userId: "usr_admin" });
const noSession: SessionResolver = async () => null;

function post(body: unknown, getSession = authedSession, svc = services()): Promise<Response> {
  const req = new Request("http://localhost/api/admin/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return adminAccessRoute(req, getSession, svc);
}

describe("POST /api/admin/access", () => {
  test("401s with no session", async () => {
    const res = await post({ action: "grant", user_id: "usr_target", product_id: "lms", role: "CPA" }, noSession);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  test("400s on a malformed body", async () => {
    const res = await post({ action: "grant", user_id: "usr_target", product_id: "not_a_product", role: "CPA" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  // A VENDOR role without vendor_id passes the zod schema (vendor_id is optional
  // there) — the domain rule lives in the service (ck_access_vendor_scope's
  // application-layer mirror), so its ValidationError must still map to 400.
  test("400s when the service rejects a role/vendor_id mismatch", async () => {
    const svc = services({ grantProductAccess: mock(async () => { throw new ValidationError("needs vendor_id"); }) });
    const res = await post({ action: "grant", user_id: "usr_target", product_id: "masterclass", role: "VENDOR" }, authedSession, svc);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  test("403s when the service reports the actor is not admin for this product", async () => {
    const svc = services({ grantProductAccess: mock(async () => { throw new ForbiddenError("nope"); }) });
    const res = await post({ action: "grant", user_id: "usr_target", product_id: "lms", role: "CPA" }, authedSession, svc);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("404s when the service reports the target or row is not found", async () => {
    const svc = services({ revokeProductAccess: mock(async () => { throw new NotFoundError("nope"); }) });
    const res = await post({ action: "revoke", user_id: "usr_target", product_id: "lms", role: "CPA" }, authedSession, svc);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("200s on a successful grant, with cache-control: no-store", async () => {
    const res = await post({ action: "grant", user_id: "usr_target", product_id: "lms", role: "CPA" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      id: "acc_1",
      user_id: "usr_target",
      product_id: "lms",
      role: "CPA",
      vendor_id: null,
      status: "active",
      granted_by: "usr_admin",
      granted_at: "2026-01-01T00:00:00.000Z",
      revoked_at: null,
    });
  });

  test("200s on a successful revoke", async () => {
    const res = await post({ action: "revoke", user_id: "usr_target", product_id: "lms", role: "CPA" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; revoked_at: string | null };
    expect(body.status).toBe("revoked");
    expect(body.revoked_at).toBe("2026-01-02T00:00:00.000Z");
  });
});
