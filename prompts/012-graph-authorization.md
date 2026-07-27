# 012 — Graph authorization: OpenFGA model, outbox worker, shadow mode

## Goal

Author and push the canonical OpenFGA model, drain the existing `outbox` table into real tuple writes for the one relation this repository actually owns data for (vendor admin/staff), and run a shadow-mode reconciliation that logs where the graph disagrees with RBAC — with zero enforcement change.

## What it read

- Skills: `.agents/skills/openfga-authz.md`, `.agents/skills/postgres-migrations.md`
- `AGENTS.md` — architecture table (`authz/` vs `db/` split), tech-stack table, data model, roadmap step 11, security rules 6/12
- `docs/architecture-plan.md` §5 (authorization layers, model sketch, phasing) and §12 (risk register: tuple drift, shadow mode)
- `.agents/skills/testing-and-checks.md`, `.agents/skills/security.md` (deny-by-default, "graph never on the login path", model-test negative cases)
- Files opened: `src/db/migrations/0006_outbox.sql`, `0004_user_product_access.sql`, `src/db/access.ts`, `src/services/access.ts`, `src/db/types.ts`, `src/lib/config.ts` (FGA_* already tier 2), `src/lib/errors.ts`, `src/lib/logger.ts`, `src/db/client.ts`, `src/db/vendor.ts`, `src/identity/merge.ts` (transaction pattern), `src/index.ts`, `tests/helpers/database.ts`, `package.json` (an `fga:model` script already points at `src/authz/push-model.ts`, which does not exist yet), `.env.example` (`FGA_API_URL`/`FGA_STORE_ID`/`FGA_MODEL_ID`/`FGA_API_TOKEN` already present, all empty)
- `node_modules/@openfga/sdk` — `client.d.ts` (`OpenFgaClient`, `write`/`check`/`writeAuthorizationModel`, `ClientWriteConflictOptions.onDuplicateWrites`/`onMissingDeletes`), `configuration.d.ts` + `credentials/types.d.ts` (`CredentialsMethod.ApiToken` shape), `apiModel.d.ts` (`AuthorizationModel` is a hand-writable JSON shape, but `metadata.relations[...].directly_related_user_types[...].condition` makes hand-authoring the `[user with active_enrolment]` clauses error-prone and duplicative of the DSL already reviewed in the skill file)
- Confirmed no `@openfga/cli` package exists on npm at all (the real `fga` CLI is a Go binary, distributed via Homebrew/release binaries, not npm) — corrected mid-implementation after the initial plan wrongly assumed a `bunx @openfga/cli` shell-out would work. `@openfga/syntax-transformer@0.2.2` (the OpenFGA project's own DSL↔JSON parser, a real npm package) is used instead, in-process. Also confirmed no `Bun.cron` usage exists anywhere yet in `src/` — this task introduces the first one.

## Assumptions

1. **Scope is bounded by what data this repository actually owns.** The skill's model includes `course`/`package`/`cohort`, but course/package/cohort tuples are produced by LMS and Masterclass from their own enrolment/subscription data, which does not exist in this codebase. The only relation this repo can honestly produce tuples for today is `vendor#admin` / `vendor#staff`, sourced from `user_product_access` rows with `role IN ('VENDOR','VENDOR_ADMIN')`. The model is still pushed **in full** (course/package/cohort included) because it is the one shared store every product authors against (skill rule 5: "one store, typed objects") — this task just doesn't populate tuples for the parts it has no data for. Backfilling **existing** vendor rows into tuples, and wiring course/package/cohort tuple production from the other products, are both out of scope (see Out of scope) — the user's request named "model, outbox worker, shadow mode", not "backfill".
2. **The DSL, not hand-authored JSON, is the source of truth.** `src/authz/model.fga` is the exact model from `.agents/skills/openfga-authz.md`. `push-model.ts` calls `@openfga/syntax-transformer`'s `transformer.transformDSLToJSONObject()` in-process to compile it to the JSON `writeAuthorizationModel` needs, rather than hand-maintaining a ~150-line JSON `AuthorizationModel` object that could silently drift from the reviewed DSL. **Correction during implementation:** the plan originally proposed shelling out to a `bunx @openfga/cli` — that package does not exist on npm (the real `fga` CLI is a Go binary). `@openfga/syntax-transformer@0.2.2` is a genuine new dependency (small, single-purpose, published by the OpenFGA project itself) — see Bun-native check. Also, during implementation the DSL itself needed a formatting fix: this parser's grammar does not support a `union`/`or` expression wrapped across multiple lines (confirmed empirically) — `model.fga`'s `viewer` relation is one line, semantically identical to the skill's multi-line prose rendering.
3. **`FGA_STORE_ID` already exists.** Creating the OpenFGA store itself is a one-time ops action (`fga store create` / the dashboard), same category as provisioning `DATABASE_URL` — out of scope for this task. `push-model.ts` requires `FGA_STORE_ID` to already be set and only writes the model into it.
4. **Shadow mode runs off the request path, not inline.** `.agents/skills/openfga-authz.md` rule 2 ("the graph is never on the login path") and the fact that no per-resource authorization endpoint exists yet in this repo (course/vendor-content access checks live in LMS/Masterclass, not here) rule out a per-request shadow wrapper. Shadow mode is implemented as a scheduled reconciliation (`Bun.cron`, daily) that walks every **active, vendor-scoped** `user_product_access` row and checks whether OpenFGA's graph agrees that relation exists — logging (not blocking on) any disagreement. This matches the concrete, reviewable "disagreement rate" the architecture doc's Phase 5 exit criterion and this skill's rule 8 describe.
5. **Direction of the shadow check is one-way.** The reconciliation confirms every RBAC-granted vendor relation is also present in the graph (the direction that would lock someone out if flipped to enforcement); it does not enumerate the inverse ("does the graph grant anything RBAC didn't") — that direction is instead covered by the OpenFGA model's own negative tests (vendor A cannot read vendor B), which test the model in isolation, not this repo's data.
6. **Idempotent tuple application.** Re-granting an already-active vendor role goes through `ON CONFLICT DO UPDATE` (existing behaviour) and will emit another `granted` outbox event for the same tuple. The FGA `write` call sets `conflict: { onDuplicateWrites: "ignore" }` (and deletes set `onMissingDeletes: "ignore"`) so a repeat event is a safe no-op instead of an error that would spin `attempts` up forever.
7. **Outbox worker cadence.** `Bun.cron("* * * * *", ...)` (every minute) for the drain — the finest granularity `Bun.cron` supports — draining a bounded batch (100 rows) per tick. At current volume (vendor grant/revoke only) this is far ahead of demand; a batch size and interval are trivially adjustable later, not a design commitment.
8. **`FGA_MODEL_ID` is read by everything except `push-model.ts` itself.** The push script builds its own minimal client (`FGA_API_URL`/`FGA_STORE_ID`/`FGA_API_TOKEN`) because the model id doesn't exist until the script's own call returns it — reusing a shared `getFgaClient()` that requires `FGA_MODEL_ID` up front would be circular. The script prints the new id and instructs setting `FGA_MODEL_ID` by hand (same "review then apply" shape as `bun run auth:schema` / `auth:migrate`).

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/authz/model.fga` | create | the canonical model, verbatim from `.agents/skills/openfga-authz.md` |
| `src/authz/model.fga.yaml` | create | OpenFGA model-test file: the negative cases security.md/openfga-authz.md require (vendor isolation, expired enrolment, expired cohort membership) plus the positive package/direct/vendor paths |
| `src/authz/client.ts` | create | `getFgaClient()` lazy singleton; `checkRelation(user, relation, object)` wrapper that returns `boolean \| null` (`null` = FGA unreachable), never throws |
| `src/authz/tuples.ts` | create | zod schema for the outbox `payload` this task produces; `tupleKeyForVendorAccess`; `applyOutboxEvent(row, fgaClient)` — the FGA-side interpretation of one claimed outbox row |
| `src/authz/shadow.ts` | create | `runShadowReconciliation(deps?, pageSize?)` — paginated comparison of RBAC-active vendor rows against the graph, logging disagreements |
| `src/authz/push-model.ts` | create | the script `package.json`'s existing `fga:model` already points at: compile `model.fga` via `@openfga/syntax-transformer`, `writeAuthorizationModel`, print the new model id |
| `src/db/outbox-worker.ts` | create | `drainOutbox(applyEvent, opts?)` — SQL-only claim/process/mark loop (`FOR UPDATE SKIP LOCKED`, per-row transaction), no OpenFGA import (AGENTS.md: db/ owns the outbox worker, authz/ owns the FGA calls) |
| `src/db/access.ts` | modify | `grantAccess`/`revokeAccess` wrap their existing write in `client.begin`, inserting a `vendor_access` outbox row when the affected role is `VENDOR`/`VENDOR_ADMIN`; add `listActiveVendorScopedAccess(cursor, limit, client)` for the shadow job |
| `src/jobs/outbox-worker.ts` | create | `Bun.cron("* * * * *", ...)` wiring `db/outbox-worker.ts` + `authz/tuples.ts` together |
| `src/jobs/shadow-reconciliation.ts` | create | `Bun.cron` (daily) wiring for `authz/shadow.ts` |
| `src/index.ts` | modify | side-effect import the two new job files so their `Bun.cron` schedules register on boot |
| `package.json` | modify | add `@openfga/syntax-transformer@0.2.2` dependency; add `"fga:test-model": "fga model test --tests src/authz/model.fga.yaml"` (requires the real `fga` binary on `PATH`, installed separately — not an npm/bunx tool) |
| `tests/authz/tuples.test.ts` | create | payload validation, tuple-key shape, `applyOutboxEvent` dispatch (granted/revoked/unknown), injected fake FGA client |
| `tests/authz/shadow.test.ts` | create | injected `listPage`/`checkRelation`; agreement, disagreement, and FGA-unavailable cases |
| `tests/db/outbox-worker.test.ts` | create | real schema (`withTestSchema`): claims pending rows, marks processed, retries failures with `attempts`/`last_error`, never double-processes a row an injected `applyEvent` throws on |
| `tests/db/access.test.ts` | modify | extend: granting `VENDOR`/`VENDOR_ADMIN` writes exactly one matching outbox row in the same transaction; granting a non-vendor role writes none; revoking writes a `revoked` row only when a row was actually revoked |

## Implementation requirements

1. **`src/authz/model.fga`** — copy the DSL block from `.agents/skills/openfga-authz.md` (types `user`, `vendor`, `package`, `cohort`, `course`; conditions `active_enrolment`, `active_subscription`) unchanged. This file, not a hand-written JSON object, is what gets reviewed in a PR.
2. **`src/authz/push-model.ts`**:
   - `const dsl = await Bun.file(new URL("./model.fga", import.meta.url)).text();`
   - `const model = transformer.transformDSLToJSONObject(dsl);` (in-process, `@openfga/syntax-transformer`) — no shell-out, no `Bun.$`.
   - Build a client directly from `requireLater("FGA_API_URL")`, `requireLater("FGA_STORE_ID")`, `requireLater("FGA_API_TOKEN")` (no model id).
   - `const { authorization_model_id } = await client.writeAuthorizationModel(json);`
   - `console.log()` (not the structured logger — same reasoning as `loadConfigOrExit`'s crash-log line: this must be readable with no JSON tooling to hand) the new id and the instruction to set `FGA_MODEL_ID`.
3. **`src/authz/client.ts`**:
   - `getFgaClient()`: memoised `OpenFgaClient` built from `requireLater("FGA_API_URL"|"FGA_STORE_ID"|"FGA_MODEL_ID"|"FGA_API_TOKEN")` and `credentials: { method: CredentialsMethod.ApiToken, config: { token } }`. Constructed lazily inside the function body — never at module load — so importing this file cannot crash a process that hasn't configured FGA yet (mirrors the lazy-import reasoning already used for `getProvisionVendorUser` in `src/auth.ts`).
   - `checkRelation(user: string, relation: string, object: string): Promise<boolean | null>`: calls `getFgaClient().check({ user, relation, object })`; catches every error (network, 5xx, config) and returns `null` rather than throwing — "deny by default, alert on unreachable" (security.md) applied to a function that only ever feeds a **shadow** decision, never an enforcement one.
4. **`src/authz/tuples.ts`**:
   - `const VendorAccessPayload = z.object({ userId: z.string(), vendorId: z.string(), role: z.enum(VENDOR_ROLES) })` — the outbox `payload` jsonb is external to this function's type system, validated at the boundary per code standards.
   - `tupleKeyForVendorAccess(payload)` → `{ user: \`user:${payload.userId}\`, relation: payload.role === "VENDOR_ADMIN" ? "admin" : "staff", object: \`vendor:${payload.vendorId}\` }`.
   - `applyOutboxEvent(row: OutboxRow, fgaClient: Pick<OpenFgaClient, "write">): Promise<void>`:
     - `row.aggregate !== "vendor_access"` → `log.warn("outbox_unknown_aggregate", ...)`, return (forward-compatible: a future aggregate this worker doesn't understand yet must not jam the queue).
     - Parse `row.payload` with `VendorAccessPayload` (a parse failure is a real bug in the producer — let it throw, so `attempts`/`last_error` capture it for investigation rather than silently dropping a tuple).
     - `event_type === "granted"` → `fgaClient.write({ writes: [tuple] }, { conflict: { onDuplicateWrites: "ignore" } })`.
     - `event_type === "revoked"` → `fgaClient.write({ deletes: [tuple] }, { conflict: { onMissingDeletes: "ignore" } })`.
     - anything else → throw `ValidationError` (unknown event type is a real bug, unlike an unknown *aggregate*, which is expected forward-compatibility).
5. **`src/db/outbox-worker.ts`** (SQL only, no `@openfga/sdk` import):
   - `claimAndProcessOne(applyEvent, client: SQL = sql): Promise<"processed" | "empty" | "failed">` — one `client.begin` transaction: `SELECT * FROM outbox WHERE processed_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`; empty → `"empty"`; else call `applyEvent(row)`, on success `UPDATE outbox SET processed_at = now() WHERE id = row.id` → `"processed"`; on failure `UPDATE outbox SET attempts = attempts + 1, last_error = $err WHERE id = row.id` → `"failed"` (the error is swallowed here, not rethrown — a bad row must not stop the whole batch; it's logged by the caller).
   - `drainOutbox(applyEvent, opts: { maxRows?: number; client?: SQL } = {}): Promise<{ processed: number; failed: number }>` — loops `claimAndProcessOne` up to `maxRows` (default 100) or until `"empty"`, logging `outbox_row_failed` (with the outbox id, never the payload — payload may carry a `userId` which is fine per security.md, but keep the log to ids) on each `"failed"`.
6. **`src/db/access.ts`**:
   - `grantAccess`/`revokeAccess` change their bodies to `return client.begin(async (tx) => { ...existing INSERT/UPDATE using tx...; if (row && VENDOR_ROLES.includes(row.role)) { await tx\`INSERT INTO outbox (id, aggregate, event_type, payload) VALUES (${newId("outbox")}..., 'vendor_access', ${eventType}, ${JSON.stringify({ userId: row.user_id, vendorId: row.vendor_id, role: row.role })})\`; } return row; });` — outbox has no dedicated id prefix today (`bigserial`), so no `newId()` call is needed for it; only `id, aggregate, event_type, payload` are supplied and Postgres fills `id`/`created_at`/`attempts` defaults.
   - `listActiveVendorScopedAccess(cursor: string, limit: number, client: SQL = sql): Promise<{ id: string; user_id: string; vendor_id: string; role: VendorRole }[]>` — `WHERE status = 'active' AND vendor_id IS NOT NULL AND id > ${cursor} ORDER BY id LIMIT ${limit}` (keyset, per postgres-migrations skill; ids are UUIDv7-based and lexically time-ordered, so plain `id` keyset pagination is valid here, same as every other batch job in this codebase).
7. **`src/authz/shadow.ts`**:
   - `type ShadowDeps = { listPage: (cursor: string, limit: number) => Promise<VendorScopedRow[]>; checkRelation: (user: string, relation: string, object: string) => Promise<boolean | null> }`, defaulting to `listActiveVendorScopedAccess` and `checkRelation` from `authz/client.ts`.
   - `runShadowReconciliation(deps = defaultDeps, pageSize = 500): Promise<{ checked: number; disagreements: number; unavailable: number }>` — loops pages via cursor (starting `""`, works because no legitimate id is empty string), for each row computes the expected relation (`admin`/`staff`) and calls `checkRelation`; `null` → `unavailable++` and `log.warn("authz_shadow_unavailable", { userId, vendorId })`; `false` → `disagreements++` and `log.warn("authz_shadow_disagreement", { userId, vendorId, role, rbacDecision: true, graphDecision: false })`; `true` → agreement, no log (per postgres-migrations skill: log progress and a final count, not every silent success). Final `log.info("authz_shadow_reconciliation_complete", { checked, disagreements, unavailable })`.
8. **`src/jobs/outbox-worker.ts`** / **`src/jobs/shadow-reconciliation.ts`** — thin `Bun.cron` registrations only, per `.agents/skills/testing-and-checks.md` ("schedule in jobs/, logic in `services/`[here: `db/`+`authz/`], test the logic" — nothing in these two files is unit-testable or needs to be, matching the existing test-strategy note for `Bun.cron`).
9. **`src/index.ts`** — `import "@/jobs/outbox-worker";` and `import "@/jobs/shadow-reconciliation";` near the top, alongside the other wiring imports, so both schedules register when the server boots.

## Data model impact

**None.** The `outbox` table (migration 0006) already has every column this task needs (`aggregate`, `event_type`, `payload`, `attempts`, `last_error`, `processed_at`). No new migration.

## Security requirements

- **The graph is never on the login path** (openfga-authz.md rule 2): nothing added in this task is called from `src/auth.ts`, any sign-in flow, or `provisionVendorUser`. The only two call sites of OpenFGA are the outbox-drain cron and the shadow-reconciliation cron, both off the request path entirely.
- **Deny by default on FGA unavailability**: `checkRelation` never throws and never returns `true` on failure — it returns `null`, which the shadow job treats as "unavailable", never as agreement. Nothing in this task lets an unreachable OpenFGA silently grant anything, because nothing in this task enforces the graph's decision yet at all (shadow-only, matching openfga-authz.md rule 8).
- **JIT scope is unaffected**: the vendor-access outbox events mirror exactly the `user_product_access` rows `grantAccess`/`revokeAccess` already write (masterclass/VENDOR* only, per prompts/011) — this task adds no new path that could widen access.
- **Secrets never logged**: `FGA_API_TOKEN` flows only through `requireLater`/the SDK's `credentials` config; no log line in `authz/`, `db/outbox-worker.ts`, or the two job files includes it. The logger's `DENY` list (`token`, `secret`, `credential`, `key`, ...) also redacts it if it were ever accidentally nested in a logged object.
- **Model tests are the CI negative-test gate this feature is actually for** (openfga-authz.md rule 7 / testing-and-checks.md): `model.fga.yaml` encodes "vendor A's staff cannot read vendor B's course", "an expired enrolment cannot read the course", and "a cohort member loses access when the cohort membership expires" as OpenFGA assertions, run via the real `fga model test` binary, not `bun test` — a genuinely different test runner/gate (and a real external tool install, not an npm package), called out explicitly in Checks to run below.

## Authorization impact

- **Layer 1 (RBAC)**: unchanged in behaviour; `grantAccess`/`revokeAccess` now also write an outbox row as a side effect, but the RBAC decision itself (`hasProductAdmin`, `getActiveAccessForUser`) is untouched.
- **Layer 2 (graph)**: this task is entirely Layer 2 — the model is pushed, `vendor_access` outbox events become real tuples for the first time, and shadow reconciliation gives a measurable disagreement count. Enforcement is not flipped anywhere; every existing authorization check in the codebase (`hasProductAdmin`, etc.) is untouched.
- **Layer 3 (conditions)**: the model carries `active_enrolment`/`active_subscription` conditions (needed by course/package/cohort, per the skill), but no code in this task writes a conditioned tuple — vendor admin/staff tuples are unconditioned. `None` beyond what the pushed model itself declares.

## API documentation impact

**None.** No HTTP route is added, changed, or removed by this task.

## Bun-native check

- New dependency: **`@openfga/syntax-transformer@0.2.2`** — the OpenFGA project's own DSL↔JSON parser. Corrects the plan's original assumption (`bunx @openfga/cli`, which does not exist as an npm package); this is a real, small, single-purpose addition, justified because hand-authoring the JSON `AuthorizationModel` (with its `metadata.relations[...].directly_related_user_types[...].condition` shape) would either duplicate/risk drifting from the reviewed `model.fga`, or require reimplementing a DSL parser ourselves — reaching for the upstream project's own parser is the smaller, more correct diff. `@openfga/sdk@0.9.6` is an existing declared dependency, unused until this task. Running `model.fga.yaml`'s negative-test assertions requires the real `fga` CLI (a Go binary, e.g. `brew install openfga/tap/cli`) on `PATH` — an external devtool, not an npm/bunx package, and not run as part of `bun run check`.
- `Bun.cron` for both new jobs (stack table), `Bun.$` for the transform shell-out, `Bun.file` to read the DSL — nothing here reaches for a scheduler or process-runner package.

## Acceptance criteria

- [ ] `bun run fga:model` compiles `src/authz/model.fga` and pushes it to `FGA_STORE_ID`, printing a new `authorization_model_id`.
- [ ] `fga model test --tests src/authz/model.fga.yaml` (real `fga` binary) passes, including the vendor-isolation, expired-enrolment, and expired-cohort-membership negative assertions.
- [ ] Granting `VENDOR_ADMIN`/`VENDOR` access via `grantProductAccess` produces exactly one new `outbox` row (`aggregate='vendor_access'`, `event_type='granted'`) in the same transaction as the `user_product_access` write; granting any other role produces none.
- [ ] Revoking a vendor role produces one `revoked` outbox row only when a row was actually revoked (no-op revoke → no outbox row).
- [ ] `drainOutbox` turns a pending `vendor_access`/`granted` row into a real OpenFGA tuple (verified against a real or locally-run OpenFGA instance in manual verification, mocked in `bun test`), marks it `processed_at`, and two concurrent drain calls never both claim the same row.
- [ ] A row whose `applyEvent` throws is left unprocessed with `attempts` incremented and `last_error` set, and is retried on the next drain rather than lost.
- [ ] `runShadowReconciliation` walks every active vendor-scoped access row exactly once per run (keyset pagination, no duplicates, no gaps) and logs `authz_shadow_disagreement` for any row the graph doesn't (yet) agree with, and `authz_shadow_unavailable` (not a false disagreement) when the FGA call itself fails.
- [ ] Both `Bun.cron` jobs are registered on server boot (`src/index.ts`) and neither is reachable from, nor blocks, any HTTP request path.
- [ ] `bun run check` passes.

## Tests to add

- `tests/authz/tuples.test.ts`:
  - [ ] `tupleKeyForVendorAccess` maps `VENDOR_ADMIN` → relation `admin`, `VENDOR` → relation `staff`.
  - [ ] `applyOutboxEvent` calls `write({ writes: [...] })` with `onDuplicateWrites: "ignore"` for a `granted` row.
  - [ ] `applyOutboxEvent` calls `write({ deletes: [...] })` with `onMissingDeletes: "ignore"` for a `revoked` row.
  - [ ] `applyOutboxEvent` — **negative**: an unknown `aggregate` is skipped (logged, no FGA call, no throw).
  - [ ] `applyOutboxEvent` — **negative**: an unknown `event_type` throws (so the row retries instead of being silently dropped).
- `tests/authz/shadow.test.ts` (injected `listPage`/`checkRelation`, no live DB or FGA):
  - [ ] agreement (`checkRelation` → `true`) is not logged as a disagreement.
  - [ ] disagreement (`checkRelation` → `false`) increments `disagreements` and is logged.
  - [ ] **negative**: FGA unavailable (`checkRelation` → `null`) increments `unavailable`, not `disagreements`.
  - [ ] pagination walks multiple pages to completion using the cursor, with no row visited twice.
- `tests/db/outbox-worker.test.ts` (real schema via `withTestSchema`, mocked `applyEvent` — "mock only true externals"):
  - [ ] a pending row is claimed, processed, and `processed_at` is set.
  - [ ] a row whose injected `applyEvent` throws keeps `processed_at IS NULL`, increments `attempts`, sets `last_error`.
  - [ ] `drainOutbox` with `maxRows: 1` processes exactly one row and leaves the rest pending.
  - [ ] already-processed rows are never re-claimed.
- `tests/db/access.test.ts` (extend, real schema):
  - [ ] granting `VENDOR_ADMIN` writes one `outbox` row with the matching `payload`.
  - [ ] granting `CPA`/`ADMIN`/etc. writes zero `outbox` rows.
  - [ ] revoking an active `VENDOR` row writes a `revoked` outbox row; revoking a role with no active row writes none.

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun audit`
- [ ] `bun run fga:model` against a real (or `docker run openfga/openfga run`) local OpenFGA instance, reviewing the printed model id before setting `FGA_MODEL_ID`
- [ ] `fga model test --tests src/authz/model.fga.yaml` (requires the real `fga` binary installed separately) — a distinct gate from `bun test`, not covered by `bun run check`; call this out explicitly when reporting done

## How to verify it

```bash
1. docker run -p 8080:8080 openfga/openfga run   # or any reachable OpenFGA instance
2. Set FGA_API_URL/FGA_STORE_ID/FGA_API_TOKEN (store already created), then:
   bun run fga:model
   → prints a new authorization_model_id; set FGA_MODEL_ID to it

3. fga model test --tests src/authz/model.fga.yaml   # requires the real fga binary, e.g. `brew install openfga/tap/cli`
   → all assertions pass, including the vendor-isolation and expired-enrolment negative cases

4. bun run check
   → typecheck, full suite (incl. the new authz/db tests), audit all pass

5. bun run dev, then (with an ADMIN-for-masterclass session) grant a VENDOR role via
   POST /api/admin/access — confirm a new `outbox` row appears:
   psql $DATABASE_URL -c "select aggregate, event_type, payload, processed_at from outbox order by id desc limit 1"
   → aggregate='vendor_access', event_type='granted', processed_at initially NULL

6. Within a minute, re-run the same query
   → processed_at is now set (the Bun.cron drain ran); confirm the tuple exists via
   the OpenFGA API or `fga tuple read` for user:<id> vendor:<id>

7. Trigger the shadow job directly in a REPL/test rather than waiting for the daily
   schedule: `await runShadowReconciliation()` → { checked: 1, disagreements: 0, unavailable: 0 }
   for the row just drained
```

## Out of scope for this task

- **Backfill** of tuples for vendor-scoped rows granted *before* this task shipped (roadmap step 11 explicitly separates "outbox worker" from "backfill"; the user's request named the three delivered here). Expected, not a bug: the shadow job will report disagreements for every pre-existing vendor grant until a backfill runs — a natural, obvious follow-up task, not silently swept under this one.
- **Course/package/cohort tuple production.** No data for these exists in this repository; LMS and Masterclass own that data and will need their own outbox-equivalent producers when they're built (a later, separate task per each product's own repo/roadmap item).
- **Flipping enforcement** anywhere. Shadow mode only logs; no existing authorization check anywhere in this codebase is changed to consult the graph.
- **Creating the OpenFGA store itself** (`FGA_STORE_ID` provisioning) — an ops action, out of scope, same category as provisioning `DATABASE_URL`.
- **A vendor-admin-manages-own-staff HTTP endpoint.** The `vendor#admin`/`vendor#staff` relations exist in the model and now sync via the outbox, but no route in this repo lets a vendor admin grant/revoke their own staff's access yet — that is presumably a future, separate feature built on top of this one.
- **Per-request `Check`/`ListObjects` wrappers for products to call.** `authz/client.ts` exposes `checkRelation` for the shadow job's own use; a general-purpose, product-facing Check/ListObjects API is a later task once a real product actually needs to call it.
