# 001 — Config module and server skeleton

**Status:** approved · implemented · **1 audit finding open (see Outcome)**
**Roadmap step:** 1 of 15

---

## Goal

Give the service a single validated, typed configuration source and a `Bun.serve` entry point exposing `/health` and `/ready`, so every later feature reads config the same way and the process fails fast at boot on misconfiguration.

## What it read

**Skills**

- `.agents/skills/bun-native.md` — `Bun.sql` default client reads `DATABASE_URL` from env automatically; `Bun.redis` has automatic reconnect; env vars must be read in exactly one place; `Bun.serve` native `routes` supports static `Response` objects served without invoking a handler; `Bun.cron` in-process schedules are UTC so `TZ=UTC` must be enforced; TypeScript 7 requires `"types": ["bun"]`.
- `.agents/skills/security.md` — the "never leaves the server" and "never logged" lists; all secrets flow through validated config in `lib/config.ts`; when unsure, ask one question rather than guess on a boundary.

**Files inspected**

- `package.json` — scripts already point at `src/index.ts` (`dev`, `start`, `build`, `compile`), `src/db/migrate.ts`, `src/db/seed.ts`, `src/authz/push-model.ts`. Only `src/index.ts` is in scope here; the other three are later steps.
- `tsconfig.json` — strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `types: ["bun"]`, path alias `@/*` → `src/*`.
- `bunfig.toml` — `linker = "isolated"`, `exact = true`, coverage thresholds 0.8 line / 0.8 function.
- `.env.example` — 30 keys declared. Full list read; grouped into required-now, required-later, and optional below.
- `AGENTS.md` — architecture rules (routes hold no logic, config read once, one `betterAuth()` instance), the `/health` and `/ready` API contract, code standards (no `any`, typed errors in `lib/errors.ts`, no `console.log` left behind).
- `src/`, `tests/` — **empty apart from `.gitkeep` files.** Confirmed: this is a greenfield step with nothing to integrate against.

## Assumptions

1. **`/ready` must check Postgres and Redis, per the AGENTS.md API contract. That requires a connectivity ping, which means creating a minimal DB and Redis client now** — ahead of step 2 (database + data model). I am scoping this to `SELECT 1` and `PING` only: no schema, no migrations, no domain queries. The full query layer stays in step 2. Flag if you would rather `/ready` return `postgres: null` until step 2 lands.
2. **Not every `.env.example` key is required at step 1.** Validating all 30 now would make the process refuse to boot before the SMS gateway or Salesforce credentials exist. I am splitting the schema into three tiers (below). Tier 2 keys are validated when present but not required until their feature lands.
3. **`BETTER_AUTH_SECRET` is required in all environments, including development.** A dev-only fallback secret is the kind of default that reaches production.
4. **`TZ` must be `UTC` and the process refuses to start otherwise.** `Bun.cron` in-process schedules are UTC; a machine on IST would make every later schedule silently wrong by 5h30m. Cheap to enforce now, expensive to discover in step 14.
5. **`/ready` caches its result for 5 seconds.** It is unauthenticated and touches two datastores, so an unthrottled load balancer or a hostile client would otherwise use it to hammer Postgres. Flag if your LB needs sub-second readiness granularity.
6. **Structured logging is a thin local module, not a library.** AGENTS.md says `console` with structured objects until there is a measured reason otherwise.
7. `NODE_ENV` is one of `development` \| `test` \| `production`. No other values.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/lib/config.ts` | create | zod env schema, tiered, parsed once, typed export, fail-fast with redacted errors |
| `src/lib/errors.ts` | create | typed error base + `ConfigError`, `DependencyUnavailableError` |
| `src/lib/logger.ts` | create | structured log helper with a redaction denylist |
| `src/db/client.ts` | create | `Bun.sql` default client re-export + `pingPostgres()` |
| `src/lib/redis.ts` | create | `Bun.redis` client + `pingRedis()` |
| `src/services/health.ts` | create | `checkReadiness()` with 5s cache — the logic `/ready` calls |
| `src/routes/health.ts` | create | thin `/health` and `/ready` handlers |
| `src/index.ts` | create | `Bun.serve` with `routes`, error handler, graceful shutdown |
| `tests/lib/config.test.ts` | create | config validation and redaction tests |
| `tests/lib/logger.test.ts` | create | redaction tests |
| `tests/services/health.test.ts` | create | readiness logic and caching tests |
| `tests/routes/health.test.ts` | create | endpoint behaviour, including `/health` with Postgres down |
| `src/lib/.gitkeep`, `src/db/.gitkeep`, `src/routes/.gitkeep`, `src/services/.gitkeep`, `tests/.gitkeep` | delete | directories now have real files |

No other file is touched. `auth.ts`, `identity/`, `authz/`, `integrations/`, `jobs/` are not created in this task.

## Implementation requirements

**Config — `src/lib/config.ts`**

1. Build a zod schema in three tiers:
   - **Tier 1, required now:** `NODE_ENV` (enum), `PORT` (coerced int 1–65535, default 3000), `TZ` (literal `"UTC"`), `BASE_URL` (url), `DATABASE_URL` (url, must start `postgres://` or `postgresql://`), `REDIS_URL` (url, must start `redis://` or `rediss://`), `BETTER_AUTH_SECRET` (min 32 chars), `BETTER_AUTH_URL` (url).
   - **Tier 2, optional now, validated if present:** `ACCESS_TOKEN_TTL_SECONDS` (coerced int, **max 900**, default 900), `PHONE_PLACEHOLDER_DOMAIN` (default `phone.miles.com`, and must not equal `temp.better-auth.com`), `EMAIL_FROM` (email), the `FGA_*`, `SMS_*`, `SALESFORCE_*`, `LEGACY_*`, `*_CLIENT_SECRET`, `INTERNAL_WEBHOOK_SIGNING_SECRET`, `GOOGLE_*` keys.
   - **Tier 3:** anything not in the schema is ignored, never passed through.
