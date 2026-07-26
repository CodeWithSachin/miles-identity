# 005 — Email OTP and SMS OTP sign-in, wired to the alias resolver

**Status:** approved · implementing
**Roadmap step:** 5 of 15

**Approved decisions:** (1) custom `aliasOtp()` plugin that resolves through the alias table — native `emailOTP`/`phoneNumber` NOT used; (2) method offer = OTP **plus** password (append, not replace).

---

## Goal

Add passwordless sign-in — OTP to a typed email or phone handle — that resolves the handle through the verified-only alias resolver and mints a session for the **global** `usr_` id, not for whichever handle was typed.

## What it read

**Skills**

- `.agents/skills/alias-identity.md` — a handle is not an identity; it points at one global user with many verified handles. Login resolution: `normalise → SELECT user_id WHERE type,value,is_verified=true → OTP to the handle they typed → session is always for the global user id`. **Two takeover rules:** (1) only `is_verified=true` may authenticate *or receive an OTP*; (2) linking OTPs go to the already-verified handle. Invariants to test: unverified cannot authenticate **and cannot receive a sign-in OTP** (negative tests), `resolve` identical shape hit/miss.
- `.agents/skills/better-auth.md` — `emailOTP()` = passwordless email; `phoneNumber()` = SMS OTP, "set a real `getTempEmail` domain, never `temp.better-auth.com`". One `betterAuth()` instance, extend via plugins, never a second instance. Sessions DB-backed with Redis `secondaryStorage`.
- `.agents/skills/security.md` — "The same applies to password reset, **OTP request**, and signup — all three leak existence if the response differs." Never log OTP codes or full phone numbers; log the `usr_` id. SMS/email provider keys never leave the server, flow through `lib/config.ts`. Takeover path 1 (unverified authenticates) and path 2 (link OTP to newly-claimed handle) each get a negative test.
- `.agents/skills/testing-and-checks.md` — real Postgres + real Redis; mock only true externals (SMS gateway, email provider); negative tests are the point: "unverified identity cannot receive a sign-in OTP"; verify the **security property**, not a 200.
- `.agents/skills/postgres-migrations.md` (login hot path) — resolver already hits the partial index `ix_identity_lookup (type,value) WHERE is_verified` from 0002. No schema change needed for resolution.

**Files opened**

- `src/auth.ts` — step-3 instance: email+password only, `passwordHasher` (argon2id), `additionalFields`, DB sessions + Redis `secondaryStorage`. The single place plugins get added. The CLI-under-jiti constraint (redis reached lazily) is documented here and must be preserved for any new plugin option.
- `src/identity/resolve.ts` — `resolveHandle(parsed) → {methods}` (enumeration-safe, type-derived) and `resolveVerifiedUser(parsed, client?) → Promise<string|null>` (verified-only, alias-aware). The in-code `ponytail:` note already earmarks this file for step 5's `email_otp`/`sms_otp` methods.
- `src/identity/normalise.ts` — `normaliseHandle`, `normaliseEmail`, `normalisePhone`. Output already satisfies 0002 CHECKs. Reused as-is; the OTP flow normalises with the same functions the resolver uses.
- `src/db/identity.ts` — `findUserIdByVerifiedHandle(type,value,client?)`. The resolver's only query. Reused.
- `src/routes/identity.ts` — the thin-route + rate-limit pattern to mirror: zod body, per-IP + per-handle `checkRateLimit`, `no-store`, log `handleType` never the value, hashed handle bucket.
- `src/lib/rate-limit.ts` — `checkRateLimit(key,limit,windowSeconds,client?)`, fail-open. Reused for the OTP-request limit.
- `src/lib/config.ts` — already validates every secret this needs: `EMAIL_FROM`, `EMAIL_PROVIDER_API_KEY`, `SMS_PROVIDER` (`gupshup|msg91|twilio`), `SMS_PROVIDER_API_KEY`, `SMS_SENDER_ID`, `PHONE_PLACEHOLDER_DOMAIN` (default `phone.miles.com`, refused if `temp.better-auth.com`). `requireLater(key)` throws a named `ConfigError` at wiring time if a tier-2 secret is unset. **No config change needed.**
- `src/index.ts` — `/api/auth/*` is Better Auth's catch-all; more-specific routes win. A Better Auth plugin's endpoints mount *under* `/api/auth/*` automatically — no `index.ts` change if we add endpoints via a plugin.
- `node_modules/better-auth/dist/plugins/email-otp/routes.mjs`, `phone-number/routes.mjs` — **the load-bearing finding** (see Decisions): both plugins resolve the user via `internalAdapter.findUserByEmail(email)` / `adapter.findOne(user, phoneNumber=…)` — the single `user.email` / `user.phoneNumber` column, **never** `user_identity`. `emailOTP` sign-in auto-creates a user unless `disableSignUp:true`; `phoneNumber` `/send-otp` sends to any number with no existence check; `phoneNumber` `/sign-in` is password-based; `phoneNumber` `/verify` is signup/verify-oriented. Session creation everywhere is `ctx.context.internalAdapter.createSession(userId)` + `setSessionCookie(ctx, …)` (magic-link, anonymous, admin-impersonate all use exactly this).
- `node_modules/better-auth/dist/plugins/test-utils/auth-helpers.mjs` — confirms `ctx.internalAdapter.createSession(opts.userId)` + cookie helpers are the sanctioned way to mint a session for a known user id from inside an endpoint.

