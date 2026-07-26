# 006 — OAuth provider, JWKS, token claims

**Status:** approved · implemented
**Roadmap step:** 6 of 15

**Approved decisions:** (1) trusted clients registered via a new idempotent seed script (`bun run oauth:clients:sync`), not a static plugin option and not a boot-time upsert; (2) client secrets hashed with `Bun.password`, reusing the existing `passwordHasher` pattern; (3) `customAccessTokenClaims` stays identity-only (`email`, `email_verified`) — `products`/`vendor_id` are step 7's job.

---

## Goal

Turn the stable identity from steps 3–5 into an OAuth 2.1/OIDC authorization server — `jwt()` + `oauthProvider()`, four trusted first-party clients, JWKS-verifiable RS256 access tokens — so resource servers can verify tokens locally with no call back to Miles Identity.

## What it read

**Skills**

- `.agents/skills/better-auth.md` — "use `oauth-provider`, not `oidcProvider`" (the latter is deprecated, JWKS incomplete). `disabledPaths: ["/token"]` required. JWT-only decision: every resource server rejects opaque tokens, three backends introspecting per request would make this service a bottleneck and a DOS target, and introspection needs a `client_secret` the Flutter/Angular clients cannot hold. Never enable `pairwiseSecret` — pairwise subjects break the one-global-`sub` premise.
- `.agents/skills/security.md` — 5–15 min TTL, override the 3600s library default. Refresh rotates every use, reuse revokes the family. Secrets never in source, tests, or logs.
- `docs/architecture-plan.md` §3.3/§3.4 — token claims shape (`iss`, `sub`, `email`, `email_verified`, …), RS256 explicitly (not the library's EdDSA default), and the JWT-vs-opaque decision this plan implements.
- AGENTS.md roadmap — step 7 is explicitly "RBAC — `user_product_access`, role claims" — a separate step, so `products`/`vendor_id` claims do not belong here.

**Files opened**

- `src/auth.ts` — step-5 instance: `aliasOtp()` plugin, `passwordHasher`, DB sessions + Redis `secondaryStorage`. The single place plugins get added.
- `src/lib/config.ts` — tier2 pattern (`requireLater`, `.default()` values typed optional after the tier2 `.partial()` merge), existing `ACCESS_TOKEN_TTL_SECONDS` (60–900s, default 900), `LMS_WEB_CLIENT_SECRET`/`MASTERCLASS_WEB_CLIENT_SECRET` already present.
- `.env.example` — "OAuth clients (trusted, first-party)" section already scaffolded with the two web secrets and a comment noting `miles-one-app`/`masterclass-app` are public/PKCE-only.
- `src/db/auth-schema.ts` — the `getMigrations(auth.options)` / `auth.$context` accessor pattern, run under Bun (not `bunx auth` under Node/jiti, which cannot resolve `Bun.password`/`Bun.redis`).
- `tests/auth/instance.test.ts` — the env-stub-then-restore pattern for testing `auth.options` wiring without a live DB/Redis.
- `tests/helpers/database.ts` — the disposable-schema harness; applies `src/db/better-auth-schema.sql` as a full bootstrap script before our own migrations.
- `node_modules/@better-auth/oauth-provider/dist/*.d.mts`, `index.mjs` — read directly (see Assumptions/Decisions) after the skill doc's example didn't match the installed version.

## Assumptions

1. **`oauthProvider({ trustedClients: [...] })` does not exist in the installed `@better-auth/oauth-provider@1.6.25`.** Confirmed by grepping the full `.d.mts`/`.mjs` source — no `trustedClients` field anywhere in `OAuthOptions`. OAuth clients are plain rows in the `oauthClient` table, normally created through a session-gated `/oauth2/create-client` endpoint (`createOAuthClientEndpoint` calls `assertClientPrivileges`, which throws `UNAUTHORIZED` without a session) meant for end-user/dynamic registration, not first-party seeding. **Resolved with the user**: a new idempotent script writes the four clients directly via `ctx.adapter.create`/`update` — the same adapter Better Auth's own endpoint uses, reached through `auth.$context`.
2. **Client secret hashing.** The plugin's default `storeClientSecret: "hashed"` calls an internal hash function not exported for external use. **Resolved with the user**: reuse `Bun.password` as a custom `storeClientSecret: { hash, verify }`, exported as `oauthClientSecretHasher` next to `passwordHasher`, so the seed script's hash and the runtime verify path are always the same function.
3. **Claims scope.** The skill doc's `customAccessTokenClaims` example includes `products`/`vendor_id`, which read from `user_product_access` — but AGENTS.md's roadmap puts that table and its role claims at step 7. **Resolved with the user**: step 6's claims stay identity-only (`email`, `email_verified`); `products`/`vendor_id` are added in step 7 once `user_product_access` has read helpers.
4. **RS256, not the library default.** `jwt()` defaults to `EdDSA`/Ed25519; `docs/architecture-plan.md` §3.3 calls for RS256 explicitly — set via `jwks.keyPairConfig.alg`.
5. **`disableSettingJwtHeader: true`.** The `jwt()` plugin's own type doc recommends this whenever an OAuth provider plugin is present, so session cookies don't also carry a signed JWT header. Set accordingly.
6. **`validAudiences` pinned to a single entry.** Found via `bun audit` after implementation (not before) — see Security requirements.
7. **Native app redirect URIs are not guessed.** `miles-one-app`'s scheme (`com.miles.one://oauth/callback`) is documented in `docs/architecture-plan.md` §4.3; `masterclass-app`'s is not documented anywhere in this repo, so its config value (`MASTERCLASS_APP_REDIRECT_URL`) is left unset in `.env.example` rather than invented, with a comment to get the real value from that app's owner.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/auth.ts` | modify | `jwt()` + `oauthProvider()` plugins, `disabledPaths: ["/token"]`, `oauthClientSecretHasher` export |
| `src/auth/oauth-clients.ts` | create | Pure trusted-client definitions (`lms-web`, `masterclass-web`, `miles-one-app`, `masterclass-app`) |
| `src/db/seed-oauth-clients.ts` | create | `syncOAuthClients()` + CLI entrypoint — idempotent upsert into `oauthClient` |
| `src/lib/config.ts` | modify | tier2: `LMS_WEB_REDIRECT_URLS`, `MASTERCLASS_WEB_REDIRECT_URLS`, `MILES_ONE_APP_REDIRECT_URL`, `MASTERCLASS_APP_REDIRECT_URL` |
| `.env.example` | modify | new redirect-URL vars, native-scheme placeholders |
| `package.json` | modify | `oauth:clients:sync` script; `audit`/`check` scripts gain `--ignore=GHSA-p2fr-6hmx-4528` |
| `src/db/better-auth-schema.sql` | modify (regenerated) | adds `jwks`, `oauthClient`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent` |
| `tests/auth/instance.test.ts` | modify | oauth-provider wiring assertions, `oauthClientSecretHasher` round-trip |
| `tests/auth/oauth-clients.test.ts` | create | pure client-definition assertions |
| `tests/db/seed-oauth-clients.test.ts` | create | idempotency + secret-preservation against a disposable schema |
| `tests/db/migrate.test.ts`, `tests/db/constraints.test.ts` | modify | table-exclusion lists extended for the new Better-Auth-owned tables |

## Implementation requirements

1. `src/auth.ts`: register `jwt({ jwks: { keyPairConfig: { alg: "RS256" } }, disableSettingJwtHeader: true })` and `oauthProvider({ loginPage: "/sign-in", consentPage: "/consent", validAudiences: [config.BETTER_AUTH_URL], accessTokenExpiresIn: requireLater("ACCESS_TOKEN_TTL_SECONDS"), storeClientSecret: oauthClientSecretHasher, customAccessTokenClaims })`, plus `disabledPaths: ["/token"]` at the root `betterAuth()` call. Never set `pairwiseSecret`.
2. `customAccessTokenClaims(({ user }) => user ? { email: user.email, email_verified: user.emailVerified } : {})` — `sub`/`iss`/`aud`/`azp`/`scope`/`iat`/`exp` are set by the plugin itself after this return value is spread in, so it cannot clobber them and does not need to set them.
3. `src/auth/oauth-clients.ts` exports `trustedClients(): TrustedClientDefinition[]` — pure, no DB/Better Auth import, reading redirect URLs and secrets via `requireLater` so a missing config value fails loudly at call time rather than silently.
4. `src/db/seed-oauth-clients.ts` exports `syncOAuthClients(adapter, hasher, clients)`, parameterised so it can run against either the real `@/auth` singleton (CLI entrypoint) or a disposable test schema. For each client: `findOne` by `clientId`; if absent, `create` with the secret hashed (public/native clients get `clientSecret: undefined`); if present, `update` only `redirectUris`/`skipConsent`/`disabled` — **never** touch an existing `clientSecret`.
5. Config additions are tier2 (`requireLater`-gated), not tier1 — the process must still boot without them; only `oauth:clients:sync` requires them to be set.

## Data model impact

- No hand-written migration — `jwt()`/`oauthProvider()` are Better-Auth-owned plugins, so their tables come from the CLI-generated path (`bun run auth:schema` → review → `bun run auth:migrate`), never a file in `src/db/migrations/`.
- New Better-Auth-owned tables: `jwks`, `oauthClient`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`.
- `src/db/better-auth-schema.sql` was regenerated against a scratch empty database (not the real dev DB, which already had `user`/`session`/`account` applied and would otherwise have produced only the incremental diff) so it stays a valid, self-contained bootstrap script for `tests/helpers/database.ts`.

## Security requirements

- JWT-only, no opaque-token path — matches the existing "reject opaque tokens" decision; nothing here introduces introspection as a default path.
- Access tokens 900s (15 min), well inside the 5–15 min rule; never the library's 3600s default.
- `pairwiseSecret` never set — every product must resolve the same `usr_` id.
- Client secrets hashed with `Bun.password` (argon2id), never stored or logged in plaintext; never touched on a sync rerun (rotation is a separate, explicit action).
- **`bun audit` finding (GHSA-p2fr-6hmx-4528, moderate):** every `oauth-provider` 1.6.x release doesn't bind the RFC 8707 `resource` parameter to the original authorization grant — exploitable only when `validAudiences` has more than one entry. **Mitigated**: `validAudiences: [config.BETTER_AUTH_URL]` pins to exactly one audience (the advisory's own documented workaround), closing the gap explicitly rather than relying on the implicit single-audience default. Accepted as residual risk until a stable 1.7.0 ships with the real fix; `bun audit --ignore=GHSA-p2fr-6hmx-4528` added to the `audit`/`check` scripts, with the reasoning recorded in a comment on `validAudiences` in `src/auth.ts`.
- None of the four documented takeover paths apply directly to this step (no alias linking, no federation) — but token issuance now exists, so step 7's role claims and step 10's vendor federation both build on the `validAudiences`/claims boundary set here.