2. Parse `Bun.env` **once** at module load with `safeParse`. Export a frozen typed object as the default surface.
3. On failure: log the **list of failing key names and the reason**, never the received value. Then `process.exit(1)`. A config error is not recoverable and must not be caught and retried.
4. Export a `requireLater(key)` accessor for tier-2 keys that throws `ConfigError` naming the key if read while unset — so step 10 fails loudly at wiring time, not silently at 2am with an undefined SMS key.
5. Export `redactedSummary()` returning tier-1 key **names** plus non-secret values only (`NODE_ENV`, `PORT`, `TZ`, `BASE_URL`), for a single boot log line.
6. `ACCESS_TOKEN_TTL_SECONDS` max of 900 is enforced in the schema, not in a comment. The security rule is 5–15 minutes; make it unrepresentable to exceed.

**Errors — `src/lib/errors.ts`**

7. `AppError` base with `code`, `httpStatus`, `expose: boolean`. `ConfigError` and `DependencyUnavailableError` extend it. No `throw new Error("string")` anywhere in this task.
8. `expose: false` errors must never have their `message` reach a response body.

**Logger — `src/lib/logger.ts`**

9. `log.info/warn/error(event: string, fields?: Record<string, unknown>)` emitting one JSON line: `{ ts, level, event, ...fields }`.
10. Redact before serialising. Denylist on key name, case-insensitive, substring match: `password`, `token`, `secret`, `otp`, `hash`, `authorization`, `cookie`, `assertion`, `key`, `credential`. Replace the value with `"[redacted]"`.
11. Redaction recurses into nested objects and arrays, with a depth cap of 5 to avoid a cycle hanging the process.
12. `log.error` accepts an `unknown` error, logs `name`, `code` and `message` — and for `expose: false` errors, logs the message server-side but never returns it.

**Datastore pings**

13. `src/db/client.ts`: re-export Bun's default `sql`; `pingPostgres(timeoutMs = 2000): Promise<boolean>` running `SELECT 1` with a timeout race. Returns `false` on any failure, logs the reason server-side. Never throws.
14. `src/lib/redis.ts`: `pingRedis(timeoutMs = 2000): Promise<boolean>` with the same contract.
15. Neither function ever includes a connection string in a log line or a return value.

**Readiness — `src/services/health.ts`**

