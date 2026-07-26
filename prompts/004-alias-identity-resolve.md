# 004 — Alias identity model and the resolve endpoint

**Status:** approved · implemented · verified against live Postgres + Redis
**Roadmap step:** 4 of 15

---

## Goal

Build the alias-resolution core — handle normalisation and a verified-only `handle → user_id` resolver — and expose the enumeration-safe `POST /api/identity/resolve` endpoint that the login screen calls, rate limited per IP and per handle.

## What it read

**Skills**

- `.agents/skills/alias-identity.md` — an email/phone is a *handle* that points at one global user, not an identity. Login resolution: `normalise → SELECT user_id FROM user_identity WHERE type=$1 AND value=$2 AND is_verified=true` → no match = generic rate-limited response, match = offer that user's methods. **Normalise before the query, never on read.** Email: trim + lowercase, **do not** strip Gmail dots or `+tags`. Phone: E.164, bare 10-digit Indian → `+91` (assumption to validate against a sample). `resolve` is an enumeration oracle: identical **shape and timing** for hit and miss, no early return on miss, rate limit per IP **and** per handle, never differentiate messages, alert on scan patterns. Invariants to test: `UNIQUE (type,value)`, unverified cannot authenticate (**negative test required**), `resolve` identical shape hit/miss, `normalise(normalise(x)) === normalise(x)`.
- `.agents/skills/security.md` — enumeration section repeats identical shape+timing, no early return, per-IP and per-handle limits, applies equally to reset/OTP/signup. Never log a full phone number — log the `usr_` id. zod at every boundary. Takeover path 1: only `is_verified = true` authenticates, ever. "When unsure on a security boundary: stop, ask one question, write the assumption into the plan."
- `.agents/skills/testing-and-checks.md` — real Postgres (a mock does not enforce a constraint), disposable schema per run; mock only true externals (Redis is **not** one — use real Redis); one guarantee per test named after it; verify the **security property**, not just a 200; the worked example is literally this endpoint (`resolve` hit vs miss → identical shape, no disclosure).
- `.agents/skills/better-auth.md` — resolve is **ours**, not under `/api/auth/*`; "Tighten `/api/identity/resolve` explicitly — the [Better Auth] default is not strict enough for an enumeration-sensitive endpoint" (so we rate-limit it ourselves, since it is not a Better Auth route). `emailOTP`/`phoneNumber` are later steps.
- `.agents/skills/postgres-migrations.md` — all SQL lives in `src/db/`, `Bun.sql` tagged templates, parameterised; identifiers never interpolated. The login hot path is the partial index `ix_identity_lookup ON (type, value) WHERE is_verified` (already created in 0002).

**Files opened**