## Authorization impact

None. `customAccessTokenClaims` is identity-only; Layer 1 (RBAC) role claims and Layer 2 (graph) both remain step 7+.

## Bun-native check

- New dependencies: `none` — `@better-auth/oauth-provider` and `@better-auth/sso` were already pinned dependencies (unused until now); `jwt` ships inside `better-auth/plugins`.
- Client-secret hashing reuses `Bun.password` (already the sanctioned primitive for user passwords) instead of a new hashing library.

## Acceptance criteria

- [x] `/api/auth/jwks` serves an RS256 JWK set.
- [x] The four trusted clients (`lms-web`, `masterclass-web` confidential; `miles-one-app`, `masterclass-app` public/native) are registered via `oauth:clients:sync`, idempotently.
- [x] A full authorization-code + PKCE + `resource` flow for a trusted client returns a JWT verifiable locally against JWKS, with `iss`/`sub`/`email`/`email_verified` present and no `products`/`vendor_id` claim.
- [x] `bun run check` (typecheck + test + audit) passes clean.

## Tests to add

- [x] `tests/auth/instance.test.ts` — `jwt`/`oauth-provider` both registered; `disabledPaths` includes `/token`; `accessTokenExpiresIn` equals the config value; `jwks.keyPairConfig.alg === "RS256"`; `disableSettingJwtHeader === true`; `pairwiseSecret` never set; `validAudiences` pinned to exactly one entry; `customAccessTokenClaims` returns only `email`/`email_verified` (and `{}` when there is no user) — asserts the negative case that `products`/`vendor_id` do **not** leak in early.
- [x] `tests/auth/oauth-clients.test.ts` — the two native clients have no `clientSecret` and `type: "native"`; the two web clients are `type: "web"` with non-empty `redirectUris` parsed from comma-separated config.
- [x] `tests/db/seed-oauth-clients.test.ts` — `syncOAuthClients` against a real disposable schema: exactly one row per `clientId` after two runs (`{created: 2, updated: 0}` then `{created: 0, updated: 2}`); a confidential client's secret is hashed and verifiable; **negative case** — rerunning sync with a changed redirect URI does not change an already-stored `clientSecret`.

