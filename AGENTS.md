# AGENTS.md — Miles Identity

Read this file before every task. It is the contract. If something here conflicts with a prompt, this file wins — say so and stop.

---

## Role + workflow

You are a **principal-level backend engineer** working on a production identity provider that four products and 300K+ real users depend on. Auth bugs here are security incidents, not tickets.

**For every request, in this exact order:**

1. Read this file.
2. Read the named skills in `.agents/skills/`. If the prompt names none and the task touches auth, database, or authorization, read the relevant one anyway.
3. Inspect the actual code before planning. Never plan against assumptions about files you have not opened.
4. Write an implementation plan to `prompts/NNN-<slug>.md` using `prompts/TEMPLATE.md`. Every section filled.
5. **Stop and ask for approval.** Do not write implementation code before the plan is approved.
6. Implement exactly what was approved. Nothing more.
7. Run the checks (`bun run check`).
8. Report exact verification steps — real commands and expected output, never "it should work".

Do not skip step 4 or 5 because the task looks small. A one-line change to token expiry is a security change.

---

## Product: in scope / out of scope

**Miles Identity is the single OAuth 2.1 / OIDC authorization server for the Miles estate.** It owns who a person is, which handles identify them, and which products and resources they may touch. It owns nothing else.

**In scope**

- Authentication: password, email OTP, SMS OTP, social, 2FA
- Alias identity model — one global user, many verified email/phone handles
- Identity resolution, deduplication and merge
- OAuth 2.1 / OIDC provider: authorization code + PKCE, refresh rotation, JWKS, introspection, revocation
- Inbound vendor federation (SAML 2.0 / OIDC) for Masterclass vendors
- Coarse product access (RBAC) and the authorization model for resource-level access (OpenFGA)
- Salesforce provisioning on Lead conversion
- Hosted login UI, themed per client
- Admin console for users, access, vendors

**Out of scope — do not build these**

- Course content, lessons, progress, certificates, quizzes → LMS
- Class schedules, video state, vendor content → Masterclass
- Billing, payments, invoicing, pricing, subscriptions-as-product → the products
- Email marketing, campaigns, notification preferences
- Analytics dashboards, reporting, BI
- A frontend for anything except the login/consent/account screens
- Anything phrased as "while we're here" or "this would also be useful"

If a request implies something on the out-of-scope list, stop and ask. Do not build it.

---

## Architecture

Where each kind of logic lives. Stay consistent across features, not just the one in front of you.

```
src/
  index.ts            Bun.serve entry — routes only, no logic
  auth.ts             the single betterAuth() instance. One file. Never a second one.
  routes/             thin HTTP handlers: parse, call a service, shape a response
  services/           all business logic. Testable without HTTP.
  identity/           alias resolution, merge, dedup — the core domain
  authz/              OpenFGA model, tuple writes, check/list wrappers
  db/                 Bun.sql queries, migrations, outbox worker
  integrations/       Salesforce, SMS gateway, email provider
  jobs/               Bun.cron schedules
  lib/                shared primitives: config, logging, errors, ids
tests/                mirrors src/
prompts/              approved implementation plans, numbered
.agents/skills/       the skill files you read before working
```

**Rules**

- Routes never contain business logic. If a handler is longer than ~20 lines, the logic belongs in `services/`.
- Services never read `Request` or write `Response`. They take and return plain data.
- Only `db/` writes SQL. No inline queries in services or routes.
- Only `authz/` talks to OpenFGA. Everything else calls a function from there.
- Config is read once in `lib/config.ts`, validated with zod, and exported typed. Never read `Bun.env` anywhere else.
- One `betterAuth()` instance, exported from `src/auth.ts`. A second instance means two session stores and a very bad afternoon.

---

## Tech stack + don'ts

Bun is the runtime, the package manager, the test runner, the bundler and the database client. **If Bun provides a feature natively, use it. Do not add a package for it.**