- `AGENTS.md` — architecture: routes = thin parse/call/shape (≤20 lines), services = logic (no `Request`/`Response`), `identity/` = alias resolution/merge/dedup, only `db/` writes SQL, config only in `lib/config.ts`. API contract pins `POST /api/identity/resolve`. Security rule 2 restates identical shape+timing + per-IP/per-handle limits. "Change only what the task needs."
- `src/db/migrations/0002_user_identity.sql` — `user_identity(id,user_id,type,value,is_primary,is_verified,source,verified_at,created_at)`; `uq_identity_value UNIQUE(type,value)`; CHECKs enforce email `lower(btrim(value))` and phone `^\+[1-9][0-9]{7,14}$`; partial index `ix_identity_lookup (type,value) WHERE is_verified`. The resolver query is exactly this index's shape. *(Note: this file ends with a stray `-- tampered` comment — harmless SQL, but see "Out of scope / flagged" below. Not edited: forward-only.)*
- `src/db/types.ts` — `IdentityType = "email"|"phone"`, `IDENTITY_TYPES`, `UserIdentityRow`, `newId("identity")`.
- `src/db/client.ts` — exports `sql`, `transaction`, `pingPostgres`; the pattern for a db module (typed rows, `DatabaseError` wrapping).
- `src/lib/redis.ts` — exports Bun's shared `redis` and `RedisClient`; a probe opens a short-lived client. Rate limiting will use the shared `redis`.
- `src/lib/errors.ts` — typed `AppError` with `expose` (default false); `errorResponse()` collapses internals. No `throw new Error("string")`.
- `src/lib/logger.ts` — `log.info/warn/error`; redaction is a **key-name** denylist (`password/token/otp/hash/…`) — it does **not** contain "handle" or "email", so a handle value put in a log field would **not** be redacted. Therefore never log the handle value.
- `src/index.ts` — `Bun.serve({ routes })`; more-specific routes win over `/api/auth/*`; route handlers receive `(req, server)` so `server.requestIP(req)` is reachable.
- `src/routes/health.ts`, `src/services/health.ts` — the thin-route + service split to mirror; `no-store` on public bodies; booleans not details in public bodies.
- `src/auth.ts` — step 3 wired **email+password only**. `emailOTP`/`phoneNumber`/`sso` are not enabled, so **password is the only working sign-in method today**.
- `tests/helpers/database.ts` — `createTestSchema()`/`withTestSchema()`/`insertUser()`; applies `better-auth-schema.sql` then our migrations to a disposable schema; `insertUser` needed because `user_identity` FKs to `"user"` (0007).
- `tests/db/constraints.test.ts`, `tests/routes/health.test.ts` — existing patterns for real-DB constraint tests and Bun.serve route tests; `UNIQUE(type,value)` and the verified-integrity CHECKs are already covered there (not duplicated here).

## Decisions taken

1. **Scope = resolve + model only.** Build normalisation, the verified-only resolver, and the `resolve` endpoint. **Defer alias add/verify/remove** (`GET/POST/DELETE /api/identity/me/aliases*`) to a later prompt: the alias-identity skill requires the linking OTP to go to the **already-verified** handle, and OTP send needs the `emailOTP`/`phoneNumber` plugins + email/SMS integrations, which are roadmap steps 5+. Building add/verify now means pulling step-5 machinery forward or shipping a takeover-shaped stub — neither is honest. *(This is the one scope decision surfaced for approval.)*
2. **`resolve` response is derived from the handle, never from existence.** Returning a user's *actual* method set on a hit and something else on a miss **is** the enumeration oracle the skill forbids. The method list is a pure function of the handle (its type), so a hit and a miss for the same input are byte-identical. Today the only working method is `password` (step 3), so the response is `{"methods":["password"]}` for any handle — trivially non-disclosing. Step 5 adds `email_otp` (email handles) / `sms_otp` (phone handles), still derived from handle **type**, so it stays existence-independent.
3. **Endpoint timing: identical code path, no early return on miss.** The endpoint does the same work regardless of hit/miss (it does not branch on existence at all at step 4). This is the skill's "constant-time-ish path". A deliberate fixed floor is **not** added — see "Out of scope". The DB-backed resolver (`resolveVerifiedUser`) that *does* branch on existence is a server-side primitive for step 5, never on the endpoint's response path yet.
4. **Rate limiter fails OPEN on a Redis error, with a logged warning.** A Redis outage already degrades the whole estate (sessions live there); failing *closed* would turn a Redis blip into an estate-wide login outage, while the enumeration window during that outage is bounded by the outage itself. The warning doubles as the "alert on scan patterns" signal source. *(Security trade-off — stated for approval.)*
5. **Client (direct socket) IP now; `X-Forwarded-For` deferred to step 15.** We have no trusted-proxy allowlist yet, and trusting an unvalidated `X-Forwarded-For` lets an attacker rotate the header to defeat the per-IP limit. Behind the load balancer the socket IP is the LB, so **the per-handle limit is the load-bearing enumeration control today**; per-IP is best-effort until step 15 (deploy/harden) adds XFF parsing against a trusted-proxy list.
6. **Rate-limit keys hash the handle.** `rl:resolve:h:<sha256(type:value)[:32]>`, keyed on the **normalised** handle so casing/whitespace variants share one bucket. Hashing keeps raw emails/phones out of Redis (they are PII the security skill protects).