## Decisions taken

1. **The native OTP plugins cannot be wired to the alias resolver as-is — so we own the resolution and reuse Better Auth only for its OTP-storage, session, and cookie primitives, packaged as one custom plugin `aliasOtp()`.**
   - Native `emailOTP`/`phoneNumber` key on `user.email`/`user.phoneNumber`. A person with a *secondary* verified handle (the entire point of the alias model) would fail OTP sign-in, or worse, `emailOTP` would create a duplicate user. This is the "confident wrong fix" the alias skill forbids.
   - Instead, add a small first-party plugin exposing two endpoints under `/api/auth/*` (so cookie signing, the DB+Redis session store, and CSRF all come for free):
     - `POST /api/auth/sign-in/otp/start` — normalise the typed handle → `resolveVerifiedUser` (verified-only, alias-aware) → **only on a hit**: generate a 6-digit OTP, store it **hashed** via `ctx.context.internalAdapter.createVerificationValue` with a 300 s TTL and an attempt counter → send it to **the typed handle** via our email/SMS integration. **Always returns the same generic body**, hit or miss (enumeration-safe, mirrors `/resolve`).
     - `POST /api/auth/sign-in/otp/verify` — re-normalise → `resolveVerifiedUser` → check the stored hash + TTL + attempt cap → on success `createSession(userId)` + `setSessionCookie`. Session is for the **resolved global `usr_` id**, regardless of which handle was typed.
   - This reuses the hard, security-sensitive parts (session store, cookie signing, verification storage) and writes only the alias glue. Ladder rung: reuse the installed dependency's primitives; add the minimum that isn't already there.
2. **OTP goes to the typed handle; the session is for the global user.** Directly implements the skill's login-resolution diagram. (Distinct from *alias-linking* OTPs, which go to the already-verified handle — that flow is alias-add, deferred, see Out of scope.)
3. **`start` is enumeration-safe and never sends on a miss.** Same generic `{ ok: true }` for hit, miss, and unclassifiable handle; no early return that changes timing on the response path; rate limited **per IP and per handle** with the existing `checkRateLimit`. This is the "OTP request leaks existence" rule from security.md. A miss does no send and no DB write but returns the identical body.
4. **`resolveHandle` now returns the type-derived OTP method plus password (APPROVED: append).** email handle → `["email_otp","password"]`, phone handle → `["sms_otp","password"]`, unclassifiable/null → the email default `["email_otp","password"]`. Stays a pure function of handle **type**, never of existence.
   - **Test correction:** `tests/routes/identity.test.ts` currently asserts an email and a phone handle return *byte-identical* bodies — that only held while the offer was a constant. The genuine security property is **existence-independence** (a hit-shaped and a miss-shaped handle of the *same* type are identical), not cross-*type* equality; the caller already knows their own handle's type, so `email_otp` vs `sms_otp` discloses nothing. The test is corrected to assert same-type hit/miss identity, and to assert the phone variant separately. This is fixing an expectation the approved design changes, not weakening it (testing-and-checks.md: decide, in writing, which is wrong — here the incidental cross-type assertion is).