16. `checkReadiness(): Promise<{ status: "ok" | "degraded"; postgres: boolean; redis: boolean }>`. Runs both pings concurrently with `Promise.all`.
17. Cache the result for **5000ms**. Concurrent callers during a check share one in-flight promise — no thundering herd.
18. Takes and returns plain data. No `Request`, no `Response`, so it is testable without HTTP.

**Routes — `src/routes/health.ts`**

19. `/health`: static `200 "ok"`. **Touches no datastore.** This is a liveness probe, and per AGENTS.md it takes no auth and no DB.
20. `/ready`: calls `checkReadiness()`, returns `200` when `status === "ok"`, `503` when `degraded`. Body is booleans only — `{"status":"degraded","postgres":true,"redis":false}`. No error strings, no connection details.

**Server — `src/index.ts`**

21. `Bun.serve` with a `routes` object: `/health`, `/ready`. Nothing else — no auth mount, no catch-all yet.
22. `error(e)` handler: log the full error server-side via `log.error`, return a generic `500` body. **Never** a stack trace, never `e.message` unless `expose === true`.
23. Log one boot line using `redactedSummary()`.
24. `SIGTERM` and `SIGINT`: `server.stop()` draining in-flight requests, close Redis, then exit 0. A rolling deploy must not drop live requests.
25. Routes contain no logic beyond parse → call service → shape response. Both handlers stay under 20 lines.

## Data model impact

**None.** No tables, no columns, no migrations. `pingPostgres` runs `SELECT 1` against whatever is there; it does not require a schema to exist. Step 2 owns the data model.

## Security requirements

