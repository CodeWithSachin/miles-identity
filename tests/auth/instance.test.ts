/**
 * The Better Auth core instance.
 *
 * These tests assert the security-relevant WIRING without standing up a database,
 * Redis, or the HTTP layer — importing `@/auth` connects nothing (the pg Pool and
 * the Redis client are both lazy). That keeps the suite fast and keeps this file
 * from touching the shared datastore singletons the readiness probes in
 * tests/{routes,services}/health depend on.
 *
 * The guarantee that matters: passwords are hashed with argon2id via Bun.password,
 * NOT Better Auth's built-in scrypt — proven at the hasher itself and at the exact
 * object the instance is configured with. The negative half (a wrong password does
 * not verify) is the auth guarantee the testing skill requires.
 *
 * `bun test` runs with NODE_ENV=test, and Bun deliberately does not auto-load
 * `.env.local` in that mode. So this file provides the config `@/auth` needs, imports
 * it (config memoises on first read), then RESTORES the environment — leaving
 * DATABASE_URL/REDIS_URL exactly as the health suites expect to find them.
 */

import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// ── provide config, import, restore env ───────────────────────────────────────

function readEnvLocal(): Record<string, string> {
  const parsed: Record<string, string> = {};
  const file = new URL("../../.env.local", import.meta.url).pathname;
  if (!existsSync(file)) return parsed;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    const key = match?.[1];
    if (key === undefined) continue;
    let value = match?.[2] ?? "";
    const comment = value.search(/\s#/);
    if (comment >= 0) value = value.slice(0, comment);
    parsed[key] = value.trim().replace(/^["']|["']$/g, "");
  }
  return parsed;
}

const envLocal = readEnvLocal();
// Test-safe fallbacks when there is no .env.local (CI). These values are never
// connected to — this file only inspects config — so a dummy secret is fine.
const REQUIRED: Record<string, string> = {
  TZ: "UTC",
  BASE_URL: envLocal.BASE_URL ?? "http://localhost:3000",
  BETTER_AUTH_URL: envLocal.BETTER_AUTH_URL ?? "http://localhost:3000",
  BETTER_AUTH_SECRET: envLocal.BETTER_AUTH_SECRET ?? "test-secret-not-real-0000000000000000",
  DATABASE_URL: envLocal.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres",
  REDIS_URL: envLocal.REDIS_URL ?? "redis://127.0.0.1:6379",
};

const savedEnv: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(REQUIRED)) {
  savedEnv[key] = Bun.env[key];
  if (Bun.env[key] === undefined || Bun.env[key] === "") Bun.env[key] = value;
}

const {
  auth,
  passwordHasher,
  oauthClientSecretHasher,
} = await import("@/auth"); // getConfig memoises here

for (const [key, previous] of Object.entries(savedEnv)) {
  if (previous === undefined) delete Bun.env[key];
  else Bun.env[key] = previous;
}

// ── tests ─────────────────────────────────────────────────────────────────────

const PW = "correct horse battery staple";

describe("passwordHasher", () => {
  test("hashes with argon2id, never plaintext", async () => {
    const hash = await passwordHasher.hash(PW);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain(PW);
  });

  test("verifies the correct password", async () => {
    const hash = await passwordHasher.hash(PW);
    expect(await passwordHasher.verify({ password: PW, hash })).toBe(true);
  });

  // The negative half: a wrong password must not verify.
  test("rejects a wrong password", async () => {
    const hash = await passwordHasher.hash(PW);
    expect(await passwordHasher.verify({ password: "wrong password", hash })).toBe(false);
  });
});

describe("auth instance wiring", () => {
  test("enables email + password", () => {
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
  });

  // The exact hasher Better Auth will call on sign-up. Proves it produces argon2id,
  // so the stored hash is argon2id and never Better Auth's default scrypt.
  test("hashes through argon2id, not Better Auth's default", async () => {
    const hasher = auth.options.emailAndPassword?.password;
    expect(hasher).toBeDefined();

    const hash = await hasher!.hash(PW);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await hasher!.verify({ password: PW, hash })).toBe(true);
    expect(await hasher!.verify({ password: "nope", hash })).toBe(false);
  });

  // All three are server-controlled: a client must never set them.
  test("declares the three server-controlled additional fields as input:false", () => {
    const fields = auth.options.user?.additionalFields;
    expect(fields?.salesforceContactId?.input).toBe(false);
    expect(fields?.status?.input).toBe(false);
    expect(fields?.mergedIntoUserId?.input).toBe(false);
  });

  test("maps the additional fields to the snake_case data-model columns", () => {
    const fields = auth.options.user?.additionalFields;
    expect(fields?.salesforceContactId?.fieldName).toBe("salesforce_contact_id");
    expect(fields?.mergedIntoUserId?.fieldName).toBe("merged_into_user_id");
    expect(fields?.salesforceContactId?.unique).toBe(true);
  });

  // Step 9 (prompts/009): server-controlled, mirrors the other additionalFields.
  test("declares importedHashAlgo as input:false, mapped to imported_hash_algo", () => {
    const fields = auth.options.user?.additionalFields;
    expect(fields?.importedHashAlgo?.input).toBe(false);
    expect(fields?.importedHashAlgo?.fieldName).toBe("imported_hash_algo");
  });

  // The rehash-on-login hook (src/services/legacy-rehash.ts) is wired in.
  test("registers an after hook for the legacy-password rehash", () => {
    expect(typeof auth.options.hooks?.after).toBe("function");
  });

  // Postgres is the source of truth so revocation is deleting a row — instant.
  test("stores sessions in the database", () => {
    expect(auth.options.session?.storeSessionInDatabase).toBe(true);
  });

  test("exposes a single request handler to mount at /api/auth/*", () => {
    expect(typeof auth.handler).toBe("function");
  });
});

