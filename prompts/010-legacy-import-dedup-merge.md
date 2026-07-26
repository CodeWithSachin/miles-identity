# 010 — Legacy hash import (LMS + Miles One), dedup passes, merge procedure

---

## Goal

Generalise step 9's Masterclass-only legacy password import to LMS and Miles One, then add the batch job that finds the same real person living under more than one Miles Identity user (via §8's tiered confidence passes) and a reversible transactional procedure to merge them.

## What it read

- Skills: `.agents/skills/alias-identity.md`, `.agents/skills/postgres-migrations.md`, `.agents/skills/better-auth.md`, `.agents/skills/security.md`
- Docs: `docs/architecture-plan.md` §7 (password migration, lines 461–484), §8 (identity deduplication, lines 488–535)
- Files actually opened: `AGENTS.md`, `prompts/009-masterclass-oidc-legacy-login.md`, `prompts/TEMPLATE.md`, `src/auth.ts`, `src/lib/config.ts`, `src/lib/pbkdf2.ts`, `src/db/types.ts`, `src/db/client.ts`, `src/db/identity.ts`, `src/db/access.ts`, `src/db/migrations/0002_user_identity.sql`, `0004_user_product_access.sql`, `0005_identity_merge_log.sql`, `0007_add_user_foreign_keys.sql`, `src/services/legacy-import.ts`, `src/services/legacy-rehash.ts`, `src/integrations/legacy-masterclass-db.ts`, `src/db/migrate.ts`, `tests/helpers/database.ts`, `package.json`
- Better Auth internals inspected directly (`node_modules/better-auth`, `node_modules/@better-auth/core`, `node_modules/@better-auth/oauth-provider`) to confirm what's actually callable for session/token revocation — the skill names the requirement but not the API surface:
  - `passwordHasher.verify` only ever receives `{ hash, password }` — **no user/account context** — confirmed in `node_modules/better-auth/dist/crypto/password.d.mts`.
  - `internalAdapter.deleteUserSessions(userId): Promise<void>` exists (`@better-auth/core/dist/types/context.d.mts:96`) — kills every session row for a user, matching "sessions are DB-backed, revocation is deleting a row" in `.agents/skills/better-auth.md`.
  - `oauthAccessToken` (the table backing both access and refresh grants) has a first-class `userId` field (`@better-auth/oauth-provider/dist/oauth-BFBataE_.d.mts:237`), reachable through the same generic `adapter.deleteMany({ model, where })` primitive `src/db/seed-oauth-clients.ts` already uses against `oauthClient` — no plugin-specific "revoke all for user" helper exists, so this generic call is the sanctioned way to touch it, not raw SQL.
