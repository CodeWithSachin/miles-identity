# 002 — Database layer and data model

**Status:** approved · implemented · verified against PostgreSQL 18.4
**Roadmap step:** 2 of 15

---

## Goal

Create the migration runner and the five tables Miles Identity owns, with every save rule from AGENTS.md enforced as a database constraint rather than only in application code.

## What it read

**Skills**

- `.agents/skills/postgres-migrations.md` — two migration owners kept separate (Better Auth CLI vs our `src/db/migrations/`); forward-only, one concern per file, four-digit monotonic names; `timestamptz` never `timestamp`; `text` never `varchar(n)`; every FK gets an index; `CREATE INDEX CONCURRENTLY` on populated tables; **put invariants in the schema, not only in code**; use `tx` never the outer `sql` inside a transaction callback; keyset pagination for batch jobs; outbox claimed with `FOR UPDATE SKIP LOCKED`; Better Auth's `pg` Pool is a *second* pool in the same process.
- `.agents/skills/alias-identity.md` — normalise before the query, never on read; email trim+lowercase but **do not** strip Gmail dots or `+tags`; phone E.164; only `is_verified = true` may authenticate; exactly one primary per (user, type); `UNIQUE (type, value)` globally; merges never delete, they set `status='merged'` and `merged_into_user_id`; the nine invariants listed as tests.

**Files inspected**

