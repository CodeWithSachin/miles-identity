/**
 * `syncOAuthClients` against real Postgres, per .agents/skills/testing-and-checks.md.
 * The property under test is idempotency and secret handling — not "some rows appeared."
 *
 * Runs the real sync function from src/db/seed-oauth-clients.ts against the
 * disposable-schema harness, reached through a throwaway `betterAuth()` instance
 * pointed at that schema's search_path — the one sanctioned exception to "one
 * instance" (.agents/skills/better-auth.md): it is never mounted as a request
 * handler, so there is still only one *live* session store in the running process.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { Pool } from "pg";
import { createTestSchema, dropTestSchema, testDatabaseUrl, type TestDatabase } from "../helpers/database";
import { syncOAuthClients } from "@/db/seed-oauth-clients";
import type { TrustedClientDefinition } from "@/auth/oauth-clients";

let db: TestDatabase;

const hasher = {
  hash: (s: string): Promise<string> => Bun.password.hash(s),
  verify: (s: string, h: string): Promise<boolean> => Bun.password.verify(s, h),
};

async function contextForSchema() {
  const pool = new Pool({ connectionString: testDatabaseUrl() });
  pool.on("connect", (client) => {
    client.query(`SET search_path TO "${db.schema}"`);
  });

  // jwt()/oauthProvider() registered so the adapter knows the oauthClient model —
  // otherwise `ctx.adapter` has no schema entry to resolve "oauthClient" against.
  const auth = betterAuth({
    database: pool,
    baseURL: "http://localhost:3000",
    secret: "test-secret-not-real-0000000000000000",
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwks: { keyPairConfig: { alg: "RS256" } } }),
      oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" }),
    ],
  });

  return auth.$context;
}

beforeAll(async () => {
  db = await createTestSchema();
});

afterAll(async () => {
  await dropTestSchema(db);
});

const LMS_WEB: TrustedClientDefinition = {
  clientId: "lms-web",
  type: "web",
  redirectUris: ["https://lms.example.com/callback"],
  clientSecret: "lms-secret",
};

const MILES_ONE_APP: TrustedClientDefinition = {
  clientId: "miles-one-app",
  type: "native",
  redirectUris: ["com.miles.one://oauth/callback"],
  clientSecret: undefined,
};

describe("syncOAuthClients", () => {
  test("creates exactly one row per trusted client, and is idempotent on rerun", async () => {
    const ctx = await contextForSchema();
    const clients = [LMS_WEB, MILES_ONE_APP];

    const first = await syncOAuthClients(ctx.adapter, hasher, clients);
    expect(first).toEqual({ created: 2, updated: 0 });

    const second = await syncOAuthClients(ctx.adapter, hasher, clients);
    expect(second).toEqual({ created: 0, updated: 2 });

    const rows = await ctx.adapter.findMany<{ clientId: string; clientSecret?: string; public: boolean }>({
      model: "oauthClient",
      where: [],
    });
    expect(rows.filter((r) => r.clientId === "lms-web")).toHaveLength(1);
    expect(rows.filter((r) => r.clientId === "miles-one-app")).toHaveLength(1);

    const lms = rows.find((r) => r.clientId === "lms-web")!;
    expect(lms.clientSecret).toBeDefined();
    expect(lms.clientSecret).not.toBe("lms-secret");
    expect(await hasher.verify("lms-secret", lms.clientSecret!)).toBe(true);

    const milesOne = rows.find((r) => r.clientId === "miles-one-app")!;
    expect(milesOne.public).toBe(true);
    expect(milesOne.clientSecret ?? null).toBeNull();
  });

  test("re-running sync never overwrites an existing clientSecret", async () => {
    const ctx = await contextForSchema();

    await syncOAuthClients(ctx.adapter, hasher, [
      { ...LMS_WEB, clientId: "masterclass-web", clientSecret: "original-secret" },
    ]);
    const before = await ctx.adapter.findOne<{ clientSecret: string }>({
      model: "oauthClient",
      where: [{ field: "clientId", value: "masterclass-web" }],
    });

    // Rerun with a changed redirect URI but the SAME logical client secret — sync
    // must not re-derive or replace the stored hash.
    await syncOAuthClients(ctx.adapter, hasher, [
      {
        clientId: "masterclass-web",
        type: "web",
        redirectUris: ["https://masterclass.example.com/callback", "https://masterclass.example.com/other"],
        clientSecret: "original-secret",
      },
    ]);

    const after = await ctx.adapter.findOne<{ clientSecret: string; redirectUris: string[] }>({
      model: "oauthClient",
      where: [{ field: "clientId", value: "masterclass-web" }],
    });
    expect(after?.clientSecret).toBe(before!.clientSecret);
    expect(after?.redirectUris).toHaveLength(2);
  });
});