## Assumptions

1. **Handle type is inferred from the handle string** (the contract sends `{ handle }`, no type): contains `@` → email; otherwise attempt phone. An unclassifiable handle is treated as a miss and still returns the identical generic response — never an "invalid handle" disclosure.
2. **Phone normalisation covers the two common interactive formats:** an already-`+`-prefixed E.164 (`^\+[1-9]\d{7,14}$` after stripping spaces/`-`/`()`), and a bare 10-digit Indian mobile (`[6-9]\d{9}`, optionally one leading `0`) → prefixed `+91`. Anything else → `null` (miss). This matches the 0002 CHECK. The `+91` assumption is flagged in-code per the skill; a batch job must validate it against a sample (step 9), which is not this task.
3. **Rate-limit policy constants** (module-level, not env config, since they do not vary per environment): per-handle **5 / 60s**, per-IP **30 / 60s**, fixed window. A `// ponytail:` comment names the burst-at-boundary ceiling and the sliding-window/config upgrade path. Move to `lib/config.ts` only if ops needs runtime tuning without a deploy.
4. **`resolveVerifiedUser` (DB-backed) is built now even though only tests and step 5 consume it.** It is not speculative: it is the core primitive of *this* step's theme, and the mandated negative test "an unverified identity does not resolve" cannot exist without it. Step 5 (passwordless) consumes it directly.
5. **No new migration.** `user_identity` and its login-hot-path index already exist (0002). Nothing in this task changes the schema.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/identity/normalise.ts` | create | `normaliseEmail`, `normalisePhone`, `normaliseHandle(raw) → {type,value} \| null` |
| `src/identity/resolve.ts` | create | `resolveHandle(parsed) → {methods}` (enumeration-safe offer); `resolveVerifiedUser(parsed) → Promise<string \| null>` (verified-only primitive) |
| `src/db/identity.ts` | create | `findUserIdByVerifiedHandle(type, value, client?) → Promise<string \| null>` — the `Bun.sql` lookup on `ix_identity_lookup` |
| `src/lib/rate-limit.ts` | create | `checkRateLimit(key, limit, windowSeconds, client?) → Promise<{allowed, retryAfterSeconds}>` over `Bun.redis`, fail-open |
| `src/routes/identity.ts` | create | thin `POST /api/identity/resolve` handler: zod-validate, rate-limit (IP + handle), call `resolveHandle`, shape response |
| `src/index.ts` | modify | mount `"/api/identity/resolve": { POST: (req, server) => resolveRoute(req, server) }` |
| `tests/identity/normalise.test.ts` | create | idempotency; email lower/trim + **no** dot/tag stripping; phone E.164/`+91`; invalid → null |
| `tests/identity/resolve.test.ts` | create | `resolveVerifiedUser` hit → user_id, miss → null, **unverified → null (negative)**; `resolveHandle` shape (real DB, disposable schema) |
| `tests/lib/rate-limit.test.ts` | create | allows under limit, blocks over, window expiry, **fail-open on Redis error** |
| `tests/routes/identity.test.ts` | create | 200 `{methods}`; **hit and miss byte-identical (security property)**; 429 over limit; 400 malformed body; handle value never in logs |

Not touched: `lib/config.ts` (no new config), `db/migrations/*` (forward-only, no schema change), `auth.ts`, any `services/`/`authz/` file, the alias-CRUD routes (later prompt).

## Implementation requirements

**`src/identity/normalise.ts`**

1. `normaliseEmail(raw: string): string` → `raw.trim().toLowerCase()`. No dot/`+tag` stripping. Idempotent.
2. `normalisePhone(raw: string): string | null` → strip ` `, `-`, `(`, `)`; then `^\+[1-9]\d{7,14}$` → return as-is; else `^0?([6-9]\d{9})$` → `+91` + captured group; else `null`. Output always satisfies the 0002 phone CHECK. `// ponytail:` note on the `+91` assumption. Idempotent.
3. `normaliseHandle(raw: string): { type: IdentityType; value: string } | null` → trim; `@` present and `normaliseEmail` is non-empty with a single `@` and a dot in the domain → `{type:"email", value}`; else `normalisePhone` → `{type:"phone", value}` or `null`.

**`src/db/identity.ts`**

4. `findUserIdByVerifiedHandle(type, value, client = sql): Promise<string | null>` → `SELECT user_id FROM user_identity WHERE type=${type} AND value=${value} AND is_verified = true LIMIT 1`; return `rows[0]?.user_id ?? null`. Parameterised. Typed row.

**`src/identity/resolve.ts`**

5. `resolveHandle(parsed: { type: IdentityType; value: string } | null): { methods: string[] }` → returns `{ methods: ["password"] }`. `// ponytail:` step 5 branches on `parsed?.type` to add `email_otp`/`sms_otp`; must stay existence-independent.
6. `resolveVerifiedUser(parsed: { type: IdentityType; value: string }): Promise<string | null>` → `findUserIdByVerifiedHandle(parsed.type, parsed.value)`. The verified-only primitive for step 5.

**`src/lib/rate-limit.ts`**

7. `checkRateLimit(key, limit, windowSeconds, client = redis)`: `INCR key`; if result `=== 1` set `EXPIRE key windowSeconds`; `allowed = count <= limit`; `retryAfterSeconds` from `TTL` (fallback `windowSeconds`). On any thrown Redis error: log `warn("rate_limit_unavailable", {reason})`, return `{ allowed: true, retryAfterSeconds: 0 }` (fail-open). Never logs the key.

**`src/routes/identity.ts`**

8. zod body schema `z.object({ handle: z.string().min(1).max(320) })`; parse failure → `Response.json({ error: "invalid_request" }, { status: 400 })` (generic; a missing field is a request-validity fact, not an existence fact).
9. `ip = server.requestIP(req)?.address ?? "unknown"`; `parsed = normaliseHandle(body.handle)`; handle key = `rl:resolve:h:` + `new Bun.CryptoHasher("sha256").update(parsed ? \`${parsed.type}:${parsed.value}\` : body.handle.trim().toLowerCase()).digest("hex").slice(0,32)`.
10. `Promise.all` the two `checkRateLimit` calls (`rl:resolve:ip:<ip>` @ 30/60s, handle key @ 5/60s); if **either** `!allowed` → `Response.json({ methods: [] } | generic, 429)` with `Retry-After` header and `cache-control: no-store`. (429 is keyed on the handle regardless of existence, so it discloses nothing.)
11. Otherwise `resolveHandle(parsed)` → `Response.json(result, { headers: { "cache-control": "no-store" } })` (200).
12. `log.info("identity_resolve", { handleType: parsed?.type ?? "unknown", outcome: "ok" | "rate_limited" })` — **never** the handle value. Handler stays ≤20 lines of logic; normalisation/methods live in the service, limiting in `lib/`.

**`src/index.ts`**

13. Add the route to `routes`. No logic in the entry; delegate to `resolveRoute`. `/api/auth/*` is unaffected (different prefix).

## Data model impact

**None.** `user_identity`, `uq_identity_value`, the verified-integrity CHECKs, and the partial login index `ix_identity_lookup` all already exist (migration 0002). No new table, column, constraint, index, or migration. Save rules relevant here are already enforced in schema (normalisation CHECKs, `UNIQUE(type,value)`) and are re-read, not re-implemented, by the resolver query.

## Security requirements (restated for this task)

- **Enumeration (the whole point):** `resolve` returns **identical response shape and body** for hit, miss, and unclassifiable handle; **no early return on miss** (endpoint never branches on existence). Rate limited **per IP and per handle**; per-handle is the load-bearing control until XFF lands (decision 5). Never a "no account found" vs other message.
- **Takeover path 1 (unverified authenticates):** the resolver's `is_verified = true` filter is the foundation; the mandated **negative test** asserts an unverified identity does not resolve. Paths 2–4 are not touched (no alias-add here).
- **Never server-side → client:** no secrets touched at all. No DB credentials, no Better Auth secret in scope.
- **Never logged:** the handle value (full email/phone is PII; the logger's key-name denylist does **not** catch it). Log `handleType` + `outcome` + (later) `usr_` id only.
- **Input validation:** zod on the body at the boundary; no SQL identifier ever built from input (values are parameterised).

## Authorization impact

**None.** No RBAC read/write, no OpenFGA model or tuples, no outbox events. `resolve` is unauthenticated by design (pre-login screen).

## Bun-native check

**New dependencies: none.** `Bun.redis` (rate limiting), `Bun.sql` (lookup), `Bun.serve` + `server.requestIP` (route + IP), `Bun.CryptoHasher` (hash the handle for the Redis key), `zod` (already a dependency). Nothing added.

## Acceptance criteria

- [ ] `normalise(normalise(x)) === normalise(x)` for emails and phones; `Foo@Bar.com ` → `foo@bar.com`; dots/`+tags` preserved; `9876543210` → `+919876543210`; junk → `null`
- [ ] `resolveVerifiedUser` returns the `user_id` for a verified handle, `null` for an unknown handle, and **`null` for an unverified handle** (negative)
- [ ] `POST /api/identity/resolve` returns `200 {"methods":["password"]}` and `cache-control: no-store`
- [ ] A verified handle and an unknown handle produce **byte-identical** response bodies (the security property)
- [ ] Exceeding the per-handle or per-IP limit returns `429` with `Retry-After`; a Redis error fails **open** (200), logged
- [ ] Malformed body → `400 {"error":"invalid_request"}`; the handle value appears in **no** log line
- [ ] `bun run check` — typecheck clean, tests pass ≥80% line/func, `bun audit` shows only the pre-existing `@better-auth/oauth-provider` finding

## Tests to add

- [ ] `tests/identity/normalise.test.ts` — idempotency; email lower+trim; **dots/`+tags` NOT stripped**; phone `+91` prefixing + E.164 passthrough; separators stripped; invalid → null
- [ ] `tests/identity/resolve.test.ts` — `resolveVerifiedUser`: hit → user_id, miss → null, **unverified → null (negative)**; both email and phone; `resolveHandle` → `{methods:["password"]}` (real DB via `withTestSchema` + `insertUser` + seeded identity)
- [ ] `tests/lib/rate-limit.test.ts` — under limit allowed; over limit blocked with `retryAfterSeconds > 0`; window resets after expiry; **Redis error → fail-open** (inject a client pointed at an unroutable port); unique key prefix per test
- [ ] `tests/routes/identity.test.ts` — 200 shape + `no-store`; **hit vs miss byte-identical** (seed a verified handle, compare against a random handle); 429 past the handle limit; 400 on malformed body; **spy on `console` and assert the handle string never appears**

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test` (real Postgres + Redis, per the testing skill)
- [ ] `bun audit`
- [ ] No `bun run db:migrate` — no migration changed

## How to verify it

```bash
# 0. Postgres + Redis up; migrated dev DB with a seeded verified identity, e.g.
#    insert a "user" then: user_identity(type=email, value=known@example.com, is_verified=true, verified_at=now())

# 1. Checks
bun run check
   → typecheck clean; suites pass ≥80%; audit = only the known oauth-provider finding

# 2. A known (verified) handle
curl -s -X POST localhost:3000/api/identity/resolve \
  -H 'content-type: application/json' -d '{"handle":"known@example.com"}'
   → 200  {"methods":["password"]}

# 3. SECURITY — an unknown handle is indistinguishable
curl -s -X POST localhost:3000/api/identity/resolve \
  -H 'content-type: application/json' -d '{"handle":"nobody-here@example.com"}'
   → 200  {"methods":["password"]}      ← byte-identical to step 2, no disclosure

# 4. SECURITY — unverified handle does not resolve (server-side primitive)
#    seed value=pending@example.com is_verified=false; resolveVerifiedUser → null
#    (asserted in tests/identity/resolve.test.ts, the negative test)

# 5. SECURITY — per-handle rate limit fires
for i in $(seq 1 7); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/identity/resolve \
    -H 'content-type: application/json' -d '{"handle":"known@example.com"}'
done
   → 200 200 200 200 200 429 429   ← 6th+ blocked within the 60s window

# 6. SECURITY — handle never logged
#    run the server, hit /resolve, grep stdout for "known@example.com" → 0 matches
```

Steps 3–6 verify security properties (indistinguishable hit/miss, unverified excluded, rate limit, no-PII-in-logs), not just a 200.

## Out of scope for this task (and flagged)

- **Alias add / verify / remove** (`GET/POST/DELETE /api/identity/me/aliases*`) — needs OTP-to-existing-verified-handle, i.e. `emailOTP`/`phoneNumber` + email/SMS integrations (steps 5+). Deferred to its own prompt.
- **`email_otp` / `sms_otp` in the `methods` list** — step 5, when those plugins are wired; the response stays type-derived.
- **A deliberate fixed timing floor** — the endpoint already does no existence-dependent work, so the code path is uniform. A floor is a possible later hardening; not added now to avoid adding login latency and a tuning knob with no measured need.
- **`X-Forwarded-For` / trusted-proxy IP extraction** — step 15 (deploy/harden). Per-handle limiting carries the enumeration defence until then.
- **Merge-related resolve invariants** ("merged id resolves to survivor") — step 9.
- **FLAGGED, not part of this task:** `src/db/migrations/0002_user_identity.sql:58` ends with a stray `-- tampered` comment. Harmless as SQL, but `migrate.ts` checksums migration files, so any environment where 0002 was already applied with different bytes will now abort `bun run db:migrate` with a checksum mismatch. Left untouched (forward-only forbids editing an applied migration); raise separately if a deployed DB is affected.

---

# Outcome

Implemented as approved (**resolve + model only**). Verified against live Postgres + Redis.

**Tests:** `bun test` → **169 pass, 0 fail**, coverage **95.47% line / 89.32% func** (floor 80%).
Every new file is 100%/100%: `db/identity.ts`, `identity/normalise.ts`, `identity/resolve.ts`,
`lib/rate-limit.ts`, `routes/identity.ts`. `bun run typecheck` clean.

**`bun audit`:** the one pre-existing `@better-auth/oauth-provider` advisory
(GHSA-p2fr-6hmx-4528), unchanged — this task adds no dependency. Deferred to step 6 by the
roadmap, as in steps 1 and 3.

**Security properties proven by tests, not just 200s:**
- `POST /api/identity/resolve` returns byte-identical bodies for an email, a phone, and an
  unclassifiable handle — no enumeration oracle (`tests/routes/identity.test.ts`).
- Per-handle rate limit trips at the 6th request with a `Retry-After` (429).
- The handle value never appears in a log line; only `handleType` is logged.
- An **unverified** identity does not resolve (`resolveVerifiedUser` → null) — the mandated
  negative test for takeover path 1.
- Normalisation runs before the query: a differently-cased email and a bare 10-digit phone
  both hit the stored normalised handle.

## Deviations from the plan

| # | Change | Why |
|---|---|---|
| 1 | `resolveRoute` takes an optional injected `rateClient` (defaults to shared `redis`) | Lets the route test drive rate limiting deterministically against a dedicated client, avoiding shared-`redis`/`REDIS_URL` ordering coupling with the health suite. Production calls `resolveRoute(req, server)` unchanged. |
| 2 | `server` typed `Server<undefined>` (not bare `Server`) | TS7 requires the WebSocketData type argument; the server has no websocket. |

Nothing else deviated. Alias add/verify/remove remain deferred to a step-5 prompt (they need
OTP-to-existing-verified-handle). The stray `-- tampered` comment in `0002` was left untouched
and is flagged in "Out of scope" for a separate decision.
