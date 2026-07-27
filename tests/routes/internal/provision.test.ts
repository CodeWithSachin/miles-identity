/**
 * `/api/internal/provision` — signature verification and request shaping
 * (prompts/013; .agents/skills/security.md). The service itself is exercised
 * through injected fakes so this file only proves the HTTP-boundary
 * behaviour: unsigned/stale/tampered requests never reach the service, and a
 * valid request maps to the right status code.
 *
 * `bun test` runs with NODE_ENV=test and does not auto-load `.env.local` —
 * this file supplies `INTERNAL_WEBHOOK_SIGNING_SECRET` directly, mirroring
 * tests/integrations/otp-senders.test.ts.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { provisionRoute, verifyInternalSignature, type ProvisionServices } from "@/routes/internal/provision";
import { resetConfigCache } from "@/lib/config";
import { ValidationError } from "@/lib/errors";

const SECRET = "internal-webhook-secret-at-least-32-chars-long";

const REQUIRED: Record<string, string> = {
  TZ: "UTC",
  BASE_URL: "http://localhost:3000",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-secret-not-real-0000000000000000",
  DATABASE_URL: "postgres://postgres@127.0.0.1:5432/postgres",
  REDIS_URL: "redis://127.0.0.1:6379",
  INTERNAL_WEBHOOK_SIGNING_SECRET: SECRET,
};

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries(REQUIRED)) {
    saved[key] = Bun.env[key];
    Bun.env[key] = value;
  }
  resetConfigCache();
});

afterAll(() => {
  for (const [key, previous] of Object.entries(saved)) {
    if (previous === undefined) delete Bun.env[key];
    else Bun.env[key] = previous;
  }
  resetConfigCache();
});

function sign(timestamp: number, body: string, secret: string = SECRET): string {
  return new Bun.CryptoHasher("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

const VALID_BODY = JSON.stringify({
  contactId: "003xx0000000001",
  email: "lead@example.com",
  firstName: "Lead",
  products: ["masterclass"],
});

function request(body: string, headers: Record<string, string>): Request {
  return new Request("http://localhost/api/internal/provision", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("verifyInternalSignature", () => {
  test("accepts a fresh, correctly-signed request", () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyInternalSignature(VALID_BODY, String(ts), sign(ts, VALID_BODY), SECRET)).toBe(true);
  });

  test("negative: missing signature header", () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyInternalSignature(VALID_BODY, String(ts), null, SECRET)).toBe(false);
  });

  test("negative: tampered body invalidates the signature", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(ts, VALID_BODY);
    expect(verifyInternalSignature(VALID_BODY + "x", String(ts), sig, SECRET)).toBe(false);
  });

  test("negative: a timestamp older than the skew window is rejected even with a matching signature", () => {
    const staleTs = Math.floor(Date.now() / 1000) - 301;
    expect(verifyInternalSignature(VALID_BODY, String(staleTs), sign(staleTs, VALID_BODY), SECRET)).toBe(false);
  });

  test("negative: wrong secret", () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyInternalSignature(VALID_BODY, String(ts), sign(ts, VALID_BODY, "wrong-secret"), SECRET)).toBe(false);
  });
});

describe("provisionRoute", () => {
  function services(overrides: Partial<ProvisionServices> = {}): ProvisionServices {
    return {
      provisionFromSalesforce: mock(async () => ({ userId: "usr_1" })),
      ...overrides,
    };
  }

  test("valid signature + valid body → 200 with the userId", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const req = request(VALID_BODY, { "x-timestamp": String(ts), "x-signature": sign(ts, VALID_BODY) });

    const res = await provisionRoute(req, services());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "usr_1" });
  });

  test("negative: missing x-signature → 401, service never called", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const deps = services();
    const req = request(VALID_BODY, { "x-timestamp": String(ts) });

    const res = await provisionRoute(req, deps);

    expect(res.status).toBe(401);
    expect(deps.provisionFromSalesforce).not.toHaveBeenCalled();
  });

  test("negative: wrong signature → 401", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const req = request(VALID_BODY, { "x-timestamp": String(ts), "x-signature": "0".repeat(64) });

    const res = await provisionRoute(req, services());

    expect(res.status).toBe(401);
  });

  test("negative: invalid body (products contains a non-ProductId value) → 400", async () => {
    const body = JSON.stringify({
      contactId: "003xx0000000001",
      email: "lead@example.com",
      firstName: "Lead",
      products: ["ADMIN"],
    });
    const ts = Math.floor(Date.now() / 1000);
    const deps = services();
    const req = request(body, { "x-timestamp": String(ts), "x-signature": sign(ts, body) });

    const res = await provisionRoute(req, deps);

    expect(res.status).toBe(400);
    expect(deps.provisionFromSalesforce).not.toHaveBeenCalled();
  });

  test("negative: missing contactId → 400", async () => {
    const body = JSON.stringify({ email: "lead@example.com", firstName: "Lead", products: [] });
    const ts = Math.floor(Date.now() / 1000);
    const req = request(body, { "x-timestamp": String(ts), "x-signature": sign(ts, body) });

    const res = await provisionRoute(req, services());

    expect(res.status).toBe(400);
  });

  test("a ValidationError from the service maps to 400", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const deps = services({
      provisionFromSalesforce: mock(async () => {
        throw new ValidationError("conflicting Salesforce contact link");
      }),
    });
    const req = request(VALID_BODY, { "x-timestamp": String(ts), "x-signature": sign(ts, VALID_BODY) });

    const res = await provisionRoute(req, deps);

    expect(res.status).toBe(400);
  });
});
