/**
 * The single Better Auth instance. One file, one `betterAuth()` — a second means
 * two session stores. See .agents/skills/better-auth.md.
 *
 * Better Auth reaches Postgres through Kysely, which requires a `pg` `Pool`. This
 * is the ONE place `pg` is allowed (AGENTS.md tech-stack exception). Everything WE
 * write goes through `Bun.sql` in `src/db/` — two clients, one database, by design.
 *
 * Step 5 added passwordless sign-in via our first-party `aliasOtp` plugin (email +
 * SMS OTP resolved through the alias table). Step 6 adds the OAuth 2.1/OIDC
 * provider — `jwt()` + `oauthProvider()` — so the four trusted clients (registered
 * separately by `src/db/seed-oauth-clients.ts`, NOT a static option here — see
 * .agents/skills/better-auth.md and the roadmap-step-6 plan) can verify tokens
 * locally against JWKS. 2FA, admin and SSO plugins remain later roadmap steps.
 *
 * Step 7 (RBAC) adds the `products` claim (product_id/role/vendor_id per active
 * `user_product_access` row), via `buildAccessTokenClaims` in
 * `src/services/access.ts` — imported lazily below for the same jiti/CLI reason
 * `getRedis` is.
 *

 * We deliberately do NOT mount Better Auth's own `emailOTP`/`phoneNumber` plugins:
 * they key on `user.email`/`user.phoneNumber` and bypass `user_identity`, so they
 * cannot honour the alias model or the verified-only rule. See src/auth/alias-otp.ts.
 *
 * Step 9 (prompts/009) imports Masterclass's legacy Django password hashes
 * (src/services/legacy-import.ts) rather than proxying to the legacy database at
 * login time (docs/architecture-plan.md:463). `passwordHasher.verify` dispatches
 * a `pbkdf2_sha256$…` hash to `verifyLegacyPassword`, gated by
 * `MASTERCLASS_LEGACY_PASSWORD_LOGIN_ENABLED` (fail-closed default). `hooks.after`
 * rehashes to argon2id on the first successful sign-in via
 * `src/services/legacy-rehash.ts`.
 */

import { betterAuth } from "better-auth";
import { jwt, openAPI } from "better-auth/plugins";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { oauthProvider } from "@better-auth/oauth-provider";
import { Pool } from "pg";
import { getConfig, requireLater } from "@/lib/config";
import { aliasOtp } from "@/auth/alias-otp";
import { sendEmailOtp } from "@/integrations/email";
import { sendSmsOtp } from "@/integrations/sms";
import { DEV_OTP_CODE } from "@/services/otp";
import { verifyLegacyPassword } from "@/lib/pbkdf2";
import { rehashLegacyPasswordOnSignIn } from "@/services/legacy-rehash";

const config = getConfig();

/**
 * The Better Auth CLI (`bunx auth generate` / `migrate`) loads THIS config with
 * jiti under Node, which cannot resolve a top-level `import … from "bun"`. Our
 * redis wrapper pulls in `bun`, so it is reached lazily here — inside the
 * `secondaryStorage` callbacks the CLI never evaluates — while the real runtime
 * under `Bun.serve` resolves and module-caches it on first use.
 */
const getRedis = async () => (await import("@/lib/redis")).redis;

// Same reason as getRedis: src/services/access.ts pulls in src/db/access.ts,
// which has a top-level `import ... from "bun"` the CLI's jiti loader can't
// resolve. Reached lazily here so the real runtime resolves and caches it once.
const getAccessTokenClaimsBuilder = async () => (await import("@/services/access")).buildAccessTokenClaims;

/**
 * Password hashing wired to `Bun.password` (argon2id). `verify` reads the algorithm
 * out of the hash string, so an imported bcrypt hash verifies through the same call.
 * A Django `pbkdf2_sha256$…` hash (step 9's Masterclass legacy import) takes the
 * dedicated branch — `Bun.password.verify` cannot auto-detect that format.
 *
 * The `MASTERCLASS_LEGACY_PASSWORD_LOGIN_ENABLED` gate lives HERE, not as a
 * separate hook: while the flag is off, a PBKDF2 hash simply never verifies, so
 * an imported-but-gated account fails exactly the same way Better Auth's own
 * sign-in/email already fails a wrong password (BASE_ERROR_CODES.
 * INVALID_EMAIL_OR_PASSWORD) — no new error, no new branch for an attacker to
 * distinguish. See prompts/009 and .agents/skills/better-auth.md.
 *
 * Exported so the wiring is unit-testable without standing up the database.
 */