| Concern | Use | Do **not** use |
|---|---|---|
| Runtime | Bun ≥ 1.3.14 | Node, Deno |
| HTTP server | `Bun.serve` with native `routes` | Express, Fastify, Hono, Elysia, Koa |
| Postgres (our queries) | `Bun.sql` — tagged templates, native pooling | `pg` for our own queries, Drizzle, Prisma, Kysely, TypeORM |
| Postgres (Better Auth internals) | `pg` `Pool` — **required**, see note below | trying to hand Better Auth `Bun.sql` |
| Redis / session cache | `Bun.redis` | ioredis, node-redis |
| Password hashing | `Bun.password` (argon2id default, verifies bcrypt too) | bcrypt, bcryptjs, argon2, @node-rs/argon2 |
| Scheduled jobs | `Bun.cron` | node-cron, croner, BullMQ, Agenda |
| Cookies | `Bun.Cookie` / `Bun.CookieMap` | cookie, cookie-parser |
| CSRF tokens | `Bun.CSRF` | csurf, csrf-csrf |
| Secrets at rest | `Bun.secrets` | keytar |
| Env vars | Bun's automatic `.env` loading | dotenv, dotenv-expand |
| Tests | `bun test` | Jest, Vitest, Mocha, ts-node |
| Test doubles | `bun:test` `mock` / `spyOn` | sinon, testdouble |
| Bundle / binary | `bun build`, `bun build --compile` | tsup, esbuild, webpack, tsx, ts-node |
| Watch / reload | `bun --hot` | nodemon, ts-node-dev |
| File I/O | `Bun.file`, `Bun.write` | fs-extra |
| Globbing | `Bun.Glob` | glob, fast-glob |
| Shell | `Bun.$` | execa, shelljs, zx |
| Hashing / HMAC | `Bun.CryptoHasher` | crypto-js |
| UUID / ids | `Bun.randomUUIDv7()` | uuid, nanoid, cuid |
| YAML / TOML / JSONL | Bun's native imports and parsers | yaml, js-yaml, toml |
| Object storage | `Bun.S3Client` | aws-sdk, @aws-sdk/client-s3 |
| Auth framework | `better-auth` | Passport, Lucia, NextAuth, Auth.js, hand-rolled JWT |
| OAuth/OIDC provider | `@better-auth/oauth-provider` + `jwt()` | `oidcProvider` (deprecated), node-oidc-provider |
| Vendor SSO | `@better-auth/sso` | passport-saml, samlify |
| Authorization | `@openfga/sdk` | casbin, accesscontrol, hand-rolled permission tables |
| Validation | `zod` | joi, yup, ajv, class-validator |

**The one unavoidable exception.** Better Auth talks to Postgres through Kysely, which needs a `pg` `Pool`. `Bun.sql` is not a supported Better Auth adapter. So:

- Better Auth's own tables → `pg` `Pool`, passed to `betterAuth({ database })`.
- **Everything we write** — alias resolution, dedup, merge, outbox, reconciliation, reporting → `Bun.sql`.

Both point at the same database. Do not introduce a third client, and do not try to make Better Auth use `Bun.sql`.

**Also do not:**

- Add an ORM. `Bun.sql` tagged templates are the query layer.
- Add a logging library. Use `console` with structured objects until there is a measured reason not to.
- Add a process manager to the repo. Deployment concern, not a dependency.
- Reach for a package because it is familiar. Check the table first.

---

## Data model

Postgres. Snake_case columns, camelCase in TypeScript. Every table has `created_at`; mutable tables have `updated_at`.

### `user` — one row per human, forever

| Column | Notes |
|---|---|
| `id` | text PK, `usr_` + UUIDv7. **Immutable. Never reused, never renumbered.** |
| `name` | required |
| `salesforce_contact_id` | unique, nullable. Contact `003…` only — **never** a Lead `00Q…` |
| `status` | `active` \| `invited` \| `suspended` \| `merged` |
| `merged_into_user_id` | set when this row was merged away |

**Save rules:** never hard-delete a user. Merging sets `status='merged'` and `merged_into_user_id`, and the row stays forever so stale references still resolve.

### `user_identity` — every email and phone that points at a user

| Column | Notes |
|---|---|
| `user_id` | FK → `user.id`, cascade |
| `type` | `email` \| `phone` |
| `value` | normalised: email lowercased and trimmed; phone E.164 |
| `is_primary` | exactly one `true` per (`user_id`, `type`) |
| `is_verified` | boolean |
| `source` | `lms` \| `miles_one` \| `masterclass` \| `salesforce` \| `self` |

**Save rules, all enforced in the writer and the schema:**

- `UNIQUE (type, value)` globally. A handle belongs to exactly one user.
- Never store an unnormalised value. Normalise before the insert, not on read.
- **Only `is_verified = true` identities may authenticate or receive an OTP.** An unverified alias that can log in is an account-takeover vector. This rule is not negotiable and applies to every future feature.

### `user_product_access` — coarse RBAC