// Plugin instances aren't individually typed on auth.options.plugins; narrow by id
// and read back the raw options object each plugin factory stores at `.options`.
function findPlugin(id: string): { options: Record<string, any> } {
  const plugins = auth.options.plugins as unknown as { id: string; options: Record<string, any> }[] | undefined;
  const plugin = plugins?.find((p) => p.id === id);
  if (!plugin) throw new Error(`plugin not found: ${id}`);
  return plugin;
}

describe("oauth provider wiring", () => {
  test("registers jwt and oauth-provider plugins", () => {
    expect(findPlugin("jwt")).toBeDefined();
    expect(findPlugin("oauth-provider")).toBeDefined();
  });

  // The OAuth equivalent of Better Auth's own /token is /oauth2/token.
  test("disables Better Auth's own /token path", () => {
    expect(auth.options.disabledPaths).toContain("/token");
  });

  test("overrides the library's 1h default access token TTL with the config value", () => {
    const opts = findPlugin("oauth-provider").options;
    expect(opts.accessTokenExpiresIn).toBe(900);
    expect(opts.accessTokenExpiresIn).toBeLessThanOrEqual(900);
  });

  // GHSA-p2fr-6hmx-4528: a single-entry validAudiences is the documented workaround
  // for the 1.6.x resource-indicator/audience-binding gap (accepted risk, see
  // package.json's audit script and the comment on this option in auth.ts).
  test("pins validAudiences to exactly one audience", () => {
    const opts = findPlugin("oauth-provider").options;
    expect(opts.validAudiences).toEqual(["http://localhost:3000"]);
  });

  // RS256 per docs/architecture-plan.md §3.3 — the library default is EdDSA.
  test("signs JWTs with RS256, not the library default", () => {
    const opts = findPlugin("jwt").options;
    expect(opts.jwks?.keyPairConfig?.alg).toBe("RS256");
  });

  test("disables setting a JWT session header, as recommended alongside an OAuth provider", () => {
    expect(findPlugin("jwt").options.disableSettingJwtHeader).toBe(true);
  });

  // Every product must resolve the same usr_ id — pairwise subjects break that.
  test("never sets pairwiseSecret", () => {
    expect(findPlugin("oauth-provider").options.pairwiseSecret).toBeUndefined();
  });

  // Step 7 (RBAC) wires in buildAccessTokenClaims (src/services/access.ts), which
  // reads user_product_access for the `products` claim — full coverage of that
  // logic (including a real DB-backed products array) lives in
  // tests/services/access.test.ts, injecting a fake `getAccess` there. Here we
  // only prove the wiring calls through by delegating to `auth.ts`'s exported
  // instance without needing a live database: no user means the products lookup
  // is never reached at all.
  test("customAccessTokenClaims returns no claims when there is no user", async () => {
    const opts = findPlugin("oauth-provider").options;
    const claims = await opts.customAccessTokenClaims({ scopes: ["openid"] });
    expect(claims).toEqual({});
  });
});

describe("openAPI plugin wiring", () => {
  test("registers the openAPI plugin", () => {
    expect(findPlugin("open-api")).toBeDefined();
  });

  // NODE_ENV=test in this suite (bun test's default) — never production, so the
  // default reference must stay enabled here.
  test("does not disable the default reference outside production", () => {
    expect(findPlugin("open-api").options.disableDefaultReference).toBe(false);
  });
});

describe("alias-otp devOtp wiring", () => {
  // DEV_OTP_BYPASS is unset in this suite's env, so config.DEV_OTP_BYPASS is
  // false and devOtp must not be wired — a dev shortcut must be unrepresentable
  // unless explicitly and validly configured (security rule 14).
  test("devOtp is undefined when DEV_OTP_BYPASS is unset", () => {
    expect(findPlugin("alias-otp").options.devOtp).toBeUndefined();
  });
});

describe("oauthClientSecretHasher", () => {
  test("hashes with argon2id and verifies round-trip, same primitive as passwordHasher", async () => {
    const secret = "a-trusted-client-secret";
    const hash = await oauthClientSecretHasher.hash(secret);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await oauthClientSecretHasher.verify(secret, hash)).toBe(true);
    expect(await oauthClientSecretHasher.verify("wrong-secret", hash)).toBe(false);
  });
});