export const passwordHasher = {
  hash: (password: string): Promise<string> => Bun.password.hash(password),
  verify: async ({ password, hash }: { password: string; hash: string }): Promise<boolean> => {
    if (hash.startsWith("pbkdf2_sha256$")) {
      return verifyLegacyPassword(password, hash, config.MASTERCLASS_LEGACY_PASSWORD_LOGIN_ENABLED ?? false);
    }
    return Bun.password.verify(password, hash);
  },
};

/**
 * Reused as `storeClientSecret` below AND by `seed-oauth-clients.ts`, so the seed
 * script's hash and the OAuth provider's runtime verify are always the same
 * function — same reasoning as `passwordHasher`.
 */
export const oauthClientSecretHasher = {
  hash: (clientSecret: string): Promise<string> => Bun.password.hash(clientSecret),
  verify: (clientSecret: string, hash: string): Promise<boolean> =>
    Bun.password.verify(clientSecret, hash),
};

export const auth = betterAuth({
  // The one sanctioned `pg` use: Better Auth's own tables, via Kysely.
  database: new Pool({ connectionString: config.DATABASE_URL }),
  baseURL: config.BETTER_AUTH_URL,
  secret: config.BETTER_AUTH_SECRET,

  // 2–3x on /get-session by joining session+user in one query. Kysely/pg supports it.
  experimental: { joins: true },

  // The OAuth equivalent of Better Auth's own /token is /oauth2/token. In
  // production, also disable the openAPI() plugin's raw schema route: unlike the
  // HTML reference, `disableDefaultReference` does NOT gate this path, and the
  // spec being publicly fetchable would violate security rule 13 the same as the
  // reference page would.
  disabledPaths:
    config.NODE_ENV === "production" ? ["/token", "/open-api/generate-schema"] : ["/token"],

  emailAndPassword: {
    enabled: true,
    password: passwordHasher,
  },

  plugins: [
    // Passwordless sign-in wired to the alias resolver. Adds no Better Auth table —
    // it reuses the existing `verification` store for OTP state. See alias-otp.ts.
    // devOtp is only ever set outside production — DEV_OTP_BYPASS is rejected by
    // config validation whenever NODE_ENV=production (security rule 14).
    aliasOtp({
      sendEmailOtp,
      sendSmsOtp,
      devOtp: config.DEV_OTP_BYPASS ? DEV_OTP_CODE : undefined,
    }),

    // Scalar's reference/spec for our own routes lives at src/routes/docs.ts; this
    // is Better Auth's own half, covering /api/auth/* including alias-otp's
    // endpoints. Never exposed in production — see .agents/skills/scalar-api-docs.md.
    openAPI({ disableDefaultReference: config.NODE_ENV === "production" }),

    // RS256 per docs/architecture-plan.md §3.3 — the library default is EdDSA.
    // disableSettingJwtHeader: recommended whenever an OAuth provider plugin is
    // present, so session cookies don't also carry a signed JWT header.
    jwt({
      jwks: { keyPairConfig: { alg: "RS256" } },
      disableSettingJwtHeader: true,
    }),

    // The OAuth 2.1/OIDC authorization server. Trusted clients are NOT configured
    // here (no such option exists on the installed package) — they're rows in
    // `oauthClient`, written by `bun run oauth:clients:sync`. See oauth-clients.ts.
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/consent",
      // GHSA-p2fr-6hmx-4528: on every 1.6.x release, the token endpoint doesn't bind
      // the RFC 8707 `resource` parameter to the original authorization grant, so a
      // client requesting a `resource` outside a single-entry validAudiences could
      // otherwise pick a JWT audience its authorization never covered. Pinning to
      // exactly one audience (rather than leaving the default implicit) closes that
      // gap per the advisory's own workaround. Accepted risk until a stable 1.7.0
      // ships with the real fix (resources bound to the auth code + refresh token);
      // `bun audit` is told to ignore this GHSA in the meantime (see package.json).
      validAudiences: [config.BETTER_AUTH_URL],
      // 5–15 min, already enforced by the config schema — never the library's 1h default.
      // requireLater, not config.ACCESS_TOKEN_TTL_SECONDS: the field carries a zod
      // .default(900), so it is always set at runtime, but tier 2 is typed optional.
      accessTokenExpiresIn: requireLater("ACCESS_TOKEN_TTL_SECONDS"),
      storeClientSecret: oauthClientSecretHasher,
      // sub/iss/aud/exp are set by the plugin itself, after this return value is
      // spread in, so they can't be clobbered from here. See buildAccessTokenClaims
      // in src/services/access.ts for the products claim logic (tested there,
      // without needing a live OAuth flow).
      customAccessTokenClaims: async ({ user }) => (await getAccessTokenClaimsBuilder())(user ?? undefined),
      // Never pairwiseSecret: every product must resolve the same usr_ id.
    }),
  ],

  // Server-controlled extensions to the `user` row. `input: false` means a client
  // cannot set them. Declared here so the Better-Auth-owned `user` table carries
  // them from creation — a later step must never ALTER a BA table to add a column.
  // `fieldName` maps camelCase → the snake_case columns in the AGENTS.md data model.
  user: {
    additionalFields: {
      salesforceContactId: {
        type: "string",
        required: false,
        input: false,
        unique: true,
        fieldName: "salesforce_contact_id",
      },
      status: {
        type: "string",
        required: false,
        input: false,
        defaultValue: "active",
      },
      mergedIntoUserId: {
        type: "string",
        required: false,
        input: false,
        fieldName: "merged_into_user_id",
      },
      // Set by the step-9 legacy import (src/services/legacy-import.ts) to the
      // source format ("django_pbkdf2") of an imported, not-yet-rehashed
      // password. Cleared by the rehash-on-login `hooks.after` below on the
      // first successful sign-in. Null for every account never imported.
      importedHashAlgo: {
        type: "string",
        required: false,
        input: false,
        fieldName: "imported_hash_algo",
      },
    },
  },

  // Rehash-on-login for step 9's legacy import: the first successful sign-in
  // against an imported PBKDF2 hash upgrades the stored hash to argon2id and
  // clears importedHashAlgo, so the account is unaffected by
  // MASTERCLASS_LEGACY_PASSWORD_LOGIN_ENABLED from that point on. Only ever
  // runs after a REAL verified success — never on a failed or rejected
  // sign-in. See prompts/009.
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;

      const returned = ctx.context.returned;
      if (returned === undefined || isAPIError(returned)) return; // failed sign-in: never rehash

      const email = ctx.body?.email;
      const password = ctx.body?.password;
      if (typeof email !== "string" || typeof password !== "string") return;

      await rehashLegacyPasswordOnSignIn(email, password, {
        findUserByEmail: (e) => ctx.context.internalAdapter.findUserByEmail(e, { includeAccounts: true }),
        updateAccount: (id, data) => ctx.context.internalAdapter.updateAccount(id, data),
        updateUser: (id, data) => ctx.context.internalAdapter.updateUser(id, data),
        hashPassword: passwordHasher.hash,
      });
    }),
  },

  // Postgres stays the source of truth so revocation is deleting a row — instant.
  session: { storeSessionInDatabase: true },

  // Redis in front of the session table so page views do not each hit Postgres.
  // Keys and values are session data — never logged. See .agents/skills/better-auth.md.
  secondaryStorage: {
    get: async (key) => (await getRedis()).get(key),
    set: async (key, value, ttl) => {
      const redis = await getRedis();
      if (ttl !== undefined) await redis.set(key, value, "EX", ttl);
      else await redis.set(key, value);
    },
    delete: async (key) => {
      await (await getRedis()).del(key);
    },
  },
});