## Checks to run

- [x] `bun run typecheck`
- [x] `bun test` (219 pass, 91% coverage)
- [x] `bun audit` (clean with `--ignore=GHSA-p2fr-6hmx-4528`)
- [x] `bun run auth:schema` / `bun run auth:migrate` against local Postgres

## How to verify it

```bash
1. bun run check
   → typecheck clean, 219 tests pass, audit clean

2. bun run auth:migrate
   → "[auth] Better Auth schema applied to the database"

3. bun run oauth:clients:sync
   → "[oauth-clients] created 4, updated 0" (first run), "created 0, updated 4" (rerun)

4. curl -s http://localhost:3000/api/auth/jwks
   → {"keys":[{"alg":"RS256", ...}]}

5. Full authorization_code + PKCE + resource flow against a running server for
   lms-web, then decode/verify the returned access_token locally against the
   JWKS response (e.g. with `jose`):
   → payload contains iss, sub, email, email_verified — no products/vendor_id;
     exp - iat === 900; signature verifies with alg RS256, no network call back
     to Miles Identity required.
```

The last step is the security property that matters here: a resource server never needs to call this service to verify a token.

## Out of scope for this task

- `products`/`vendor_id` (or any) role claims — step 7 (RBAC), once `user_product_access` has read helpers.
- 2FA, admin operations, vendor SSO — later roadmap steps.
- An actual `/sign-in` / `/consent` page — `loginPage`/`consentPage` are required path strings on `oauthProvider()`; no frontend exists yet in this backend-only service. Flagged as a known gap, not silently assumed away.
- Upgrading `@better-auth/oauth-provider` past 1.6.25 to pick up the GHSA-p2fr-6hmx-4528 fix — no stable 1.7.0 release exists yet, only pre-releases; revisit when one ships.