- Specific facts taken:
  - `src/lib/config.ts` already declares `LEGACY_LMS_DATABASE_URL` and `LEGACY_MILES_ONE_DATABASE_URL` (tier 2, unvalidated scheme, same as `LEGACY_MASTERCLASS_DATABASE_URL`) — the config-side plumbing for this step was laid down in step 1 and never used until now.
  - `docs/architecture-plan.md:14-15`: LMS is Node (bcrypt, "almost certainly"), Miles One is Django (same `pbkdf2_sha256$…` format as Masterclass).
  - `src/auth.ts`'s `passwordHasher.verify` currently branches only on hash *shape* (`pbkdf2_sha256$` prefix vs. everything else via `Bun.password.verify`, which auto-detects bcrypt and argon2id) — this is format-dispatch, not product-dispatch, and stays that way (see Assumption 3).
  - `src/services/legacy-rehash.ts` is entirely hash-format-agnostic: it only checks `user.importedHashAlgo` for truthiness and always rehashes to argon2id via `passwordHasher.hash`. It needs **zero changes** for this task.
  - `user_identity`'s `uq_identity_value UNIQUE (type, value)` (migration 0002) is **global**, not per-user. This means two *different* users can never hold the same verified email or phone in this database — a duplicate on an exact handle is structurally impossible once import has run. That rules out the deterministic tiers B (email) and C (phone) ever firing against **already-imported** Miles Identity data; see Assumption 5, which is the load-bearing finding of this plan.
  - None of the three legacy account fetchers (`LegacyMasterclassAccount` and its two new siblings) carry a phone number or a `salesforce_contact_id` — only email, password hash, active flag, first/last name. Tiers A (Salesforce) and C/D (phone) have no matching data to run against yet; see Assumption 6.
  - `identity_merge_log` (migration 0005) and `user.status`/`user.mergedIntoUserId` (already in `src/auth.ts`'s `additionalFields`) already exist — the merge procedure needs **no new migration** for its own bookkeeping, only for the dedup candidate queue (below).
  - `.agents/skills/postgres-migrations.md`'s merge-procedure sketch places session/token revocation (step 7) and the product-DB `identity_user_id` backfill (step 6) **outside** the "steps 1–5 in one `Bun.sql` transaction" envelope — confirmed against Better Auth's actual API surface above, since those two clients (`Bun.sql` for our tables, `pg` for Better Auth's) cannot share one transaction anyway.
  - Step 6 (updating `identity_user_id` in each product's own database) is each product's own migration per `docs/architecture-plan.md` §6 — out of scope for this repo entirely, not merely this task.

## Assumptions

1. **LMS's legacy schema mirrors Masterclass's** (`email`, `password`, `is_active`, `first_name`, `last_name` — table name assumed `auth_user`-shaped; exact table/column names to confirm against a real LMS staging copy before this runs anywhere else, same caveat prompts/009 already carries for Masterclass). If wrong, only `src/integrations/legacy-lms-db.ts` changes.
2. **Miles One's legacy schema is Django's default `auth_user`**, same shape and same `pbkdf2_sha256$…` format as Masterclass (both are Django per `docs/architecture-plan.md:15`) — confirm before running outside staging. If wrong, only `src/integrations/legacy-miles-one-db.ts` changes.
3. **No new password-verify branch, no new gate flag.** LMS's bcrypt import needs nothing new in `passwordHasher.verify` — `Bun.password.verify` already auto-detects bcrypt. Miles One's PBKDF2 import reuses the *existing* `verifyDjangoPbkdf2` branch, but **not** `MASTERCLASS_LEGACY_PASSWORD_LOGIN_ENABLED` — that flag is renamed to `DJANGO_LEGACY_PASSWORD_LOGIN_ENABLED` and now gates *any* imported Django PBKDF2 hash, Masterclass's or Miles One's. Rationale: the flag's actual job (per prompts/009 Assumption 6 and `docs/architecture-plan.md:484`) is "is our hand-rolled PBKDF2 verifier safe to trust in production" — a property of the *verify code*, not of which product the row came from. `passwordHasher.verify` cannot distinguish source anyway (no user context reaches it, see "What it read" above), so a per-product flag would require moving the gate into a `hooks.before` user lookup — real added complexity for a distinction the flag was never actually protecting against. Rollout sequencing per product (Masterclass now, LMS/Miles One later per the phased plan) is controlled by **when each import script is run**, not by an additional flag. **This is the one design choice most worth pushing back on if per-product kill-switches are wanted.**
4. **This is a rename of an existing env var**, not an addition — `MASTERCLASS_LEGACY_PASSWORD_LOGIN_ENABLED` → `DJANGO_LEGACY_PASSWORD_LOGIN_ENABLED` in `src/lib/config.ts` and `src/auth.ts`. Acceptable because the system has no production traffic yet (still Phase 1/2 per the rollout plan) and the old name becomes actively misleading once Miles One imports land. If any environment already sets the old name, it must be renamed at deploy time — flagged here rather than done quietly.
5. **The deterministic tiers (A/B/C) cannot fire against data already inside Miles Identity, and that's correct, not a gap.** Because `uq_identity_value` is global, by the time two products have each run their import, a shared verified email or phone would already have caused the *second* import to skip that row (`identityValueExists` check, unchanged from step 9) rather than create a second user — the exact-handle duplicate is prevented at the point of creation, not found afterward. So the dedup pass in this task operates on the *remaining* case §8 actually calls "the trap": two users who used **different** handles for the same person, discoverable only by a weaker signal (name). That is Tier E. Tiers A and C/D are wired into the query (cheap, and forward-compatible) but will not match anything until Salesforce contact ingestion and phone data exist — see Assumption 6. **Tier B is not implemented as a live query at all** — it is structurally unreachable per the above, and a query that can never return a row is not worth writing.
6. **No Salesforce contact source and no phone numbers exist in the legacy account data available today.** Tier A (`salesforce_contact_id` equality) is written against `user.salesforceContactId` (the column already exists, unused, from step 8) so it activates for free once Salesforce provisioning lands; it will find nothing until then. Tiers C and D (phone-based) are **out of scope for this task** — none of the three legacy fetchers return a phone number, so there is nothing to compare. Adding phone data is a separate, larger task (each legacy product's schema would need inspection for a phone column).
7. **Tier E drops the "same institution" qualifier from `docs/architecture-plan.md:504`.** "Institution" (course/cohort membership) is LMS/Masterclass content data, explicitly out of scope for Miles Identity per `AGENTS.md`'s scope list. The buildable version of Tier E is: same normalised name (fuzzy ≥ 0.9), appearing on users from **different** `user_identity.source` values, with no shared verified handle (guaranteed by Assumption 5) between them. This is *weaker* evidence than the doc's original Tier E, which is exactly why it stays manual-review-only, never auto-merged — consistent with the doc's own tier table.
8. **Name similarity is a small local function, not a dependency.** No fuzzy-string-matching package exists in `package.json` and Bun/Node's stdlib has none built in. A ~20-line normalised Levenshtein-ratio function in `src/identity/name-similarity.ts` is the whole implementation — this is genuinely a "can it be one line-ish" case, not grounds for a dependency (AGENTS.md tech table has no fuzzy-match row to defer to).
9. **The dedup pass is a one-off CLI script, run manually, not a `Bun.cron` job** (`src/jobs/` stays untouched) — matching `legacy-import.ts` and `seed-oauth-clients.ts`'s existing precedent, and per `docs/architecture-plan.md:490`, "run this before any SSO goes live," i.e. an operator-triggered pre-launch step, not a recurring schedule.
10. **Auto-merge (tiers A–C) and the manual-review queue (tiers D/E) both go through the exact same `mergeUsers` transactional procedure** — the only difference is *who* calls it and *when*: the dedup script calls it immediately for an A/B/C match it just found; a D/E row sits in `dedup_candidate` with `status='pending'` until a human decides, and **acting on that decision (an admin route or script to mark `approved` and invoke the merge) is out of scope for this task** — the review queue exists and is queryable via direct SQL/psql for now, same as any other pre-launch reconciliation step. Building that UI before there is a single real pending row to review would be speculative.
11. **`mergeUsers` picks the survivor exactly per the skill**: oldest verified account (`created_at`), or the Salesforce-linked one if either side has `salesforceContactId` set (Salesforce-linked wins outright, per the skill's ordering — "oldest verified, **or** the Salesforce-linked one").
12. **Step 6 of the merge procedure (updating `identity_user_id` in LMS/Miles One/Masterclass's own databases) is not built here.** It requires write access to three other teams' schemas and is explicitly each product's own migration per `docs/architecture-plan.md` §6 — out of scope for this repository, not just this task.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/lib/config.ts` | modify | Rename `MASTERCLASS_LEGACY_PASSWORD_LOGIN_ENABLED` → `DJANGO_LEGACY_PASSWORD_LOGIN_ENABLED` |
| `src/auth.ts` | modify | Use the renamed config key in `passwordHasher.verify`; update the surrounding comments (no behavioural change beyond the rename) |
| `src/integrations/legacy-lms-db.ts` | create | Mirrors `legacy-masterclass-db.ts`: `Bun.SQL` against `LEGACY_LMS_DATABASE_URL`, `fetchLegacyLmsAccounts()` |
| `src/integrations/legacy-miles-one-db.ts` | create | Mirrors `legacy-masterclass-db.ts`: `Bun.SQL` against `LEGACY_MILES_ONE_DATABASE_URL`, `fetchLegacyMilesOneAccounts()` |
| `src/services/legacy-import.ts` | modify | Generalise `importLegacyMasterclassUsers` into `importLegacyUsers(source, deps)` parameterised on `LegacySource` ("lms" \| "miles_one" \| "masterclass"), each with its own fetcher and `importedHashAlgo` ("node_bcrypt" \| "django_pbkdf2"); CLI entrypoint reads `--source=` from `Bun.argv` |
| `src/identity/name-similarity.ts` | create | `nameSimilarity(a, b): number` — normalised (lowercase, trimmed, whitespace-collapsed) Levenshtein ratio, 0–1 |
| `src/db/migrations/0008_dedup_candidate.sql` | create | `dedup_candidate` table: the reviewed mapping table §8 requires — see Data model impact |
| `src/db/dedup.ts` | create | SQL for this migration only: `findDedupCandidates` (cross-source name-similarity query + Tier A salesforce-id query), `insertDedupCandidate`, `listPendingDedupCandidates` |
| `src/db/types.ts` | modify | Add `DedupCandidateRow` type and `DEDUP_CANDIDATE_STATUSES` |
| `src/identity/merge.ts` | create | `mergeUsers(input, deps)` — the reversible transactional procedure (steps 1–5 in one `Bun.sql` transaction; step 7 session/token revocation immediately after, via injected Better-Auth-adapter calls) |
| `src/services/dedup.ts` | create | Orchestrates passes 1–2 (`findDedupCandidates`, persisted via `insertDedupCandidate`) and pass 3 for auto tiers (calls `mergeUsers` for every A/B/C match); CLI entrypoint, `import.meta.main` |
| `package.json` | modify | Replace `masterclass:legacy-import` with `legacy-import` (takes `--source=`); add `dedup:run` |
| `tests/services/legacy-import.test.ts` | modify | Parameterise existing cases across all three sources; add a case per source's `importedHashAlgo` |
| `tests/identity/name-similarity.test.ts` | create | Known similar/dissimilar name pairs, idempotence, empty-string handling |
| `tests/identity/merge.test.ts` | create | Full procedure against a disposable schema (per `tests/helpers/database.ts`) — see Tests to add |
| `tests/services/dedup.test.ts` | create | Tier E candidates only found across different `source`s with no shared handle; Tier A wired-but-inert without a `salesforceContactId`; never proposes a merge for two identical users, never proposes tier B/C |
| `tests/db/constraints.test.ts` | modify | Add: `dedup_candidate` rejects `user_id_a = user_id_b`; rejects an unknown `tier`/`status` |
| `tests/lib/config.test.ts` | modify | Rename assertions for `DJANGO_LEGACY_PASSWORD_LOGIN_ENABLED` |

## Implementation requirements

**A — Legacy hash import, generalised**

1. `LegacySource = "lms" | "miles_one" | "masterclass"`. `importLegacyUsers({ source, importedHashAlgo, fetchAccounts }, deps)` keeps step 9's exact per-row logic (skip inactive, skip if `identityValueExists`, else create user + account + verified identity) — only the source label and hash-algo string vary per call.
2. `legacy-lms-db.ts` / `legacy-miles-one-db.ts`: same shape as `legacy-masterclass-db.ts` — lazy `Bun.SQL` client, one exported fetch function, never called outside the import script.
3. CLI: `bun run src/services/legacy-import.ts --source=lms|miles_one|masterclass`. Missing/invalid `--source` is a startup error, not a silent default.
4. No change to `legacy-rehash.ts`, `pbkdf2.ts`, or the shape of `passwordHasher.verify`'s branching — only the config key name changes (Assumption 3–4).

**B — Dedup passes 1–2**

5. `findDedupCandidates(client)` in `src/db/dedup.ts`:
   - **Tier A**: join `"user"` to itself on `salesforce_contact_id IS NOT NULL AND salesforce_contact_id` equal, excluding self-pairs and already-decided pairs.
   - **Tier E**: for every pair of users whose `user_identity.source` sets are disjoint (no product in common) and who share no verified `(type, value)` (true by construction per Assumption 5, but the query does not rely on that — it explicitly checks), compute `nameSimilarity(user_a.name, user_b.name) >= 0.9`. Scope the comparison to avoid an O(n²) full cross-join on 300K+ rows: bucket by a cheap blocking key first (e.g. first 3 characters of the normalised name) and only compare within a bucket — this is the standard blocking technique for this exact problem, not premature optimisation.
   - Tiers C/D are not queried (Assumption 6) — the function's return type still names them in its tier union so the schema/type doesn't need to change again when phone data arrives.
6. `insertDedupCandidate`: `ON CONFLICT (user_id_a, user_id_b) DO NOTHING` — idempotent re-runs (postgres-migrations skill: batch jobs must be idempotent).
7. `src/services/dedup.ts`, CLI entrypoint: run `findDedupCandidates`, persist every result, then for every **A** or (buildable) **B/C** result call `mergeUsers` immediately and mark the candidate `status='merged'`; every **E** result stays `status='pending'`. Print a reconciliation count on exit: candidates found per tier, auto-merged, left pending — never just "it finished" (postgres-migrations skill).

**C — Merge procedure**

8. `mergeUsers(input: { survivorId, loserId, tier, evidence, actor }, deps)`:
   - Steps 1–5 (pick survivor already decided by caller per Assumption 11 — this function receives the decision, it does not re-derive it; move identities with primary-per-type recomputed; union active `user_product_access` rows with a `NOT EXISTS` guard so the unique constraint is never hit; insert `identity_merge_log`; flip loser to `status='merged', merged_into_user_id=survivor`) run inside one `sql.begin` transaction (`tx`, never the outer `sql` — `.agents/skills/postgres-migrations.md`).
   - Step 7 (revoke both users' sessions and tokens) runs **after** that transaction commits, via injected `deps.deleteUserSessions(userId)` (×2) and `deps.revokeOAuthTokens(userId)` (×2, via the generic `adapter.deleteMany` on `oauthAccessToken`) — separate `pg` pool, cannot share the `Bun.sql` transaction (see "What it read").
   - Never deletes the loser's `user` row or its `user_identity` rows — they now point at the survivor and stay that way permanently (skill: "NEVER DELETE").
   - Idempotent: calling it twice for an already-merged loser is a no-op (loser's `status` is already `'merged'` — detect and return early rather than erroring).

## Data model impact

- New migration `0008_dedup_candidate.sql`:
  ```sql
  CREATE TABLE dedup_candidate (
    id           text        PRIMARY KEY,
    user_id_a    text        NOT NULL REFERENCES "user"(id),
    user_id_b    text        NOT NULL REFERENCES "user"(id),
    tier         text        NOT NULL CHECK (tier IN ('A','B','C','D','E')),
    evidence     jsonb       NOT NULL,
    status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','rejected')),
    decided_by   text,
    decided_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_dedup_distinct CHECK (user_id_a <> user_id_b),
    CONSTRAINT uq_dedup_pair UNIQUE (user_id_a, user_id_b)
  );
  CREATE INDEX ix_dedup_pending ON dedup_candidate (tier) WHERE status = 'pending';
  ```
  FK direct to `"user"` (not deferred like 0002 was) — `"user"` already exists by this point in the roadmap, unlike step 2's timing.
- `identity_merge_log`, `user.status`, `user.merged_into_user_id`: no schema change, already exist (steps 8/9).
- **Config rename**: `MASTERCLASS_LEGACY_PASSWORD_LOGIN_ENABLED` → `DJANGO_LEGACY_PASSWORD_LOGIN_ENABLED` (Assumption 3–4).

## Security requirements

- **Takeover path 2 (linking OTP to the new handle) does not apply** — this task never sends an OTP; it moves already-verified handles between users under human-reviewed or deterministic-tier evidence, never on a user's live say-so.
- **Never auto-merge on phone alone** (the actual §8 trap) — moot for this task since no phone data exists yet (Assumption 6), but the code must not grow a path that would do this later without the same tiering discipline; `mergeUsers` has no caller in this task that decides a tier from phone evidence alone.
- **Tier E must never auto-merge.** Enforced by the dedup script only calling `mergeUsers` for A/B/C results; an E result is written to `dedup_candidate` and nothing else touches `mergeUsers` for it.
- **Session and refresh-token revocation on every merge** (security skill: "Revoke sessions and refresh tokens on ... every merge") — both survivor and loser, not just the loser: the security skill is explicit that *both* get revoked, since the survivor's own token claims (`products`) may now be stale the instant access is unioned.
- **`identity_merge_log` stays append-only** (trigger already in migration 0005) — this task's writer only ever `INSERT`s, never `UPDATE`/`DELETE`s it.
- **Never log** a legacy password hash, a name, an email, or a phone number from the dedup/merge pipeline — only `usr_` ids and tiers, per the security skill and the existing precedent in `legacy-import.ts`'s `log.info`.
- **The dedup CLI and merge procedure are never reachable over HTTP** in this task — no route is added. A future admin review-queue UI (Assumption 10) would need its own authorization design (ADMIN role, per-product scoping) — explicitly not decided here.

## Authorization impact

- Layer 1 (RBAC): `mergeUsers`'s product-access union can only ever **add** rows to the survivor that already existed (as active grants) on the loser — it grants nothing new, only carries forward what a real grant already established. No new grant path, no new admin endpoint.
- Layer 2/3 (graph, conditions): none — `authz/` is untouched; nothing here writes an OpenFGA tuple.

## API documentation impact

None — no route is added, changed, or removed.

## Bun-native check

- New dependencies: none.
- `src/identity/name-similarity.ts` (Assumption 8): a small Levenshtein-ratio function is hand-written rather than adding a package (`string-similarity`, `fastest-levenshtein`, etc.) — Bun/Node stdlib has no fuzzy-match primitive, and the whole implementation is short enough that a dependency would be pure overhead for a rung-7 "minimum code that works" case.
- Two new `Bun.SQL` clients (`legacy-lms-db.ts`, `legacy-miles-one-db.ts`) — same pattern as the existing `legacy-masterclass-db.ts`, not a new kind of client.

## Acceptance criteria

- [ ] `bun run src/services/legacy-import.ts --source=lms` and `--source=miles_one` import active, not-already-claimed accounts the same way Masterclass's import already does, tagging `importedHashAlgo` correctly per source.
- [ ] `DJANGO_LEGACY_PASSWORD_LOGIN_ENABLED=false` (default) blocks password sign-in for both Masterclass and Miles One imported-but-not-rehashed accounts; OTP still works for both.
- [ ] `bun run src/services/dedup.ts` populates `dedup_candidate` with Tier E rows for two users who share a fuzzy-matching name across different `source`s and no shared handle, and auto-merges (via `mergeUsers`) any Tier A match it finds.
- [ ] `mergeUsers` moves every identity and active access row from loser to survivor, writes exactly one `identity_merge_log` row, sets the loser to `status='merged'` with `merged_into_user_id` set, and never deletes the loser's `user` row.
- [ ] After a merge, both survivor's and loser's prior sessions are gone and their `oauthAccessToken` rows are gone.
- [ ] Re-running the dedup script or calling `mergeUsers` twice for the same pair does not error and does not duplicate the merge log entry.

## Tests to add

- [ ] `tests/services/legacy-import.test.ts` — each of the three sources imports correctly with its own `importedHashAlgo`; a row whose email already resolves to an existing user (any source) is skipped, not merged, not errored — **negative**: an inactive row is never imported regardless of source.
- [ ] `tests/identity/name-similarity.test.ts` — `nameSimilarity("Ananya Rao", "Ananya Rao") === 1`; a near-miss (typo) scores ≥ 0.9; two unrelated names score low; idempotent on repeated normalisation.
- [ ] `tests/services/dedup.test.ts` — Tier E fires only across different sources with no shared handle; Tier A fires when `salesforceContactId` matches and is inert (finds nothing) when it's null on both sides; **negative**: never proposes a candidate for two users who already share a verified handle (structurally impossible, asserted anyway); never calls `mergeUsers` for a Tier E result.
- [ ] `tests/identity/merge.test.ts` — full merge moves identities (recomputing `is_primary` correctly when both survivor and loser had a primary for the same type), unions access without violating `uq_access_user_product_role`, writes one append-only log row, sets loser `status='merged'` and never deletes it, revokes both users' sessions and `oauthAccessToken` rows — **negative**: calling `mergeUsers` on an already-merged loser is a no-op, not an error; a second call does not write a second log row.
- [ ] `tests/db/constraints.test.ts` — `dedup_candidate` rejects `user_id_a = user_id_b`; rejects a `tier` or `status` outside the CHECK list.

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun audit`
- [ ] `bun run db:migrate` on a staging clone (migration 0008)

## How to verify it

```bash
1. bun run db:migrate --dry-run
   → lists 0008_dedup_candidate.sql as pending, nothing else
2. bun run check
   → typecheck, full test suite (including tests/db/*, requires TEST_DATABASE_URL), audit all pass
3. TEST_DATABASE_URL=... bun test tests/identity/merge.test.ts
   → after a merge: `SELECT status, merged_into_user_id FROM "user" WHERE id = $loser` returns
     ('merged', survivorId); `SELECT COUNT(*) FROM session WHERE "userId" IN ($survivor,$loser)` returns 0
     — this is the security property (both sides' sessions actually gone), not just a passing assertion.
4. bun run src/services/dedup.ts (against a seeded staging DB with two intentionally-similar-named users
   from different sources)
   → prints a reconciliation line, e.g. "2 candidates (0 A, 0 B, 0 C, 0 D, 2 E), 0 auto-merged, 2 pending"
   → `SELECT * FROM dedup_candidate WHERE status='pending'` shows exactly those two rows
```

## Out of scope for this task

- Salesforce contact ingestion (Tier A stays wired but inert until it exists).
- Phone numbers in the legacy account fetchers (Tiers C/D — no source data to run against).
- An admin route/UI to approve a pending Tier D/E `dedup_candidate` and trigger its merge — the queue is queryable directly for now.
- Pass 4, "lazy consolidation at login" (unrecognised handle → link via OTP to an existing account) — a login-time flow, not a batch job, and a separate concern from this task.
- Updating `identity_user_id` in LMS/Miles One/Masterclass's own databases (merge step 6) — each product's own migration, per `docs/architecture-plan.md` §6, not this repository.
- Any change to `is_verified`/`source` semantics for Salesforce-provisioned (unverified) leads — untouched, unrelated to this task.
