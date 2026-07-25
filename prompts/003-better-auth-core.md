# 003 — Better Auth core instance and schema

**Status:** approved · implemented · verified against a live PostgreSQL + Redis
**Roadmap step:** 3 of 15

---

## Goal

Stand up the single `betterAuth()` instance (`src/auth.ts`) with email+password over `Bun.password`, the three server-controlled `additionalFields`, DB-backed sessions cached in Redis, mount it at `/api/auth/*`, generate its schema with the CLI, and add the FK constraints from our tables to `"user"` that step 2 deferred.

## What it read

**Skills**

- `.agents/skills/better-auth.md` — one instance in one file; Better Auth needs a `pg` `Pool` (Kysely), the single allowed `pg` use; wire password to `Bun.password` (`hash` → argon2id, `verify` → auto-detects argon2/bcrypt); extend the user via `additionalFields` with `input:false`, never by altering BA tables; DB-backed sessions with `Bun.redis` behind `secondaryStorage`; `experimental:{joins:true}` for `/get-session`; **do not** add `oauthProvider`/`jwt`/OTP/2FA/`admin`/`sso` yet (later steps); schema via `bunx auth generate` / `migrate`, review before applying.
- `.agents/skills/postgres-migrations.md` — two migration owners kept strictly separate; our migrations are forward-only, four-digit, one concern per file; every FK gets an index (already created in step 2); `CONCURRENTLY` only matters on populated tables (ours are empty); `"user"` is a reserved word, always quoted.
- `.agents/skills/security.md` — `BETTER_AUTH_SECRET`, DB creds, JWKS keys never leave the server or reach a log; never log tokens/OTP/passwords/hashes; access tokens are a later step; **only `is_verified=true` may authenticate** (enforced in step 4's query, not here); password hashes are argon2id.

**Files opened**

- `AGENTS.md` — roadmap step 3 scope; the `user` table columns (`salesforce_contact_id` unique/nullable, `status`, `merged_into_user_id`); "Never hand-edit a Better Auth table — extend via `additionalFields`"; `/api/auth/*` is a BA catch-all, no handlers inside it; the one `pg` exception.
- `src/lib/config.ts` — `DATABASE_URL`, `BETTER_AUTH_SECRET` (≥32), `BETTER_AUTH_URL` all tier-1 validated. Read only here; `getConfig()` is the accessor.
- `src/lib/redis.ts` — exports Bun's `redis`; comment already says "Session secondary storage arrives in step 3."
- `src/index.ts` — `Bun.serve` with `routes`; comment says the BA catch-all "arrives in step 3."
- `src/db/migrate.ts` / `tests/helpers/database.ts` — forward-only runner; the harness applies **our** migrations to a disposable schema; it does **not** create BA tables. This is the reason the FK work ripples into tests (below).
- `src/db/migrations/0002…0006` + `prompts/002-*.md` — our five tables were created with `user_id text NOT NULL` and **no FK**, explicitly deferring every FK to "a step-3 migration once `bunx auth migrate` has created `\"user\"`" (approved assumption 1, option A). Indexes on all FK columns already exist (`ix_identity_user`, the access indexes, the merge-log indexes). Constraint tests currently insert identities with fabricated `user_id`s (`usr_1`, `usr_2`) that no `"user"` row backs.
- `node_modules/@better-auth/core` types — confirmed the exact option shapes used below: `emailAndPassword.password.hash:(pw)=>Promise<string>` / `verify:({password,hash})=>Promise<boolean>`; `user.additionalFields: Record<string,DBFieldAttribute>` where `DBFieldAttribute` supports `fieldName`, `input`, `unique`, `defaultValue`; `secondaryStorage:{get,set,delete}`; `experimental.joins:boolean`; `session.storeSessionInDatabase:boolean`; `database` accepts a `pg` `Pool`.

## Decisions taken (from the two clarifying questions)

1. **Core only.** Email+password core and its schema. `oauthProvider`, `jwt`, `emailOTP`, `phoneNumber`, `twoFactor`, `admin`, `sso` stay in roadmap steps 5/6/10. Reason: AGENTS.md "build in order, do not jump ahead."
2. **Defer legacy hashes to step 9.** `verify()` calls `Bun.password.verify` only (argon2id + bcrypt auto-detected). No `verifyDjangoPbkdf2`, no rehash-on-login after-hook, no `imported_hash_algo` — nothing produces a Django PBKDF2 hash until the step-9 import, so building the branch now is dead, untestable code.

## Assumptions

1. **`additionalFields` map to snake_case columns via per-field `fieldName`.** `salesforceContactId → salesforce_contact_id`, `mergedIntoUserId → merged_into_user_id`; `status` is already lowercase. This matches the `user` columns in the AGENTS.md data model and the merge query in the postgres-migrations skill (`UPDATE "user" SET status=…, merged_into_user_id=…`). Better Auth's own base columns keep BA's defaults (camelCase) — we never query those from `Bun.sql`, and re-casing them would mean wrapping the `pg` Pool in adapter-config form for no benefit. All three declared now so the BA-owned `user` table carries them from creation; a later step must never `ALTER` a BA table to add them.
2. **All three `additionalFields` are `input:false`** (server-controlled, per the skill). `salesforceContactId` is `unique:true` (nullable-unique — Postgres allows many NULLs). `status` gets `defaultValue:"active"` so a plain email+password signup is a valid active user; the `invited` status for Salesforce provisioning is a step-12 concern.
3. **DB-backed sessions + Redis cache, both.** `session.storeSessionInDatabase:true` keeps Postgres the source of truth (revocation = deleting a row, per the skill), and `secondaryStorage` puts `Bun.redis` in front so page views don't each hit Postgres. `getAndDelete` (single-use consume) is not wired — no OTP/verification consume path exists until step 5.
4. **The FK migration is `0007_add_user_foreign_keys.sql`** (0006 is `outbox`). It adds FKs from **our** tables to `"user"`; no new indexes (they exist from step 2). No FK on `granted_by` (may be a non-user system actor) and no self-FK on `user.merged_into_user_id` (users are never hard-deleted, so integrity holds; the merge writer sets a valid survivor id in step 9) — consistent with step 2's treatment.
5. **Deploy/CI order for step 3:** `bunx auth migrate` (creates `user`/`session`/`account`/`verification`) **then** `bun run db:migrate` (applies `0007`, which references `"user"`). Documented in the verification section.
6. **The test harness gains the Better Auth schema.** Because `0007` and the FK/constraint tests now reference `"user"`, `tests/helpers/database.ts` must create the BA tables in the disposable schema before applying our migrations. Source: the reviewed `bunx auth generate` output, committed to `src/db/better-auth-schema.sql` as a generated, reviewed reference + test fixture (regenerated whenever `src/auth.ts` changes; never hand-edited). This is the honest option — FK and integration tests run against the real `"user"`, not a stub.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/auth.ts` | create | the single `betterAuth()` instance — `pg` Pool, secret/baseURL, `Bun.password` hasher, three `additionalFields`, DB sessions + Redis `secondaryStorage`, `experimental.joins` |
| `src/index.ts` | modify | mount `"/api/auth/*": req => auth.handler(req)` alongside `/health`, `/ready` |
| `src/db/migrations/0007_add_user_foreign_keys.sql` | create | FKs: `user_identity.user_id`, `user_product_access.user_id`, `identity_merge_log.survivor_user_id`, `identity_merge_log.merged_user_id` → `"user"(id)` |
| `src/db/better-auth-schema.sql` | create | committed reviewed output of `bunx auth generate` — reference + test fixture |
| `tests/helpers/database.ts` | modify | apply `better-auth-schema.sql` into the disposable schema before our migrations; add an `insertUser()` helper |
| `tests/auth/instance.test.ts` | create | password hashing (argon2id) positive+negative; sign-up→sign-in→bad-password integration; secret never in a response/log |
| `tests/db/constraints.test.ts` | modify | seed a real `"user"` row before inserting identities/access/merge-log; add FK-rejection + cascade tests |
| `tests/db/migrate.test.ts` | modify | pre-create the BA schema so runs that apply the real migration set reach `0007` |

Not touched: `src/lib/*` (config already carries every value), the `0002–0006` migration files (forward-only — immutable), any `services/`/`identity/`/`routes/` file (later steps).

## Implementation requirements

**`src/auth.ts`**

1. `database: new Pool({ connectionString: getConfig().DATABASE_URL })` — the one sanctioned `pg` use. `baseURL: BETTER_AUTH_URL`, `secret: BETTER_AUTH_SECRET`.
2. `experimental: { joins: true }`.
3. `emailAndPassword: { enabled: true, password: { hash: pw => Bun.password.hash(pw), verify: ({ hash, password }) => Bun.password.verify(password, hash) } }`.
4. `user.additionalFields`:
   - `salesforceContactId`: `{ type:"string", required:false, input:false, unique:true, fieldName:"salesforce_contact_id" }`
   - `status`: `{ type:"string", required:false, input:false, defaultValue:"active" }`
   - `mergedIntoUserId`: `{ type:"string", required:false, input:false, fieldName:"merged_into_user_id" }`
5. `session: { storeSessionInDatabase: true }`.
6. `secondaryStorage: { get, set, delete }` over `Bun.redis` — `set` honours the TTL (SET … EX ttl, falling back to `expire` if Bun's `set` overload doesn't take options). Never logs a key or value.
7. Export `auth` (named). No default export. No second `betterAuth()` anywhere.

**`src/index.ts`**

8. Add `"/api/auth/*": req => auth.handler(req)` to `routes`. `/health` and `/ready` stay more-specific and keep matching. No logic added to the route.

**`0007_add_user_foreign_keys.sql`**

9. Four `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY … REFERENCES "user"(id)`: identity + access `ON DELETE CASCADE`; both merge-log columns default (no cascade — preserve the audit row). Header comment records why FKs arrive here and not in step 2.

**Schema generation**

10. Run `bunx auth generate`; review the SQL (expect `user` with the three snake_case columns + `salesforce_contact_id` unique, `session`, `account`, `verification`); commit it to `src/db/better-auth-schema.sql`; apply to a real DB with `bunx auth migrate`.

**Tests** — see the section below.

## Data model impact

- **Better Auth tables** (`user`, `session`, `account`, `verification`) created by `bunx auth migrate`. `user` carries `salesforce_contact_id` (unique), `status`, `merged_into_user_id`. Owned by BA; never hand-edited.
- **Our migration `0007`** adds four FK constraints to `"user"`. No new tables, columns, or indexes.
- Save rules enforced here: `salesforce_contact_id` uniqueness (BA `unique:true`); referential integrity user↔identity/access/merge (FKs). "Only verified may authenticate" is **not** enforced in this step — it is the step-4 lookup's job; this step deliberately does not add a login path beyond BA's own.

## Security requirements

- **Server-only, touched here:** `DATABASE_URL`, `BETTER_AUTH_SECRET`. Passed into `betterAuth()`, never logged, never in a response, never in `better-auth-schema.sql` or a test fixture. `redactedSummary()` (the boot log) already excludes them.
- **Passwords:** argon2id via `Bun.password.hash`; plaintext never stored or logged. `verify` returns boolean only.
- **Takeover paths:** path 1 ("unverified alias can log in") is *not opened* here because this step adds no custom login query — BA's email+password checks its own `account`/`user` rows, and the alias/`is_verified` gate lands in step 4. The negative test below asserts a bad password fails. Paths 2–4 are later steps.
- **Enumeration:** no `/api/identity/resolve` yet; BA's own sign-in error shape is its default. Rate limiting is BA's global default; tightening `resolve` is step 4.
- **Authorization:** no `/api/admin/*` or `/api/internal/*` route added.

## Authorization impact

None. No RBAC read/write, no OpenFGA model or tuples, no outbox events. `user_product_access` remains unread (step 7).

## Bun-native check

**New dependencies: none.** `better-auth`, `@better-auth/oauth-provider`, `@better-auth/sso`, `pg` are already in `package.json`; only `better-auth` + `pg` are imported this step. `Bun.password` (hashing), `Bun.redis` (session cache), `Bun.serve` (mount) — all native. `pg` `Pool` is the one documented exception, used solely to hand Better Auth a database.

## Acceptance criteria

- [ ] `src/auth.ts` exports exactly one `betterAuth()` instance; `grep -rc "betterAuth(" src` → 1
- [ ] `bunx auth generate` produces `user`/`session`/`account`/`verification`; `user` has `salesforce_contact_id` (unique), `status`, `merged_into_user_id`
- [ ] `bunx auth migrate` then `bun run db:migrate` applies `0007`; the four FKs exist
- [ ] Passwords hash to argon2id (`$argon2id$…`); `verify` accepts the right password and rejects a wrong one
- [ ] Sign-up then sign-in succeeds; sign-in with a wrong password fails; no secret/hash/token appears in any response body
- [ ] Inserting `user_identity` with a `user_id` that has no `"user"` row → rejected by `fk_identity_user`
- [ ] Deleting a `"user"` row cascades its `user_identity` rows
- [ ] `bun run check` — typecheck + tests pass at ≥80% line/func; `bun audit` shows only the pre-existing `@better-auth/oauth-provider` finding, nothing new

## Tests to add

**`tests/auth/instance.test.ts`**

- [ ] `hashes passwords with argon2id` — `Bun.password.hash` output starts `$argon2id$`
- [ ] `verifies a correct password / rejects a wrong password` — negative
- [ ] `signs up then signs in a user` — through `auth.handler`, real DB (BA schema + our migrations)
- [ ] `rejects sign-in with a wrong password` — negative, the auth guarantee
- [ ] `never returns the secret or the password hash in a response` — security property, not just a 200

**`tests/db/constraints.test.ts`** (additions)

- [ ] `rejects an identity whose user_id has no user row` — `fk_identity_user`
- [ ] `cascades identities when a user is deleted`
- [ ] `rejects access/merge-log rows referencing a missing user`

**`tests/helpers/database.ts`** — `insertUser(sql, id?)` inserting a valid BA `"user"` row; harness applies `better-auth-schema.sql` first.

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun audit` — expect only the known `@better-auth/oauth-provider` finding
- [ ] `bunx auth migrate` then `bun run db:migrate` on a staging clone

## How to verify it

```bash
# 0. Postgres + Redis up; DATABASE_URL / REDIS_URL / BETTER_AUTH_* set

# 1. Generate + review + apply the BA schema, then our FKs
bunx auth generate
   → SQL for user/session/account/verification; review, commit to src/db/better-auth-schema.sql
bunx auth migrate
bun run db:migrate
   → 0007 applied; the four FK constraints present

# 2. Checks
bun run check
   → typecheck clean; suites pass ≥80%; audit = only the known oauth-provider finding

# 3. Password is argon2id, verified end to end
bun --hot src/index.ts
curl -s -X POST localhost:3000/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.com","password":"correct horse battery","name":"A"}'
   → 200; body carries NO password hash, NO secret
psql … -c "select left(password,9) from account limit 1;"
   → $argon2id                                   ← SECURITY: argon2id at rest

# 4. SECURITY — wrong password fails
curl -s -X POST localhost:3000/api/auth/sign-in/email \
  -H 'content-type: application/json' -d '{"email":"a@b.com","password":"wrong"}'
   → 401 / invalid credentials, no user disclosure

# 5. SECURITY — referential integrity
psql … -c "insert into user_identity (id,user_id,type,value,source,created_at)
            values ('idt_x','usr_missing','email','x@y.com','self',now());"
   → ERROR: violates foreign key constraint fk_identity_user

# 6. SECURITY — no secret leaked in generated schema or logs
grep -c "$BETTER_AUTH_SECRET" src/db/better-auth-schema.sql
   → 0
```

Steps 3–6 verify security properties (hash-at-rest, wrong-password failure, FK integrity, no-secret-leak), not just a 200.

## Out of scope for this task

- `oauthProvider`, `jwt`, `emailOTP`, `phoneNumber`, `twoFactor`, `admin`, `sso` and their tables — steps 5/6/10
- Any alias-resolution / `is_verified` login gate, `/api/identity/*` — step 4
- Django PBKDF2 verify, rehash-on-login, `imported_hash_algo` — step 9
- Access-token TTL/claims, JWKS, introspection, refresh rotation — step 6
- Closing the `pg` Pool on shutdown (process exit releases it; revisit if a leak shows)
- `getAndDelete` on `secondaryStorage` (single-use consume) — step 5

---

# Outcome

Implemented as approved. Verified against a live **PostgreSQL 18** + **Redis** — the
schema was generated, reviewed, applied, and a real sign-up round-tripped.

**Tests:** `bun test` → **139 pass, 0 fail, ~93% line coverage** (floor 80%), including
with a Redis server running on `localhost:6379`. `bun audit` reports only the known
`@better-auth/oauth-provider` finding carried from step 1.

A latent step-1 bug surfaced while verifying on a machine with Redis actually running:
`pingRedis` probed Bun's shared `redis` client, which resolves `REDIS_URL` once at
construction and never re-resolves it — so the readiness probe reported a stale
connection and the two "datastore unreachable" health tests failed (they set
`REDIS_URL` to an unroutable port, which the shared client ignored). Fixed in
`src/lib/redis.ts` (deviation 6): the probe now opens a short-lived, fail-fast client
at the current `REDIS_URL`, mirroring `pingPostgres`, whose `Bun.sql` client already
resolves the live `DATABASE_URL`. This makes readiness reflect real reachability, not a
cached socket.

**Live verification (`bun run` against the migrated dev DB):**
```
sign-up status: 200 | leaks $argon2 in body: false
stored hash prefix: $argon2id            ← Better Auth uses our hasher, not scrypt
wrong-password sign-in status: 401       ← the auth guarantee
FK: insert identity with a missing user  → ERROR fk_identity_user
```

## Decisions taken

Both clarifying answers honoured: **core only** (no OAuth/JWT/OTP/2FA/admin/SSO) and
**Django PBKDF2 deferred to step 9**. The generated schema is `user` / `session` /
`account` — Better Auth omits `verification` until a verification flow is enabled
(step 5's OTP / a reset flow), so it is correctly absent here.

## Deviations from the plan

| # | Change | Why |
|---|---|---|
| 1 | Schema generated by a Bun script `src/db/auth-schema.ts`, not `bunx auth generate` | The Better Auth CLI loads the config with **jiti under Node**, which has no `Bun` global and cannot resolve `import … from "bun"` or `Bun.env`/`Bun.password`. `getMigrations()` from `better-auth/db/migration` is the exact routine the CLI runs internally; called from Bun it has every native API. `package.json` `auth:schema`/`auth:migrate` now point at it. |
| 2 | `secondaryStorage` reaches Redis via a lazy `import("@/lib/redis")` inside the callbacks | Same jiti constraint — a top-level `bun` import in the config's module graph breaks even the programmatic path's type-loading. The callbacks are never evaluated during generation; the Bun runtime resolves and caches the import on first session op. |
| 3 | No HTTP sign-up/sign-in integration test; wiring proven at the config level instead | A real sign-up connects the shared `Bun.redis` singleton (via `secondaryStorage`), which cannot be reset (`close()` does not reconnect), polluting the step-1 health probes that share it. The config-level tests assert the exact argon2id hasher, `input:false` fields, snake_case `fieldName`s, and DB-backed sessions with **no** datastore/HTTP coupling; the end-to-end argon2id-at-rest property is verified live (above). |
| 4 | `tests/db/migrate.test.ts` migrate client is `max: 1` | Exposed, not introduced, by this step: `runMigrate`'s session-level `pg_advisory_lock`/unlock can split across pooled connections and leak the lock in a long-lived process. The one-shot `db:migrate` is immune (it exits); the test process is not. A single connection pairs lock and unlock. Commented in place. |
| 5 | Test harness + `constraints`/`migrate` tests seed a real `"user"` and apply `better-auth-schema.sql` | Direct consequence of the approved FK migration (0007): a fabricated `user_id` is now rejected, so tests must back it with a real row, and FK-bearing migrations need `"user"` to exist. |
| 6 | `pingRedis` probes a short-lived client at the current `REDIS_URL` (step-1 `src/lib/redis.ts`) | Fixed at the user's request: the two "unreachable" health tests failed on a machine with Redis running because the shared `redis` client binds `REDIS_URL` once and never re-resolves it, so readiness could not report "down". Now mirrors `pingPostgres`. |
