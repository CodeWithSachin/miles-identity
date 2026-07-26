/**
 * Pure definitions in src/auth/oauth-clients.ts — no DB, no Better Auth import.
 * Consumed by src/db/seed-oauth-clients.ts; covered here in isolation so a typo
 * in a client id, redirect URL, or public/confidential shape fails fast without
 * needing Postgres. See tests/db/seed-oauth-clients.test.ts for the write path.
 */

import { test, expect, describe } from "bun:test";
import { resetConfigCache } from "@/lib/config";

const REQUIRED: Record<string, string> = {
  TZ: "UTC",
  BASE_URL: "http://localhost:3000",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-secret-not-real-0000000000000000",
  DATABASE_URL: "postgres://postgres@127.0.0.1:5432/postgres",
  REDIS_URL: "redis://127.0.0.1:6379",
  LMS_WEB_CLIENT_SECRET: "lms-web-secret",
  MASTERCLASS_WEB_CLIENT_SECRET: "masterclass-web-secret",
  LMS_WEB_REDIRECT_URLS: "https://lms.example.com/callback, https://lms.example.com/other",
  MASTERCLASS_WEB_REDIRECT_URLS: "https://masterclass.example.com/callback",
  MILES_ONE_APP_REDIRECT_URL: "com.miles.one://oauth/callback",
  MASTERCLASS_APP_REDIRECT_URL: "com.miles.masterclass://oauth/callback",
};

const savedEnv: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(REQUIRED)) {
  savedEnv[key] = Bun.env[key];
  Bun.env[key] = value;
}
resetConfigCache();

const { trustedClients } = await import("@/auth/oauth-clients");
const clients = trustedClients();

for (const [key, previous] of Object.entries(savedEnv)) {
  if (previous === undefined) delete Bun.env[key];
  else Bun.env[key] = previous;
}
resetConfigCache();

describe("trustedClients", () => {
  test("defines exactly the four first-party clients", () => {
    expect(clients.map((c) => c.clientId).sort()).toEqual([
      "lms-web",
      "masterclass-app",
      "masterclass-web",
      "miles-one-app",
    ]);
  });

  test("web clients are confidential with a secret and their configured redirect URIs", () => {
    const lms = clients.find((c) => c.clientId === "lms-web")!;
    expect(lms.type).toBe("web");
    expect(lms.clientSecret).toBe("lms-web-secret");
    expect(lms.redirectUris).toEqual([
      "https://lms.example.com/callback",
      "https://lms.example.com/other",
    ]);

    const masterclassWeb = clients.find((c) => c.clientId === "masterclass-web")!;
    expect(masterclassWeb.type).toBe("web");
    expect(masterclassWeb.redirectUris).toEqual(["https://masterclass.example.com/callback"]);
  });

  // Native/public clients hold no secret — PKCE only.
  test("native clients are public: no clientSecret", () => {
    const milesOne = clients.find((c) => c.clientId === "miles-one-app")!;
    expect(milesOne.type).toBe("native");
    expect(milesOne.clientSecret).toBeUndefined();
    expect(milesOne.redirectUris).toEqual(["com.miles.one://oauth/callback"]);

    const masterclassApp = clients.find((c) => c.clientId === "masterclass-app")!;
    expect(masterclassApp.type).toBe("native");
    expect(masterclassApp.clientSecret).toBeUndefined();
  });
});