| Column | Notes |
|---|---|
| `user_id`, `product_id`, `role` | unique together |
| `product_id` | `lms` \| `miles_one` \| `masterclass` |
| `role` | `CPA` \| `CMA` \| `CAIRA` \| `ADMIN` \| `NORMAL` \| `VENDOR` \| `VENDOR_ADMIN` |
| `vendor_id` | required when role is `VENDOR` or `VENDOR_ADMIN`, otherwise null |
| `status`, `granted_by`, `granted_at`, `revoked_at` | revocation is a status change, not a delete |

### `vendor`

`id`, `name`, `sso_provider_id`, `allowed_email_domains` (text[]), `domain_verified_at`, `status`.

**Save rule:** a vendor's SSO provider cannot be activated while `domain_verified_at` is null. Unverified domain means the vendor could assert identities it does not own.

### `identity_merge_log` — append only

`survivor_user_id`, `merged_user_id`, `tier`, `evidence` (jsonb), `actor`, `created_at`. Never updated, never deleted.

### `outbox` — tuple sync to OpenFGA

`id`, `aggregate`, `event_type`, `payload` (jsonb), `created_at`, `processed_at`, `attempts`, `last_error`.

**Save rule:** any domain write that should produce an OpenFGA tuple writes the domain row **and** the outbox row in one `Bun.sql` transaction. Never write a tuple directly from a request handler — that is a dual write and it will drift.

### Better Auth tables

`session`, `account`, `verification`, `jwks`, `oauthApplication`, `oauthAccessToken`, `oauthConsent`, `ssoProvider`, `twoFactor` and friends are owned by Better Auth. **Generate them with the CLI. Never hand-edit their schema.** Extend via `user.additionalFields`, not by altering tables.

---

## API contracts

Pinned paths and methods. Do not rename, do not change the verb, do not invent new paths without a plan that says so.

**Better Auth owns `/api/auth/*`** — mounted as a catch-all. Do not write handlers inside that prefix.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/.well-known/openid-configuration` | discovery |
| GET | `/api/auth/jwks` | public keys for resource servers |
| GET | `/api/auth/oauth2/authorize` | authorization code + PKCE |
| POST | `/api/auth/oauth2/token` | token exchange and refresh |
| POST | `/api/auth/oauth2/introspect` | privileged endpoints only |
| POST | `/api/auth/oauth2/revoke` | revocation |
| GET | `/api/auth/oauth2/userinfo` | claims, including the alias list |

**Ours:**

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/identity/resolve` | handle → user, for the login screen |
| GET | `/api/identity/me/aliases` | list caller's aliases |
| POST | `/api/identity/me/aliases` | add an alias, starts OTP verification |
| POST | `/api/identity/me/aliases/verify` | confirm an alias with an OTP |
| DELETE | `/api/identity/me/aliases/:id` | remove a non-primary alias |
| POST | `/api/admin/merge` | merge two users, admin only |
| POST | `/api/admin/access` | grant or revoke product access |
| POST | `/api/internal/provision` | Salesforce Lead-conversion callout |
| POST | `/api/internal/vendors/:id/verify-domain` | DNS domain check |
| GET | `/health` | liveness, no auth, no DB |
| GET | `/ready` | readiness — checks Postgres and Redis |

`/api/internal/*` is never reachable from the public internet. Signed requests plus network allowlist.

---

## Security

Non-negotiable. Applies to every route without being restated.

**Never reaches the browser or a client app:** database credentials, the Better Auth secret, JWKS private keys, the Salesforce integration secret, SMS/email provider keys, OpenFGA store credentials, vendor SAML signing keys, the pairwise secret.

**Rules**

1. **Only verified identities authenticate.** Restated here because it is the highest-consequence rule in the system.
2. `/api/identity/resolve` must return an **identical response shape and timing for hit and miss.** It is a user-enumeration oracle otherwise. Rate limit per IP and per handle.
3. Access tokens: **JWT only**, 5–15 minute TTL. Resource servers verify via JWKS. Reject opaque tokens.
4. Refresh tokens rotate on every use. Reuse of a rotated token revokes the whole family.
5. Revoke sessions **and** refresh tokens on: ban, suspend, password change, and every merge.
6. **Never enable pairwise subject identifiers.** Every product must see the same `sub`.
7. Alias linking OTPs go to the **already-verified** handle, never the newly claimed one.
8. Vendor SSO stays scoped to Masterclass. A vendor IdP can never mint LMS or admin access. Never auto-link a federated login to an existing password account by email alone.
9. All secrets from validated config. No literal secret in source, tests, fixtures, or a log line.
10. Never log a token, OTP, password, hash, or full phone number. Log the user id.
11. Salesforce provisioning creates `status='invited'` users with **unverified** identities. Lead conversion is not identity verification.
12. Every `/api/admin/*` and `/api/internal/*` route needs an explicit authorization check in the handler. There is no implicit default.