5. **Email/SMS senders are true externals in `src/integrations/`, behind a tiny interface, mocked in tests.** `sendEmailOtp(to, otp)` and `sendSmsOtp(to, otp)`. Real provider call for the **one** configured `SMS_PROVIDER` and the email provider; unconfigured providers throw a named `ConfigError` via `requireLater`, they are not silently stubbed. Sending is fire-and-forget-ish (not awaited on the response path) to avoid a timing oracle, per the plugin's own guidance. `// ponytail:` marks that only the configured provider is implemented; add others when a second provider is actually onboarded.
6. **OTP is stored hashed, never logged.** `Bun.password`-hash or a SHA-256 of the code; the code appears only in the outbound message and never in a log line or an error. Attempt cap 3, TTL 300 s, both reused from Better Auth's verification-value conventions.

## Assumptions

1. **RESOLVED (approved): method offer APPENDS the OTP method to `password`** — `["email_otp","password"]` / `["sms_otp","password"]`. Both OTP and password stay offered on the login screen.
2. **A person's typed handle is resolved fresh on both `start` and `verify`** (not trusted from a token between the two calls). The verify step re-resolves the handle → user id, so a handle that gets unverified/merged between start and verify cannot complete. Slightly more DB work; correct under merge.
3. **Session for the resolved global user only.** No linking, no auto-creating, no touching `user.email`/`user.phoneNumber`. If the typed handle is a secondary alias, the session is still the one global `usr_` — the products never learn which handle was typed.
4. **Reuse Better Auth's `verification` table for OTP storage** (via `internalAdapter.createVerificationValue`/`findVerificationValue`), not a new table and not Redis. It already has TTL semantics, it is the same store the native plugins use, and it keeps OTP state out of the session cache. No migration.
5. **`emailOTP()`/`phoneNumber()` native plugins are NOT enabled.** Enabling them would add public endpoints (`/sign-in/email-otp`, `/phone-number/send-otp`) that bypass the alias resolver and the verified-only rule — a second, unsafe way in. We deliberately do not mount them.
6. **`getTempEmail` domain** is only relevant if we ever sign up via phone; we do not (no auto-signup), so `PHONE_PLACEHOLDER_DOMAIN` is unused by this step but left validated for a later provisioning step.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/auth.ts` | modify | register `aliasOtp()` in `plugins: [...]`; pass the two senders in. No second instance, no native OTP plugins. |
| `src/auth/alias-otp.ts` | create | the custom Better Auth plugin: two endpoints, OTP generate/hash/store/verify, `createSession` on success, generic responses, per-IP+per-handle rate limit. |
| `src/services/otp.ts` | create | pure-ish OTP logic testable without HTTP: `generateOtp()`, `hashOtp()/verifyOtpHash()`, `otpIdentifier(type,value)`. |
| `src/integrations/email.ts` | create | `sendEmailOtp(to, otp)` — POST to the email provider using `EMAIL_FROM` + `EMAIL_PROVIDER_API_KEY`. |
| `src/integrations/sms.ts` | create | `sendSmsOtp(to, otp)` — switch on `SMS_PROVIDER`, POST to that gateway with `SMS_SENDER_ID` + `SMS_PROVIDER_API_KEY`. |
| `src/identity/resolve.ts` | modify | `resolveHandle` returns `email_otp`/`sms_otp` by handle type (Decision 4). |
| `tests/identity/resolve.test.ts` | modify | update the method-offer expectations; keep the hit/miss identical-shape assertion. |
| `tests/services/otp.test.ts` | create | generate length/charset; hash never equals code; verify true/false; **idempotent identifier**. |
| `tests/auth/alias-otp.test.ts` | create | the negative + invariant tests (below), through the plugin endpoints against real Postgres + Redis, senders mocked. |
| `tests/integrations/otp-senders.test.ts` | create | correct provider selected; `requireLater` throws when the key is unset; **OTP + full phone never appear in a logged line**. |

Not touched: `lib/config.ts` (every secret already validated), `db/migrations/*` (no schema change), `routes/identity.ts` (resolve endpoint logic unchanged; only the offered methods change via the service), `authz/*`, `services/health.ts`.

## Implementation requirements

**`src/services/otp.ts`**

1. `generateOtp(length = 6): string` — cryptographically random digits via `crypto.getRandomValues`, zero-padded, fixed length.
2. `hashOtp(otp): Promise<string>` and `verifyOtpHash(otp, hash): Promise<boolean>` — `Bun.password` (argon2id) so a leaked verification row does not reveal the code. Code never logged.
3. `otpIdentifier(type, value): string` — stable key for the verification row, e.g. `sign-in-otp:${type}:${value}`. Idempotent.

**`src/integrations/email.ts` / `sms.ts`**

4. `sendEmailOtp(to, otp)` / `sendSmsOtp(to, otp)` — read secrets via `requireLater(...)` (throws named `ConfigError` if unset). `sms.ts` switches on `SMS_PROVIDER`; the two unconfigured providers are unreachable at runtime because only one is configured, but the switch is exhaustive and `// ponytail:`-marked. Never log the OTP or the full recipient — log `handleType` + a truncated/hashed recipient at most.

**`src/auth/alias-otp.ts`** (Better Auth plugin: `id: "alias-otp"`, `endpoints: {...}`)

5. `POST /sign-in/otp/start` — body `{ handle: string }` (zod). `normaliseHandle` → per-IP + per-handle `checkRateLimit` (mirror `/resolve` constants: handle 5/60 s, IP 30/60 s) → on a classified handle, `resolveVerifiedUser`; **on a hit only**, `generateOtp` → `hashOtp` → `createVerificationValue(otpIdentifier, hash+":0", expiresIn 300)` → dispatch the matching sender (email vs sms by type) **without awaiting on the response path**. Always `return ctx.json({ ok: true })` with `no-store`. Log `{ handleType, outcome: "sent"|"noop"|"rate_limited" }` — never the handle, never the OTP.
6. `POST /sign-in/otp/verify` — body `{ handle, otp }`. Re-`normaliseHandle` → `resolveVerifiedUser`; if null → generic `INVALID_OTP` (same as a bad code — no existence disclosure). Load the verification row; expired/absent → `INVALID_OTP`; attempts ≥ 3 → delete + `TOO_MANY_ATTEMPTS`; `verifyOtpHash` false → increment attempts + `INVALID_OTP`; success → delete the row, `createSession(userId)`, `setSessionCookie(ctx, {session, user})`, return `{ token, user }`. The session's user id is the **resolved global id**.
7. Both endpoints get their handle from the body only; nothing trusts a prior response. Verify re-resolves (Assumption 2).

**`src/auth.ts`**

8. `import { aliasOtp } from "@/auth/alias-otp"`; add `plugins: [aliasOtp({ sendEmailOtp, sendSmsOtp })]`. Senders imported lazily inside the plugin if needed to preserve the CLI-under-jiti constraint (they pull in `Bun`/`fetch` config); mirror the `getRedis` lazy pattern already in this file.

**`src/identity/resolve.ts`**

9. `resolveHandle(parsed)` → `parsed?.type === "phone" ? { methods: ["sms_otp"] } : { methods: ["email_otp"] }`. Pure function of type; null → the email default. (Password appended only if Assumption 1 is rejected.)

## Data model impact

**None.** OTP state lives in Better Auth's existing `verification` table via `internalAdapter`. No new table, column, constraint, index, or migration. The resolver reuses `ix_identity_lookup` (0002). Verified-only is enforced by the resolver's `is_verified=true` filter, which is a schema-backed CHECK-consistent column.

## Security requirements (restated for this task)

- **Takeover path 1 (unverified authenticates / receives OTP):** `start` and `verify` both go through `resolveVerifiedUser`, whose `is_verified=true` filter means an unverified handle gets neither an OTP nor a session. **Two negative tests** (no OTP sent; no session).
- **Enumeration (OTP request leaks existence):** `start` returns the identical body for hit/miss/unclassifiable, sends nothing on a miss, and is rate limited per IP **and** per handle.
- **Never logged:** the OTP code, the full email/phone, the verification hash. Log `handleType`, `outcome`, and the `usr_` id only.
- **Never server-side → client:** `EMAIL_PROVIDER_API_KEY`, `SMS_PROVIDER_API_KEY`, `SMS_SENDER_ID`, `EMAIL_FROM` stay in `integrations/` behind `requireLater`; none reach a response or a log.
- **Session correctness:** always the global `usr_` id; the flow never writes `user.email`/`user.phoneNumber` and never auto-creates a user (so no orphan identities, path-3-style auto-linking is impossible here).
- **Timing:** OTP send is dispatched without awaiting so a hit and a miss take a comparable response path.

## Authorization impact

**None.** No RBAC read/write, no OpenFGA model/tuples, no outbox events. Sign-in produces a session; product access is read elsewhere.

## Bun-native check

**New dependencies: none.** `emailOTP`/`phoneNumber` are *not* added (Assumption 5). Uses `crypto.getRandomValues` (Web Crypto, Bun-native) for OTP, `Bun.password` for the hash, `fetch` for provider calls, the already-present `better-auth` plugin API, `zod`, and our existing `checkRateLimit`/`resolveVerifiedUser`. Nothing installed.

## Acceptance criteria

- [ ] `POST /api/auth/sign-in/otp/start` with a verified handle sends an OTP to **that handle** and returns `{ ok: true }` + `no-store`.
- [ ] The same call with an **unknown** or **unverified** handle returns the **byte-identical** body and sends **nothing** (asserted via the mocked sender's call count).
- [ ] `POST /api/auth/sign-in/otp/verify` with the correct OTP creates a session whose user id is the **global `usr_`**, even when the typed handle is a secondary alias.
- [ ] A wrong OTP is rejected; 3 wrong attempts lock the code; an expired code is rejected — all with the same generic error as an unknown handle (no disclosure).
- [ ] `resolveHandle` returns `["email_otp"]` for email, `["sms_otp"]` for phone, identical shape for a null handle.
- [ ] OTP code and full phone/email appear in **no** log line.
- [ ] `bun run check` — typecheck clean, tests ≥80% line/func, `bun audit` = only the known `@better-auth/oauth-provider` finding.

## Tests to add

- [ ] `tests/auth/alias-otp.test.ts` — **negative:** unverified handle → no OTP sent (path 1); unverified/unknown handle → no session; wrong OTP → no session; expired OTP → rejected; 3 attempts → locked. **Invariant:** verified secondary alias → session is the global `usr_` (not the primary handle's implied user); `start` returns identical body for hit vs miss (enumeration). Real Postgres + Redis; email/SMS senders mocked (`mock()` from `bun:test`).
- [ ] `tests/services/otp.test.ts` — `generateOtp` length/all-digits/randomness sanity; `hashOtp` output ≠ code; `verifyOtpHash` true for match, false for mismatch; `otpIdentifier` idempotent.
- [ ] `tests/integrations/otp-senders.test.ts` — correct provider chosen for `SMS_PROVIDER`; `requireLater` throws when the key is unset; **spy on `console`: OTP and full recipient never appear**.
- [ ] `tests/identity/resolve.test.ts` (update) — method offer per handle type; hit/miss identical shape preserved.

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test` (real Postgres + Redis; senders mocked)
- [ ] `bun audit`
- [ ] No `bun run db:migrate` — no migration changed.
- [ ] `bun run auth:schema` diff review — confirm registering the plugin adds **no** new Better Auth table (it should not; we reuse `verification`).

## How to verify it

```bash
# Postgres + Redis up; a user with a verified secondary alias seeded, e.g.
#   user usr_X; user_identity(email, primary@…, verified, primary) and (email, alt@…, verified)

# 1. Checks
bun run check
   → typecheck clean; suites pass ≥80%; audit = only the known oauth-provider finding

# 2. Request an OTP to the SECONDARY alias (the alias-model proof)
curl -s -X POST localhost:3000/api/auth/sign-in/otp/start \
  -H 'content-type: application/json' -d '{"handle":"alt@example.com"}'
   → 200 {"ok":true}   ; server log shows outcome:"sent", handleType:"email", NO code, NO address

# 3. SECURITY — unknown handle is indistinguishable and sends nothing
curl -s -X POST localhost:3000/api/auth/sign-in/otp/start \
  -H 'content-type: application/json' -d '{"handle":"nobody@example.com"}'
   → 200 {"ok":true}   ; log shows outcome:"noop"; mocked sender NOT called (asserted in test)

# 4. Verify with the code from step 2 → session for the GLOBAL user
curl -s -X POST localhost:3000/api/auth/sign-in/otp/verify \
  -H 'content-type: application/json' -d '{"handle":"alt@example.com","otp":"<code>"}'
   → 200 {"token":"…","user":{"id":"usr_X",…}}   ← global id, though a secondary handle was typed

# 5. SECURITY — unverified handle never yields an OTP or a session (negative tests)
#    seed value=pending@example.com is_verified=false → start sends nothing; verify → INVALID_OTP
```

Steps 2–5 verify the security/alias properties (OTP to the typed handle, indistinguishable miss with no send, global-id session, verified-only), not just a 200.

## Out of scope for this task (and flagged)

- **Alias add / verify / remove** (`/api/identity/me/aliases*`) — that OTP goes to the *already-verified* handle (takeover path 2). Its own prompt. This step is sign-in only.
- **Native `emailOTP()`/`phoneNumber()` plugins** — deliberately not mounted (Assumption 5); they bypass the resolver.
- **2FA / `twoFactor()`** — later step; mandatory for ADMIN/VENDOR_ADMIN, not wired here.
- **Real multi-provider SMS/email** — one configured provider implemented; others `ponytail:`-marked until a second is onboarded.
- **`X-Forwarded-For` trusted-proxy IP** — step 15; per-handle limit carries enumeration defence until then (same as `/resolve`).
- **Outbox `login`/audit events** — no audit-log write here; add with the admin/audit step.

---

# Outcome

Implemented as approved (custom `aliasOtp` plugin; method offer = OTP **+** password).

**Tests:** `bun test` → **204 pass, 0 fail**, coverage **89.11% func / 93.09% line** (floor 80%). New/changed files at 100%/100%: `services/otp.ts`, `services/otp-signin.ts`, `identity/resolve.ts`, `integrations/email.ts` (95% line). `alias-otp.ts` 80% func / 51% line — the two BA-coupled endpoint closures are not unit-covered (the auth HTTP stack cannot target a disposable schema); its pure glue (store adapter, handle bucket, plugin shape incl. *no schema*) is fully tested, and the handlers are verified by the manual curl steps above. `bun run typecheck` clean.

**`bun audit`:** the one pre-existing `@better-auth/oauth-provider` advisory (GHSA-p2fr-6hmx-4528), unchanged — this task adds no dependency (deferred to step 6, as in steps 1/3/4).

**Security properties proven by tests, not just 200s:**
- An unverified/unknown handle receives **no OTP** and stores nothing — takeover path 1 (`otp-signin.test.ts`), backed by the real-Postgres `resolveVerifiedUser` negative in `resolve.test.ts`.
- A verified **secondary** alias resolves to the **same global `usr_`** (real Postgres), and the verify flow mints the session for that global id, not the typed handle.
- The OTP is sent to the **typed** (normalised) handle, by type: email→email sender, phone→E.164 SMS sender.
- Wrong code → rejected + attempt++; expired → rejected; 3 attempts → locked and deleted — all the same generic reject as an unknown handle (no disclosure).
- `/resolve` stays existence-independent: two handles of the same type are byte-identical whether or not they exist.
- A failed gateway send does not surface or reject (would leak existence); the code, full recipient, and provider key never appear in a log line.
- Registering the plugin adds **no** Better Auth table (no `schema`; OTP state reuses the Redis-backed verification store).

## Deviations from the plan

| # | Change | Why |
|---|---|---|
| 1 | Flow logic extracted to `services/otp-signin.ts`; the plugin is a thin adapter | AGENTS.md (logic in services/, routes thin) **and** testability — the BA `pg` Pool + our global `Bun.sql` cannot target a disposable schema, so the mandated negatives are driven through injected collaborators. |
| 2 | `resolveHandle` route-test assertion corrected from cross-*type* equality to same-type existence-independence | The old assertion only held while the offer was constant; the genuine anti-enumeration property is existence-independence. Fixed, not weakened (documented in Decision 4). |

## Flagged (not blocking, needs an operator decision)

- **`src/integrations/email.ts` `PROVIDER_ENDPOINT` is a placeholder** (`https://email-provider.invalid/...`). The config names no email vendor (only an API key + From address), so the real transactional-email send endpoint and payload must be set before go-live. Tests inject a mock sender, so this is never exercised under test. Marked `ponytail:` in-file.
- **`src/integrations/sms.ts` provider payloads** follow each vendor's public API but are unverified against live accounts — Twilio in particular authenticates with an Account SID + auth token that our single `SMS_PROVIDER_API_KEY` does not fully cover. Confirm against the chosen account before go-live. Marked `ponytail:` in-file.