- `src/db/client.ts` — exports `sql` (Bun's default client) and `pingPostgres()`. No transaction helper yet, no query modules.
- `src/db/migrations/` — **empty except `.gitkeep`. No migration exists.** Confirmed there is no `CREATE TABLE` anywhere in `src/`.
- `package.json` — `db:migrate` → `src/db/migrate.ts`, `db:seed` → `src/db/seed.ts`. **Both scripts currently point at files that do not exist**, so both are broken until this step.
- `AGENTS.md` data model section — re-read all six save rules verbatim; they are the acceptance criteria for this step.
- `src/lib/config.ts` — `DATABASE_URL` validated and available; `Bun.sql` picks it up automatically.
- `src/lib/errors.ts` — `AppError` base with `code`/`httpStatus`/`expose`; needs a `DatabaseError` and a `MigrationError`.

## Assumptions

**1. The `user` table does not exist yet, so our foreign keys cannot be created in this step.**

This is the one real ordering problem and it needs your call. `user` is owned by Better Auth and is created by `bunx auth migrate` in **step 3**. All five of our tables reference `"user"(id)`.

My recommendation — **option A**: create our tables in this step with `user_id text NOT NULL` and **no FK constraint**, then add every FK in a small `0006_add_user_foreign_keys.sql` that runs as part of step 3, after the Better Auth CLI has created `"user"`. Nothing writes rows before step 3, so there is no window where real data lacks integrity, and the constraint arrives before the first insert.

The alternative — **option B** — is to swap the roadmap order: run Better Auth's CLI migration first, then ours, so FKs exist from the start. Cleaner schema history, but it deviates from the approved roadmap and means running the CLI twice (once now, again in step 3 after `additionalFields` are declared).

I will proceed with **A** unless you say otherwise.

**2. `user` must always be written as `"user"` — it is a reserved word in SQL.** Every reference is quoted. An unquoted `user` silently resolves to the `CURRENT_USER` function rather than erroring, which is a genuinely nasty class of bug.

**3. Normalisation gets database-level enforcement, not just writer-level.** The alias skill says "never store an unnormalised value" and "put invariants in the schema". So `CHECK (type <> 'email' OR value = lower(value))` and an E.164 regex check for phones. This makes an un-normalised write impossible rather than merely discouraged. Flag if you would rather keep normalisation purely in the writer — it does mean a badly-written import job fails loudly instead of corrupting quietly, which I consider the point.

**4. `identity_merge_log` append-only is enforced by a trigger**, not by convention. A `BEFORE UPDATE OR DELETE` trigger that raises an exception. Convention does not survive a future feature written at 2am.

**5. The vendor activation rule becomes a CHECK.** `CHECK (status <> 'active' OR domain_verified_at IS NOT NULL)` — a vendor SSO provider cannot be active while its domain is unverified. Directly expressible, so it should be expressed.

**6. Migrations run under a Postgres advisory lock.** Two instances rolling-deploying simultaneously would otherwise both try to apply the same migration. `pg_advisory_lock` on a fixed key, released at the end.

**7. `src/db/seed.ts` is dev-only fixtures and refuses to run when `NODE_ENV=production`.** The script is already referenced by `package.json`, so leaving it absent keeps a broken script in the repo. There is no production seed data — products and roles are CHECK-constraint enums, not rows.

**8. Tests use a disposable schema per run**, per the testing skill: create `test_<random>`, set `search_path`, run migrations, assert, drop. Real Postgres, because a mock cannot reject a duplicate key and the constraint is the thing under test.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/db/migrations/0001_schema_migration.sql` | create | the migration ledger table itself |
| `src/db/migrations/0002_user_identity.sql` | create | alias table + all invariants |
| `src/db/migrations/0003_vendor.sql` | create | vendor + activation CHECK |
| `src/db/migrations/0004_user_product_access.sql` | create | coarse RBAC + vendor_id CHECK |
| `src/db/migrations/0005_identity_merge_log.sql` | create | append-only audit + trigger |
| `src/db/migrations/0006_outbox.sql` | create | outbox + partial pending index |
| `src/db/migrate.ts` | create | runner: advisory lock, ledger, forward-only, one tx per migration |
| `src/db/seed.ts` | create | dev-only fixtures, production guard |
| `src/db/client.ts` | modify | add `transaction()` helper and `DatabaseError` mapping |
| `src/lib/errors.ts` | modify | add `DatabaseError`, `MigrationError` |
| `src/db/types.ts` | create | row types for the five tables, plus the enum unions |
| `tests/db/migrate.test.ts` | create | runner behaviour: idempotence, ordering, lock, failure rollback |
| `tests/db/constraints.test.ts` | create | every save rule asserted as a rejected write |
| `tests/helpers/database.ts` | create | disposable-schema harness |
| `src/db/migrations/.gitkeep` | delete | directory now has real files |

Not touched: `src/auth.ts` (does not exist), `src/index.ts`, `src/routes/`, `src/services/`, anything in step 1.

## Implementation requirements

**Migration ledger — `0001`**

1. `schema_migration (version text PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), checksum text NOT NULL)`.
2. `checksum` is a SHA-256 of the file contents via `Bun.CryptoHasher`. The runner refuses to proceed if an **already-applied** migration's file has changed — forward-only means an applied file is immutable.

**`user_identity` — `0002`**

3. Columns per AGENTS.md: `id`, `user_id`, `type`, `value`, `is_primary`, `is_verified`, `source`, `verified_at`, `created_at`.
4. `CONSTRAINT uq_identity_value UNIQUE (type, value)` — a handle belongs to exactly one user, globally.
5. `CREATE UNIQUE INDEX uq_primary_per_type ON user_identity (user_id, type) WHERE is_primary` — exactly one primary per type.
6. `CREATE INDEX ix_identity_lookup ON user_identity (type, value) WHERE is_verified` — the login hot path, and partial so it only indexes rows that may authenticate.
7. `CREATE INDEX ix_identity_user ON user_identity (user_id)` — FK index.
8. `CHECK (type IN ('email','phone'))`, `CHECK (source IN ('lms','miles_one','masterclass','salesforce','self'))`.
9. `CHECK ((is_verified = false AND verified_at IS NULL) OR (is_verified = true AND verified_at IS NOT NULL))`.
10. `CHECK (type <> 'email' OR value = lower(btrim(value)))` — normalisation enforced.
11. `CHECK (type <> 'phone' OR value ~ '^\+[1-9][0-9]{7,14}$')` — E.164 enforced.
12. `CHECK (length(value) > 0)`.

**`vendor` — `0003`**

13. `id`, `name`, `sso_provider_id`, `allowed_email_domains text[] NOT NULL DEFAULT '{}'`, `domain_verified_at`, `status`, `created_at`, `updated_at`.
14. `CHECK (status IN ('pending','active','disabled'))`.
15. `CHECK (status <> 'active' OR domain_verified_at IS NOT NULL)` — the activation save rule.
16. `UNIQUE (name)`; `UNIQUE (sso_provider_id)` where not null.

**`user_product_access` — `0004`**

17. `id`, `user_id`, `product_id`, `role`, `vendor_id`, `status`, `granted_by`, `granted_at`, `revoked_at`.
18. `UNIQUE (user_id, product_id, role)`.
19. `CHECK (product_id IN ('lms','miles_one','masterclass'))`.
20. `CHECK (role IN ('CPA','CMA','CAIRA','ADMIN','NORMAL','VENDOR','VENDOR_ADMIN'))`.
21. `CHECK ((role IN ('VENDOR','VENDOR_ADMIN') AND vendor_id IS NOT NULL) OR (role NOT IN ('VENDOR','VENDOR_ADMIN') AND vendor_id IS NULL))` — vendor roles are vendor-scoped, non-vendor roles are not.
22. `CHECK (status IN ('active','revoked'))`, and `CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)`.
23. FK `vendor_id → vendor(id)`, plus indexes on `user_id`, `vendor_id`, and `(product_id, role)`.
24. Revocation is a status change. **No `DELETE` path in any query module.**

**`identity_merge_log` — `0005`**

25. `id`, `survivor_user_id`, `merged_user_id`, `tier`, `evidence jsonb NOT NULL`, `actor`, `created_at`.
26. `CHECK (tier IN ('A','B','C','D','E'))` — the confidence tiers from the alias skill.
27. `CHECK (survivor_user_id <> merged_user_id)`.
28. Trigger `trg_merge_log_append_only` — `BEFORE UPDATE OR DELETE`, raises `EXCEPTION 'identity_merge_log is append-only'`.
29. Indexes on `survivor_user_id` and `merged_user_id` — "which merge produced this user" must be answerable.

**`outbox` — `0006`**

30. `id bigserial PRIMARY KEY`, `aggregate`, `event_type`, `payload jsonb NOT NULL`, `created_at`, `processed_at`, `attempts int NOT NULL DEFAULT 0`, `last_error`.
31. `CREATE INDEX ix_outbox_pending ON outbox (id) WHERE processed_at IS NULL` — partial, so the index stays small as processed rows accumulate.
32. Table and indexes only. **The worker is step 11.**

**Runner — `src/db/migrate.ts`**

33. Discover `src/db/migrations/*.sql` with `Bun.Glob`, sort by filename. Refuse to start if two files share a version prefix.
34. Take `pg_advisory_lock(<fixed key>)` before reading the ledger; release in a `finally`.
35. For each unapplied migration: run the file **and** its ledger insert in one transaction, so a failure leaves nothing half-applied.
36. Verify the checksum of every already-applied migration. Mismatch → `MigrationError` naming the file, exit non-zero, apply nothing.
37. Log one line per applied migration and a final summary. Never log `DATABASE_URL`.
38. Idempotent: a second run applies nothing and exits 0.
39. `--dry-run` prints the pending list without applying. A production migration should be previewable.

**Client — `src/db/client.ts`**

40. Add `transaction<T>(fn: (tx) => Promise<T>): Promise<T>` wrapping `sql.begin`, mapping failures to `DatabaseError` while preserving `cause`.
41. Document in a comment that the callback must use `tx`, never the outer `sql`.

**Types — `src/db/types.ts`**

42. Row types and the enum unions (`IdentityType`, `IdentitySource`, `ProductId`, `Role`, `VendorStatus`, `MergeTier`) exported as `const` arrays plus derived unions, so the CHECK lists and the TypeScript unions have one source.

## Data model impact

This step **is** the data model impact. Six migrations, `0001`–`0006`. Five tables plus the ledger. FKs to `"user"` deferred to a step-3 migration per assumption 1.

Save rules and where each is enforced:

| Save rule (AGENTS.md) | Enforced |
|---|---|
| `UNIQUE (type, value)` globally | schema — unique constraint |
| Exactly one primary per (user, type) | schema — partial unique index |
| Never store an unnormalised value | schema — CHECK on email lowercase and phone E.164 |
| `verified_at` set iff `is_verified` | schema — CHECK |
| Only verified may authenticate | schema *supports* it (partial index); **enforced in the query layer in step 4** |
| Vendor cannot activate while domain unverified | schema — CHECK |
| Never hard-delete a user | schema cannot express it; no DELETE in any query module, asserted by review |
| `identity_merge_log` never updated or deleted | schema — trigger |
| Domain write + outbox in one transaction | `transaction()` helper; enforced by review and by step 11's tests |

## Security requirements

**Stays server-side:** `DATABASE_URL`. It must not appear in a migration log line, a `MigrationError` message, or a test fixture. The runner logs migration filenames, never the connection target.

**Secrets touched:** `DATABASE_URL` only. No token, key or hash is read or written in this step.

**Takeover paths this step affects — two of the four:**

1. **"Unverified alias can log in."** This step lays the groundwork: the partial index `WHERE is_verified` exists precisely so the step-4 lookup filters on it, and the `verified_at` CHECK makes a half-verified row impossible. The step-4 query is where the rule is actually enforced.
2. **"Vendor asserts a domain it does not own."** The activation CHECK makes an active-but-unverified vendor unrepresentable in the database, so step 10 cannot forget it.

**Additional risks specific to migrations:**

- **SQL identifier injection.** Migration SQL is static file content, never built from input. The test harness creates a schema named from a generated suffix — that suffix must be validated against `^[a-z0-9_]+$` before interpolation, because identifiers cannot be parameterised.
- **A destructive migration.** Forward-only plus checksum verification means an applied file cannot be silently edited. No migration in this step contains `DROP` or `DELETE`.
- **Concurrent runners during a rolling deploy.** The advisory lock is the mitigation.

**Enumeration:** not applicable — no HTTP surface in this step.

**Authorization:** not applicable — no route added. `/health` and `/ready` are unchanged.

## Authorization impact

`user_product_access` is created but **not read or written**. Layer 1 RBAC arrives in step 7. `outbox` is created but has no producer or consumer until step 11. No OpenFGA model, no tuples, no conditions.

## Bun-native check

**New dependencies: none.**

| Used | Instead of |
|---|---|
| `Bun.sql` tagged templates + `sql.begin` | pg for our queries, Drizzle, Prisma, Kysely |
| `Bun.Glob` | glob, fast-glob |
| `Bun.file().text()` | fs.readFile |
| `Bun.CryptoHasher("sha256")` | crypto-js |
| `Bun.randomUUIDv7()` | uuid, nanoid |
| `bun test` + real Postgres | Jest, testcontainers |

No migration framework (no node-pg-migrate, Flyway, Atlas, Liquibase). The runner is ~120 lines of `Bun.sql` and gives us the checksum and advisory-lock behaviour those tools bundle.

## Acceptance criteria

- [ ] `bun run db:migrate` on an empty database applies `0001`–`0006` and exits 0
- [ ] A second `bun run db:migrate` applies nothing and exits 0
- [ ] `bun run db:migrate --dry-run` lists pending migrations without applying them
- [ ] Editing an applied migration file then re-running → non-zero exit naming that file, nothing applied
- [ ] Two concurrent `db:migrate` processes → one applies, the other waits then no-ops; no duplicate ledger rows
- [ ] A deliberately broken migration leaves no partial state and no ledger row
- [ ] Inserting the same `(type, value)` for two different users → rejected
- [ ] A second `is_primary = true` for the same (user, type) → rejected
- [ ] `is_verified = true` with `verified_at = NULL` → rejected
- [ ] `INSERT ... type='email', value='Foo@Bar.com'` → rejected (not lowercased)
- [ ] `INSERT ... type='phone', value='9876543210'` → rejected (not E.164)
- [ ] `type='fax'` → rejected
- [ ] `vendor` with `status='active'` and `domain_verified_at=NULL` → rejected
- [ ] `role='VENDOR'` with `vendor_id=NULL` → rejected; `role='ADMIN'` with a `vendor_id` → rejected
- [ ] `UPDATE` or `DELETE` on `identity_merge_log` → rejected by the trigger
- [ ] `tier='F'` → rejected; `survivor = merged` → rejected
- [ ] `ix_outbox_pending` exists and is partial
- [ ] `bun run check` — typecheck and tests pass; audit still shows the one known `oauth-provider` finding and nothing new

## Tests to add

**`tests/helpers/database.ts`** — `withTestSchema(fn)`: create a disposable schema, validate the generated name against `^[a-z0-9_]+$`, set `search_path`, run migrations, hand back a client, drop in `finally`.

**`tests/db/migrate.test.ts`**

- [ ] `applies all migrations to an empty database`
- [ ] `is idempotent — a second run applies nothing`
- [ ] `applies migrations in filename order`
- [ ] `rejects a changed checksum on an applied migration` — negative
- [ ] `rejects duplicate version prefixes` — negative
- [ ] `rolls back fully when a migration fails` — negative; no partial DDL, no ledger row
- [ ] `serialises concurrent runners via the advisory lock` — two runners, one ledger row each migration
- [ ] `--dry-run applies nothing`
- [ ] `never logs the connection string` — security

**`tests/db/constraints.test.ts`** — each asserts a **rejected** write:

- [ ] `rejects the same handle for two users` — the global uniqueness invariant
- [ ] `rejects a second primary for the same user and type`
- [ ] `allows one primary per type per user` (email + phone both primary)
- [ ] `rejects verified without verified_at`
- [ ] `rejects unverified with verified_at`
- [ ] `rejects a non-lowercased email` — normalisation
- [ ] `rejects an email with surrounding whitespace` — normalisation
- [ ] `rejects a non-E.164 phone` — normalisation
- [ ] `accepts a valid E.164 phone`
- [ ] `rejects an unknown identity type`
- [ ] `rejects an unknown source`
- [ ] `rejects an active vendor with an unverified domain` — the vendor save rule
- [ ] `allows an active vendor once the domain is verified`
- [ ] `rejects a VENDOR role without vendor_id`
- [ ] `rejects a non-vendor role with vendor_id`
- [ ] `rejects a revoked access row without revoked_at`
- [ ] `rejects UPDATE on identity_merge_log`
- [ ] `rejects DELETE on identity_merge_log`
- [ ] `rejects an unknown merge tier`
- [ ] `rejects a merge where survivor equals merged`
- [ ] `confirms ix_outbox_pending exists and is partial`

**`transaction()` helper**

- [ ] `commits on success`
- [ ] `rolls back on throw`
- [ ] `wraps a failure as DatabaseError preserving cause`

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun audit` — expect the one known `@better-auth/oauth-provider` finding, and confirm nothing new
- [ ] `bun run db:migrate` against a real Postgres, twice

## How to verify it

```bash
# 0. Postgres
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres --name mi-pg postgres:16
createdb -h localhost -U postgres miles_identity   # or via psql

# 1. Checks
bun run check
   → typecheck clean; tests pass; audit shows only the known oauth-provider finding

# 2. Migrate
bun run db:migrate
   → 6 lines "applied 000N_…", summary "6 applied, 0 skipped", exit 0
bun run db:migrate
   → "0 applied, 6 skipped", exit 0                       ← idempotent
bun run db:migrate --dry-run
   → "0 pending", exit 0

# 3. Schema is really there
psql -h localhost -U postgres -d miles_identity -c '\dt'
   → schema_migration, user_identity, vendor, user_product_access,
     identity_merge_log, outbox
psql ... -c '\d user_identity'
   → uq_identity_value, uq_primary_per_type (partial), ix_identity_lookup (partial),
     4 CHECK constraints

# 4. SECURITY — normalisation cannot be bypassed
psql ... -c "INSERT INTO user_identity (id,user_id,type,value,source,created_at)
             VALUES ('x','usr_1','email','Foo@Bar.com','self',now());"
   → ERROR: violates check constraint            ← not silently stored mixed-case
psql ... -c "INSERT INTO user_identity (id,user_id,type,value,source,created_at)
             VALUES ('y','usr_1','phone','9876543210','self',now());"
   → ERROR: violates check constraint            ← bare 10-digit rejected

# 5. SECURITY — one handle, one user
psql ... -c "INSERT INTO user_identity (id,user_id,type,value,source,created_at)
             VALUES ('a','usr_1','email','a@b.com','self',now()),
                    ('b','usr_2','email','a@b.com','self',now());"
   → ERROR: duplicate key value violates uq_identity_value

# 6. SECURITY — a vendor cannot be active with an unverified domain
psql ... -c "INSERT INTO vendor (id,name,status,created_at,updated_at)
             VALUES ('v1','Acme','active',now(),now());"
   → ERROR: violates check constraint

# 7. Audit log really is append-only
psql ... -c "UPDATE identity_merge_log SET actor='someone-else';"
   → ERROR: identity_merge_log is append-only

# 8. SECURITY — no connection string in the migration output
bun run db:migrate 2>&1 | grep -c 'postgres://'
   → 0

# 9. Applied migrations are immutable
echo "-- tampered" >> src/db/migrations/0002_user_identity.sql
bun run db:migrate; echo "exit=$?"
   → exit=1, names 0002_user_identity.sql, applies nothing
git checkout src/db/migrations/0002_user_identity.sql
```

Steps 4–8 verify security properties rather than that a table exists. Step 9 verifies forward-only is real.

## Out of scope for this task

- `src/auth.ts`, the `pg` Pool, Better Auth's own tables — step 3
- **FK constraints to `"user"`** — a `0006`-successor migration in step 3, per assumption 1
- Any query module beyond the `transaction()` helper: no `findIdentityByHandle`, no repositories — step 4
- Alias resolution logic, normalisation *functions* (only the CHECK constraints land here) — step 4
- The outbox worker and any tuple write — step 11
- Reading or writing `user_product_access` — step 7
- The legacy import, dedup passes, merge implementation — step 9
- `CREATE INDEX CONCURRENTLY` variants: these tables are empty, so plain `CREATE INDEX` is correct here. Concurrent index builds become mandatory from step 9, when tables carry real rows.
- Connection-pool sizing and PgBouncer — step 15

---

# Outcome

Implemented as approved. **`bun run typecheck` and `bun test` pass: 126 tests, 0 fail, 91.58% funcs / 92.98% lines.** `bun audit` still reports exactly the one known `@better-auth/oauth-provider` finding carried over from step 1 — nothing new.

Verified against a real **PostgreSQL 18.4** instance, not a mock.

## Decisions taken

**Assumption 1 — option A, as recommended.** Our tables carry `user_id text NOT NULL` with no FK. `"user"` does not exist yet; the FKs land in a step-3 migration once `bunx auth migrate` has created it. Both `0002` and `0004` carry a comment saying so, so the omission cannot be mistaken for an oversight.

All other assumptions accepted unchanged, including the two that had an explicit opt-out: schema-level normalisation (assumption 3) and the append-only trigger (assumption 4).

## Deviations from the plan

| # | Change | Why |
|---|---|---|
| 1 | `migrate()` takes optional `client` and `dir` | The first version of the tests reimplemented the runner's ledger logic, because the runner used Bun's default `sql` client and could not be pointed at a test schema. A test that reimplements the code under test proves very little. Injecting the client raised `src/db/migrate.ts` from **26% to 85% line coverage** and made the rollback and checksum tests exercise the real function. Same pattern already approved for readiness in 001. |
| 2 | `tests/db/transaction.test.ts` added as its own file | The plan listed the `transaction()` tests without naming a file. |
| 3 | Seed uses `ARRAY[...]::text[]` rather than a JS array parameter | Found at runtime: `Bun.sql` does not coerce a JS array into a Postgres array literal in that position — it fails with `malformed array literal`. |
| 4 | `Transaction` type is `bun`'s exported `TransactionSQL` | `Parameters<typeof sql.begin>[0]` resolves to the wrong overload under TS 7. |

## Two bugs found by running it, not by reading it

**1. UUIDv7 prefixes are not unique.** The test helper built temp directory names from `Bun.randomUUIDv7().slice(0, 12)`. A v7 UUID leads with a millisecond timestamp, so two calls in the same millisecond produced **the same directory** — the second write overwrote the first, and a checksum test comparing "different" files saw identical content. Now uses the full UUID plus a counter, with a comment explaining why.

Worth carrying forward: `newId()` in `src/db/types.ts` uses full UUIDv7 values, so ids are unaffected. Any future code that truncates a UUIDv7 is wrong.

**2. Cross-file test pollution via `Bun.env`.** `tests/routes/health.test.ts` points `DATABASE_URL` at an unroutable port to exercise the degraded path, and never restored it. `bun test` shares one process across files, so the database suites inherited a dead URL and failed with `Connection closed` — which looked exactly like a Postgres fault and cost real time to diagnose. Two fixes, both correct:

- the database harness now captures `TEST_DATABASE_URL`/`DATABASE_URL` **once at module load**, so it cannot be affected by another suite;
- `routes/health.test.ts` saves and restores both variables in `afterAll`.

Set `TEST_DATABASE_URL` to keep test and dev databases separate.

## Verified behaviour

```
migrate on empty db      → 6 applied, 0 skipped
migrate again            → 0 applied, 6 skipped                 (idempotent)
--dry-run on empty db    → 6 pending, nothing created but the ledger
--dry-run after apply    → 0 pending
seed                     → vendors 1, identities 3

SECURITY — normalisation cannot be bypassed
  email 'Foo@Bar.com'    → REJECTED  ck_identity_email_normalised
  phone '9876543210'     → REJECTED  ck_identity_phone_e164

SECURITY — one handle, one user
  same email, two users  → REJECTED  uq_identity_value

SECURITY — no half-verified identity
  is_verified, no date   → REJECTED  ck_identity_verified_at

SECURITY — vendor scoping
  active, domain unverified → REJECTED  ck_vendor_active_requires_verified_domain
  VENDOR without vendor_id  → REJECTED  ck_access_vendor_scope

audit trail
  UPDATE identity_merge_log → REJECTED  "identity_merge_log is append-only"
  DELETE identity_merge_log → REJECTED  "identity_merge_log is append-only"

forward-only
  edit an applied file, re-run → MigrationError naming 0002_user_identity.sql,
                                 nothing applied
  restore the file, re-run     → 0 applied, 6 skipped

no connection string in migration output → 0 occurrences
```

All 21 constraint assertions from the plan pass, plus schema-shape checks proving every timestamp column is `timestamptz` and no column is `varchar`.

## Note on the sandbox

Postgres had to be started and used within a single shell invocation — each invocation gets a fresh network namespace, so a server started in one is unreachable from the next. Irrelevant to the project, but it explains why the verification commands are one long script rather than a sequence.

## Open, unchanged from step 1

`@better-auth/oauth-provider` `>=1.4.8 <1.7.0-beta.4` — unbound resource indicators, moderate. Still a direct dependency, still unused until step 6, still no audit ignore added. `bun run check` continues to exit 1 on this and nothing else.
