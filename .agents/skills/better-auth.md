# Skill: better-auth

Better Auth `1.6.25`. Read before touching `src/auth.ts`, tokens, sessions, or any `/api/auth/*` behaviour.

---

## One instance, one file

`src/auth.ts` exports the only `betterAuth()` instance. A second instance means two session stores. If you think you need one, stop and ask.

## Database — the `pg` exception

Better Auth reaches Postgres through Kysely, which requires a `pg` `Pool`. `Bun.sql` is **not** a supported adapter.

```ts
import { betterAuth } from "better-auth";
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({ connectionString: config.DATABASE_URL }),
  experimental: { joins: true },   // 2–3x on /get-session; needs a migration run
});
```

Everything *we* write uses `Bun.sql` against the same database. Do not add a third client.

## Password hashing — wire it to `Bun.password`

```ts
emailAndPassword: {
  enabled: true,
  password: {
    hash: async pw => Bun.password.hash(pw),          // argon2id
    verify: async ({ hash, password }) => {
      if (hash.startsWith("pbkdf2_sha256$")) return verifyDjangoPbkdf2(password, hash);
      return Bun.password.verify(password, hash);      // handles argon2 AND bcrypt
    },
  },
},
```

`Bun.password.verify` auto-detects from the hash string, so imported bcrypt hashes and new argon2id hashes both work. Only Django PBKDF2 needs a custom branch.

Rehash to argon2id on next successful login via an `after` hook, and record the drain in `imported_hash_algo`.

## OAuth provider — use `oauth-provider`, not `oidcProvider`

`oidcProvider` is documented as "in active development, may not be suitable for production", has an incomplete JWKS endpoint, and is being deprecated. **Never use it.**

```ts
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";

export const auth = betterAuth({
  disabledPaths: ["/token"],        // required — OAuth equivalent is /oauth2/token
  plugins: [
    jwt(),                          // required by oauth-provider by default
    oauthProvider({
      loginPage: "/sign-in",
      trustedClients: [
        { clientId: "lms-web",         type: "web",    skipConsent: true, redirectUrls: [...], clientSecret: ... },
        { clientId: "masterclass-web", type: "web",    skipConsent: true, redirectUrls: [...], clientSecret: ... },
        { clientId: "miles-one-app",   type: "native", skipConsent: true, redirectUrls: ["com.miles.one://oauth/callback"] },
      ],
      accessTokenExpiresIn: 900,     // 15 min. DEFAULT IS 3600 — always override.
      customAccessTokenClaims: ({ user, scopes, resource }) => ({ /* products, vendor_id */ }),
    }),
  ],
});
```

What it gives us: OAuth 2.1, PKCE + S256 required, `iss` in the authorization response (RFC 9207 mix-up defence), refresh via `offline_access`, `client_credentials` for machine-to-machine, RFC 7662 introspection, RFC 7009 revocation, RP-initiated logout.

### JWT vs opaque tokens

Format depends on the `resource` parameter:

- Client sends `resource` → **signed JWT**. Resource servers verify locally against `/api/auth/jwks`. No network hop.
- No `resource` → **opaque**. Requires `/oauth2/introspect` per request.

**Our decision: JWT only.** Every resource server rejects opaque tokens. Three backends introspecting per request would make this service a latency bottleneck and a DOS target — and introspection needs a `client_secret`, which our Flutter and Angular clients cannot hold.

### Never enable `pairwiseSecret`

Pairwise gives each client a different `sub` for the same person. That breaks the premise that every product resolves to one `usr_` id. Public subject type only.

## Sessions

Database-backed, not stateless. Revocation is deleting a row — instant.

Put `Bun.redis` behind it via `secondaryStorage` so page views do not each hit Postgres:

```ts
secondaryStorage: {
  get: async key => await redis.get(key),
  set: async (key, value, ttl) => { await redis.set(key, value, "EX", ttl ?? 900); },
  delete: async key => { await redis.del(key); },
},
```

## Plugins we use, and only these

| Plugin | Purpose |
|---|---|
| `jwt()` | asymmetric signing, JWKS endpoint |
| `oauthProvider()` | the authorization server |
| `emailOTP()` | passwordless email |
| `phoneNumber()` | SMS OTP; set a real `getTempEmail` domain, never `temp.better-auth.com` |
| `twoFactor()` | mandatory for ADMIN and VENDOR_ADMIN |
| `admin()` | ban, impersonate, list |
| `sso()` from `@better-auth/sso` | inbound vendor SAML 2.0 / OIDC |

Do not add `organization()` without a plan — it overlaps `user_product_access` and `vendor`, and two sources of truth for roles is worse than one.

## Extending the user

Via `additionalFields`, never by altering Better Auth's tables:

```ts
user: {
  additionalFields: {
    salesforceContactId: { type: "string", required: false, input: false },
    status:              { type: "string", required: false, input: false },
    mergedIntoUserId:    { type: "string", required: false, input: false },
  },
},
```

`input: false` means clients cannot set it. All three of these are server-controlled.

## Schema management

```bash
bunx @better-auth/cli generate   # emit SQL for review
bunx @better-auth/cli migrate    # apply
```

Run after adding any plugin or additional field. **Review the generated SQL before applying** — it is a migration against a production auth store, not a scaffold.

Our own tables (`user_identity`, `user_product_access`, `vendor`, `identity_merge_log`, `outbox`) are **ours**: hand-written migrations in `src/db/migrations/`, applied by `bun run db:migrate`. Keep the two migration paths separate and never let the CLI manage our tables.

## Rate limiting

Globally enabled in production by default. Per-endpoint overrides exist for `/oauth2/introspect` and friends. Tighten `/api/identity/resolve` explicitly — the default is not strict enough for an enumeration-sensitive endpoint.

## Hooks

Use `before`/`after` hooks for cross-cutting behaviour: rehash-on-login, audit log writes, outbox events on user creation. Do not fork Better Auth internals.

## Not certified

Better Auth is **not** on the OpenID Foundation certified implementations list. Consequences:

1. The official OIDC conformance suite is a real gate before production, not a formality.
2. A vendor security review may ask for a certification we cannot produce.

Do not claim OIDC compliance in code comments, docs, or to a vendor without a conformance run behind it.