**Stays server-side:** `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, and every tier-2 secret. None of them may appear in a response body, a `/ready` payload, a log line, a test fixture, or a config validation error.

**Secrets touched by this task:** `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET` are read and validated here. This module becomes the only legitimate reader of `Bun.env` in the codebase.

**Takeover paths this could open:** none of the four directly — there is no authentication surface yet. The relevant risks are different:

1. **Secret leakage through a validation error.** A naive `zodError.message` includes the received value. Requirement 3 forbids it; a test asserts it.
2. **Secret leakage through a log line.** Requirement 10 redacts by key name; a test asserts a `DATABASE_URL`-shaped value never appears in output.
3. **Stack-trace disclosure through the error handler.** Requirement 22 returns a generic body; a test asserts no file path in the response.
4. **`/ready` as an unauthenticated amplification vector.** Two datastore round-trips per request on an open endpoint. Requirement 17's 5s cache bounds it. `/health` deliberately touches nothing, so liveness stays available even when Postgres is down — which is also what makes it useful during an incident.
5. **A weak `BETTER_AUTH_SECRET` reaching production.** Requirement 1 enforces min 32 chars with no dev fallback.

**Enumeration:** not applicable — no identity endpoints in this task.

**Authorization:** `/health` and `/ready` are intentionally unauthenticated, per the API contract. No other route exists yet, so no handler needs an authorization check. The first one that does arrives in step 7.

## Authorization impact

**None.** No RBAC, no graph, no conditions. Step 7 introduces layer 1.

## Bun-native check

**New dependencies: none.** `zod@4.4.3` is already in `package.json`.

Native APIs used, each replacing a package we are not adding:

| Used | Instead of |
|---|---|
| `Bun.env` + automatic `.env` loading | dotenv |
| `Bun.serve` with native `routes` | Express, Hono, Elysia |
| `Bun.sql` | pg (for our queries), Drizzle, Prisma |
| `Bun.redis` | ioredis, node-redis |
| `bun test` | Jest, Vitest |
| `console` + local structured helper | pino, winston |

No `pg` import in this task. Better Auth's `pg` Pool arrives in step 3.

## Acceptance criteria

- [ ] `bun run dev` boots and logs exactly one structured boot line containing no secret value
- [ ] Removing `BETTER_AUTH_SECRET` from env → process exits `1`, message names the key, does not print any value
- [ ] Setting `BETTER_AUTH_SECRET` to a 10-character string → exits `1` citing minimum length
- [ ] Setting `TZ=Asia/Kolkata` → exits `1` explaining the `Bun.cron` UTC requirement
- [ ] Setting `ACCESS_TOKEN_TTL_SECONDS=3600` → exits `1` citing the 900 maximum
- [ ] `GET /health` → `200 "ok"` **with Postgres stopped**
- [ ] `GET /ready` with both up → `200`, `{"status":"ok","postgres":true,"redis":true}`
- [ ] `GET /ready` with Redis stopped → `503`, `{"status":"degraded","postgres":true,"redis":false}`, no error string in the body
- [ ] Ten rapid `/ready` calls produce **one** pair of datastore pings, not ten
- [ ] A thrown internal error returns a generic 500 with no stack trace or file path in the body
- [ ] `SIGTERM` drains in-flight requests and exits `0`
- [ ] Reading a tier-2 key via `requireLater()` while unset throws `ConfigError` naming the key
- [ ] `bun run check` passes with coverage at or above the 0.8 thresholds

## Tests to add

**`tests/lib/config.test.ts`**

- [ ] `parses a valid environment` — happy path, typed output
- [ ] `rejects a missing required key` — exits with the key named
- [ ] `rejects BETTER_AUTH_SECRET under 32 characters`
- [ ] `rejects a non-UTC TZ` — negative; guards every later `Bun.cron` schedule
- [ ] `rejects ACCESS_TOKEN_TTL_SECONDS above 900` — negative; the security rule made unrepresentable
- [ ] `rejects a DATABASE_URL that is not a postgres scheme`
- [ ] `rejects temp.better-auth.com as PHONE_PLACEHOLDER_DOMAIN` — negative
- [ ] **`never includes a received secret value in a validation error`** — security; asserts a sentinel value absent from the error output
- [ ] `requireLater throws ConfigError naming an unset tier-2 key` — negative
- [ ] `redactedSummary omits every secret key`

**`tests/lib/logger.test.ts`**

- [ ] `redacts a denylisted key at the top level`
- [ ] `redacts a denylisted key nested in an object and an array`
- [ ] **`never emits a connection-string-shaped value`** — security
- [ ] `terminates on a cyclic object` — depth cap, does not hang
- [ ] `emits one line of valid JSON per call`

**`tests/services/health.test.ts`**

- [ ] `reports ok when both dependencies respond`
- [ ] `reports degraded when Postgres fails` — negative
- [ ] `reports degraded when Redis fails` — negative
- [ ] `caches for 5 seconds` — two calls, one ping pair
- [ ] `shares one in-flight promise under concurrency` — ten parallel calls, one ping pair
- [ ] `returns false rather than throwing when a ping times out` — negative

**`tests/routes/health.test.ts`**

- [ ] **`/health returns 200 with Postgres unavailable`** — the liveness/readiness distinction, asserted
- [ ] `/ready returns 503 when a dependency is down`
- [ ] **`/ready body contains no connection details`** — security; asserts absence of `postgres://`, host, port, password
- [ ] **`the error handler returns no stack trace or file path`** — security
- [ ] `an unknown path returns 404`

Real Postgres and Redis for the ping tests, per the testing skill — a mock does not fail the way a real socket does. Failure cases use an unroutable port rather than a mocked client.

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun audit`
- [ ] `bun run db:migrate` — **not applicable**, no migrations in this task

## How to verify it

```bash
# 1. Checks
bun run check
   → typecheck clean; 4 suites pass; coverage ≥ 80% line and function; audit clean

# 2. Boot
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
docker run -d -p 6379:6379 redis:7
cp .env.example .env.local && \
  sed -i '' "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -base64 32)|" .env.local
bun run dev
   → one JSON line: {"ts":...,"level":"info","event":"server_started","port":3000,"nodeEnv":"development","tz":"UTC","baseUrl":"http://localhost:3000"}
   → NO secret values present

# 3. Liveness vs readiness
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/health   → 200
curl -s localhost:3000/ready                                     → {"status":"ok","postgres":true,"redis":true}

# 4. SECURITY — liveness survives a dead database
docker stop $(docker ps -q --filter ancestor=postgres:16)
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/health   → 200   ← still alive
curl -s -w ' [%{http_code}]\n' localhost:3000/ready
   → {"status":"degraded","postgres":false,"redis":true} [503]
   → assert: no "postgres://", no hostname, no password anywhere in that body