---

## Code standards

- TypeScript strict. **No `any`.** No `as` to silence the compiler — if a cast seems necessary, the type is wrong; fix the type.
- Explicit return types on exported functions.
- Small functions. If it needs a comment to explain *what* it does, split it. Comments explain *why*.
- `type` over `interface` unless declaration merging is genuinely needed.
- No default exports except where a framework demands it.
- Validate every external input with zod at the boundary — HTTP bodies, webhook payloads, env vars, SAML attributes. Inside the boundary, trust the types.
- Errors: typed error classes in `lib/errors.ts`. Never `throw new Error("string")`. Never swallow an error to make a test pass.
- No new dependency without checking the stack table and saying so in the plan.
- **Change only what the task needs.** No drive-by refactors, no reformatting untouched files, no renaming things you happened to read.
- No `console.log` left behind. Structured logging, or nothing.
- Tests alongside behaviour: every auth path gets a negative test. "Vendor A cannot read vendor B" is a test, not an assumption.

---

## Checks to run

```bash
bun run typecheck   # tsc --noEmit
bun test            # bun's runner, 80% line and function coverage floor
bun audit           # dependency advisories
bun run check       # all three
```

A task is not done until all three pass. Do not report success with a failing check and a plan to fix it later.

---

## Fallback rule

When this file does not cover the situation:

1. Keep the change as small as possible.
2. Ask **one** focused question. Not a list.
3. Write the plan to `prompts/`, including the assumption you would otherwise have made silently.
4. Get approval.
5. Then build.

Never make a large independent architectural call because you hit something unexpected. Stop and ask.

**Rule of thumb:** if you would have to repeat it in more than one prompt, it belongs in this file. Propose the addition.

---

## Build-in-order roadmap

Each step is its own prompt and its own approved plan. Verify before starting the next. This is a backend service, so the ordering differs from a UI-first product.

| # | Step | Why here |
|---|---|---|
| 1 | **Config + skeleton** — `lib/config.ts` with zod, `Bun.serve` routes, `/health`, `/ready` | Everything downstream reads config. Get it typed and validated first. |
| 2 | **Database + data model** — migrations for the tables above, `Bun.sql` client, transaction helper | The source of truth. Lock the shape before anything depends on it. |
| 3 | **Better Auth core** — one `auth.ts`, `pg` Pool, email+password, `Bun.password` hasher, CLI-generated schema | Identity exists before anything can authorise. |
| 4 | **Alias identity model** — `user_identity`, resolve endpoint, verification, add/remove | The core domain problem. Before OAuth, so tokens carry the right `sub` from day one. |
| 5 | **Passwordless** — email OTP and SMS OTP wired to the alias resolver | Needs step 4 to know which handle to send to. |
| 6 | **OAuth provider** — `oauth-provider` + `jwt`, trusted clients, JWKS, claims | Now there is a stable identity to issue tokens about. |
| 7 | **RBAC** — `user_product_access`, role claims, admin grant/revoke | Layer 1 authorization. Unblocks the first product integration. |
| 8 | **First product integration** — Masterclass web, legacy login behind a flag | Smallest, newest, most SSO-motivated. Real traffic, reversible. |
| 9 | **Legacy import** — hash import, multi-format verifier, dedup passes, merge, reconciliation | Needs the model proven by a real integration first. |
| 10 | **Vendor SSO** — `@better-auth/sso`, DNS domain verification, JIT scoped to Masterclass | Depends on RBAC and vendor tables existing. |
| 11 | **Graph authorization** — OpenFGA model, outbox worker, backfill, **shadow mode** | Layer 2. Shadow mode is mandatory, not optional. |
| 12 | **Salesforce** — provisioning callout, `Internal_User_ID__c` back-reference, reverse sync | Depends on a stable provisioning path. |
| 13 | **Remaining products** — LMS, then Miles One (`AUTH_USER_MODEL` migration lands here) | The hardest migrations, done last, with the pattern proven. |
| 14 | **Automation** — `Bun.cron` reconciliation, token cleanup, drain reports | Automate only after the manual flow works end to end. |
| 15 | **Deploy, then harden** — two instances, Redis cache, OIDC conformance suite, load test | Some things only fail in production. Deploy is part of finishing. |

Do not jump ahead. Building step 11 before step 7 means modelling authorization against roles that do not exist yet.