# 5. SECURITY — no secret in a config error
BETTER_AUTH_SECRET=short bun src/index.ts 2>&1 | tee /tmp/cfg.log; echo "exit=$?"
   → exit=1, names BETTER_AUTH_SECRET and the 32-char minimum
grep -c 'short' /tmp/cfg.log                                     → 0   ← the received value never printed

# 6. SECURITY — UTC enforced
TZ=Asia/Kolkata bun src/index.ts; echo "exit=$?"
   → exit=1, error explains the Bun.cron UTC requirement

# 7. Cache bound on an unauthenticated endpoint
for i in $(seq 1 10); do curl -s -o /dev/null localhost:3000/ready & done; wait
   → server log shows ONE readiness_check event, not ten

# 8. Graceful shutdown
kill -TERM $(pgrep -f 'bun src/index.ts')
   → logs shutdown_started then shutdown_complete, exits 0
```

Steps 4, 5 and 6 verify security properties rather than status codes. They are the ones to actually run by hand.

## Out of scope for this task

Deliberately not built, so it does not appear by accident:

- `src/auth.ts` and any Better Auth wiring — step 3
- The `pg` Pool — step 3
- Any table, migration, or domain query — step 2
- `src/db/migrate.ts`, `src/db/seed.ts`, `src/authz/push-model.ts` — referenced by `package.json` scripts but created in steps 2 and 11
- Login UI, OAuth routes, `/api/auth/*` catch-all — steps 3 and 6
- Alias resolution and `/api/identity/*` — step 4
- Rate limiting middleware — arrives with the first identity endpoint in step 4, where enumeration actually matters
- Metrics and APM — step 15
- Dockerfile, deployment manifests, CI — step 15
- Any `Bun.cron` job — step 14 (only the `TZ` guard that protects them lands now)

---

# Outcome

Implemented as approved. `bun run typecheck` and `bun test` pass (55 tests, 0 fail, 89.67% funcs / 94.95% lines — above the 0.8 thresholds). **`bun audit` has one open finding, so `bun run check` exits 1.** Details below.

## Deviations from the plan

| # | Change | Why |
|---|---|---|
| 1 | `errorResponse()` added to `src/lib/errors.ts` rather than the handler being inline in `src/index.ts` | The "no stack trace, no file path" property is a security requirement and needed to be directly testable. No new file — `errors.ts` was already on the approved list. |
| 2 | `checkReadiness` built via `createReadinessChecker(probes, cacheMs, now)` with injected probes and clock | Lets the 5s cache and the shared in-flight promise be asserted deterministically instead of by standing up datastores to prove a timer works. Requirements 16–18 unchanged. |
| 3 | The `readiness_check` log line moved from the route into the checker | Discovered in live verification: logging in the route emitted one line per *request*. `/ready` is unauthenticated, so that is a log-flood vector, and a line that does not correspond to real work is noise. Now one line per actual probe. |
| 4 | `redactedSummary()` field renamed `configuredKeys` → `configuredCount` | Discovered in live verification: the logger's denylist matches `key` as a substring, so the boot line was printing `"configuredCount":"[redacted]"`. Regression test added. |
| 5 | `tsconfig.json` — removed `baseUrl`, made `paths` relative | TypeScript 7 removed `baseUrl` (TS5102). Caught by the first typecheck run. |
| 6 | devDependency `@better-auth/cli@1.4.21` → `auth@1.6.25` | See audit section — the old CLI dragged in a vulnerable `better-auth@1.4.21`. |
| 7 | `overrides` block added for `axios`, `drizzle-orm`, `lodash` | See audit section. |

## Audit: 25 findings reduced to 1

The first `bun audit` reported **25 vulnerabilities (1 critical, 10 high)**, including advisories that read alarmingly close to this project's core security rules — OAuth refresh-token replay, account takeover via OAuth auto-link to an unverified email, magic-link pre-account hijacking.

**Root cause: a stale devDependency, not our runtime.** Every `better-auth` advisory ranged `<1.6.11`, `<1.6.13`, `<1.6.22` or `<1.6.2` — all below our pinned `1.6.25`. `bun why` traced the vulnerable copy to `@better-auth/cli@1.4.21`, which depends on `better-auth@1.4.21` and `drizzle-orm@0.41.0`.

Fixes applied:

| Finding | Action | Result |
|---|---|---|
| `better-auth@1.4.21` (1 critical, 6 high) via `@better-auth/cli` | `@better-auth/cli@1.4.21` → `auth@1.6.25`, the current official CLI (`@better-auth/cli` is stale; its only newer releases are 1.5.0 betas). Scripts now `bunx auth generate` / `bunx auth migrate`. | resolved |
| `axios@1.16.0` (1 high, 8 moderate), pinned exactly by `@openfga/sdk` | `overrides: { "axios": "1.18.1" }` | resolved |
| `drizzle-orm@0.41.0` — SQL injection via unescaped identifiers (high) | `overrides: { "drizzle-orm": "0.45.2" }`. We never import it; AGENTS.md forbids an ORM. It arrives only as an optional peer. | resolved |
| `lodash` (1 high, 2 moderate) via `auth › @mrleebo/prisma-ast › chevrotain` | `overrides: { "lodash": "4.18.1" }`. Reached only through the CLI's Prisma schema parser, which we do not use. | resolved |

## Open finding — needs a decision before step 6

```
@better-auth/oauth-provider  >=1.4.8 <1.7.0-beta.4   (direct dependency)
  moderate: may provide access tokens for unauthorized audiences
            via unbound resource indicators
  https://github.com/advisories/GHSA-p2fr-6hmx-4528
```

**Why it matters here specifically.** Our token design (§3.4 of the architecture plan) uses the `resource` parameter to select JWT over opaque and to bind audience. "Unbound resource indicators" means a token minted for one product could be accepted by another — a cross-product authorization weakness in exactly the mechanism we rely on.

**Why it does not block step 1.** Nothing in this step imports `@better-auth/oauth-provider`. It is declared but unused until step 6.

**Not silently accepted.** No audit ignore was added and no threshold was lowered, so `bun run check` exits 1 until this is resolved. Per AGENTS.md, that is the correct state — a green check that hides a live advisory is worse than a red one.

Options, in the order I would consider them:

1. **Wait for `1.7.0` stable.** Current channels: `latest 1.6.25`, `rc 1.7.0-rc.2`, `beta 1.7.0-beta.10`. An rc exists, so stable is plausibly close. Step 6 is weeks out on the roadmap, so waiting may cost nothing.
2. **Adopt `1.7.0-rc.2`** and re-run the audit. Faster, but an rc in an identity provider needs its own justification.
3. **Mitigate at the resource servers** — mandatory strict `aud` validation in the Django and Node middleware, so an unbound token is rejected on arrival regardless of how it was minted. Worth doing anyway as defence in depth, and it does not clear the advisory.

Recommendation: decide at the start of step 6, not now, and re-run `bun audit` then. Track it as a blocker on that step.

## Verified behaviour

Run against Bun 1.3.14 with Postgres and Redis absent — which is itself the "dependencies down" scenario.

```
config errors, all exit 1:
  missing BETTER_AUTH_SECRET  → "BETTER_AUTH_SECRET — is required"
  12-char secret              → "must be at least 32 characters"; received value printed 0 times
  TZ=Asia/Kolkata             → "must be \"UTC\" — Bun.cron in-process schedules are UTC…"
  ACCESS_TOKEN_TTL_SECONDS=3600 → "must be between 60 and 900 seconds"

boot line, no secret present:
  {"ts":"…","level":"info","event":"server_started","nodeEnv":"development",
   "port":3112,"tz":"UTC","baseUrl":"http://localhost:3112","configuredCount":8}

/health  with both datastores down → 200 "ok"     ← liveness survives a dead database
/ready                            → 503 {"status":"degraded","postgres":false,"redis":false}
                                      no "postgres://", no "127.0.0.1" in the body
/nope                             → 404

10 parallel /ready → readiness_check: 1 · postgres pings: 1 · redis pings: 1
SIGTERM            → shutdown_started, shutdown_complete, exit 0
```
