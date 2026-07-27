# 013 — Salesforce provisioning on Lead conversion, and the back-reference sync

## Goal

Add a signed, idempotent `/api/internal/provision` callout that resolves-or-creates an `invited` user with unverified identities and `NORMAL` product access when a Salesforce Lead converts, and sync the resulting `usr_` id back onto the Salesforce Contact's `Internal_User_ID__c` field via the existing outbox/drain infrastructure.

## What it read

- Skills: `.agents/skills/security.md`, `.agents/skills/postgres-migrations.md`, `.agents/skills/scalar-api-docs.md`, `.agents/skills/alias-identity.md`, `.agents/skills/testing-and-checks.md`
- `AGENTS.md` — roadmap step 12, data model (`user.salesforce_contact_id`, `user.status`), API contracts table (`POST /api/internal/provision`), security rules 11/12/13
- `docs/architecture-plan.md` §4.5 (Salesforce provisioning flow, diagram, idempotency-on-`contactId`, Contact-not-Lead-id rule, "Salesforce is a source, not the source")
- Files opened: `src/lib/config.ts` (`SALESFORCE_INSTANCE_URL`/`SALESFORCE_CLIENT_ID`/`SALESFORCE_CLIENT_SECRET`/`INTERNAL_WEBHOOK_SIGNING_SECRET` — all already tier 2, unused until now), `src/auth.ts` (`salesforceContactId`/`status`/`importedHashAlgo` additionalFields, all `input:false`), `src/services/legacy-import.ts` (the existing precedent for creating a Better-Auth user server-side via `ctx.internalAdapter.createUser` with an `input:false` field, and for treating `identityValueExists` as the "is this handle already claimed" guard), `src/services/vendor-sso.ts` (DI/service-shape precedent: hardcode the granted role, never derive it from the caller's input), `src/db/identity.ts`, `src/db/access.ts` (`grantAccess`'s outbox-in-the-same-transaction pattern), `src/db/types.ts` (`ID_PREFIX`, `PRODUCT_IDS`, `USER_STATUSES`), `src/db/outbox-worker.ts` + `src/jobs/outbox-worker.ts` + `src/authz/tuples.ts` (the generic, already-built claim/retry drain loop and its per-`aggregate` dispatch), `src/routes/admin/vendors.ts` (route error-mapping shape), `src/routes/docs.ts` (confirms `/api/internal/*` is never added here — manually assembled paths, not auto-discovered), `src/integrations/email.ts`/`sms.ts` (outbound-integration shape: `requireLater` for secrets, `IntegrationError` on non-2xx, never log the payload), `src/lib/errors.ts`, `src/lib/logger.ts` (`DENY` list), `src/index.ts`, `.env.example` (Salesforce vars present, empty), `package.json` (no `jsforce` or Salesforce SDK present)
- `node_modules/bun-types/bun.d.ts` — confirmed `Bun.CryptoHasher(algorithm, hmacKey?)` supports HMAC natively; no new dependency needed for request signing

## Assumptions

1. **Idempotency key is `contactId`, resolved through the existing `salesforce_contact_id` unique column — no new migration.** A repeat callout for the same `contactId` finds the same user via `findUserIdBySalesforceContactId` and re-runs the (idempotent) identity/access/outbox writes rather than creating a second user. This is exactly the column AGENTS.md already reserves for this purpose (`salesforce_contact_id` unique, nullable, "Contact `003…` only").
2. **"Resolve" (not "always create") when the email is already claimed.** Per architecture-plan.md's own wording ("resolve-or-create") and the alias-identity premise (one verified-or-unverified handle = one person): if `identityValueExists("email", value)` is true for a *first-time* `contactId`, the existing owner of that handle is resolved and `salesforce_contact_id` is attached to *that* user (guarded: only if the user has no different contact id already linked — a genuine conflict there throws `ValidationError`, it is never silently overwritten). No new Better Auth user or `user_identity` row is created in this branch. This is **not** security.md's forbidden federated-auto-link-by-email (that rule is about an authentication event silently establishing a session); here nothing authenticates — it only attaches non-authenticating metadata (`salesforce_contact_id`) and grants additional coarse, `NORMAL`-only product access to an already-existing identity row, which is the alias model's entire point. Flagging this explicitly because it's the one interpretive call in this plan — reject it here if the intent was instead "always create a new user and let `dedup.ts` Tier A/B reconcile later" (the `legacy-import.ts` precedent), and say so.
3. **Grant role is hardcoded to `NORMAL`, never taken from the request body.** Mirrors `provisionVendorUser`'s hardcoded `VENDOR` — security.md/AGENTS.md: "Admin and Vendor users never come from Salesforce." `products` in the request body is an array of `ProductId` only (`lms`/`miles_one`/`masterclass`); role is never a field on the wire.
4. **The back-reference write reuses the existing outbox/drain machinery instead of a new retry mechanism.** The provisioning transaction inserts one `outbox` row (`aggregate: 'salesforce_contact_link'`, `payload: { contactId, userId }`) alongside the identity/access writes. `src/jobs/outbox-worker.ts`'s dispatcher is extended to route `'salesforce_contact_link'` rows to a new `applySalesforceContactLinkEvent` (in `src/integrations/salesforce.ts`) exactly the way it already routes `'vendor_access'` rows to `authz/tuples.ts` — same claim/attempts/last_error retry semantics, no second cron, no new polling loop. This makes the PATCH to Salesforce retryable (it's a plain field-set PATCH, safe to repeat) without inventing new machinery, and keeps the callout's own response fast (it never blocks on an outbound Salesforce call).
5. **No `jsforce` (or any Salesforce SDK).** `SALESFORCE_INSTANCE_URL`/`CLIENT_ID`/`CLIENT_SECRET` already describe an OAuth2 client-credentials grant against `{instance}/services/oauth2/token`, followed by one `fetch` PATCH to `{instance}/services/data/v61.0/sobjects/Contact/{id}` — two native `fetch` calls, matching `src/integrations/email.ts`/`sms.ts`'s existing pattern and the Bun-native stack table (no ORM/SDK for something two `fetch` calls already do). Token is fetched fresh per outbox event (not cached) — this call is driven by outbox volume (one per new-or-changed Salesforce link), nowhere near hot-path traffic; add caching only if volume ever makes it worth the complexity.
6. **Request signing: HMAC-SHA256 over `{timestamp}.{rawBody}`, not a bare body signature.** A bare-body HMAC never expires — a captured valid request could be replayed indefinitely. Headers `x-signature` (hex HMAC) and `x-timestamp` (unix seconds); reject if `|now - timestamp| > 300s` **or** the signature (computed with `Bun.CryptoHasher("sha256", INTERNAL_WEBHOOK_SIGNING_SECRET)`, compared with `crypto.timingSafeEqual`, equal-length-checked first) doesn't match. IP allowlisting ("network allowlist and signed requests, either alone is insufficient" — security.md) is an infrastructure/ops concern (firewall/security-group rule), the same category as provisioning `FGA_STORE_ID` itself — out of scope for application code, called out explicitly below.
7. **The activation email/link is out of scope for this task.** The architecture doc's flow diagram mentions "send activation link (single-use, 72h TTL)" as the *following* step after provisioning, but the user's request named "provisioning on Lead conversion and the back-reference sync" specifically — not a new activate-account endpoint (which needs its own design: what completes activation — a password set? an OTP-driven alias verification? a dedicated single-use token consumed by a new route?). Nothing in this plan regresses security by deferring it: the created user stays `status:'invited'` with **unverified** identities exactly as AGENTS.md requires, and an unverified identity cannot authenticate or receive a sign-in OTP (existing, untouched invariant) — so there is no path by which a provisioned-but-not-yet-activated account becomes reachable. Flagging as a separate, presumably-near-future task rather than silently building it.
8. **Reverse-sync (self-signup/vendor-JIT users pushed *to* Salesforce as new Contacts) is out of scope.** AGENTS.md's roadmap-step-12 bullet bundles "provisioning callout, `Internal_User_ID__c` back-reference, reverse sync" together, but the user's own request named only "provisioning on Lead conversion and the back-reference sync." The back-reference direction (Miles Identity → Salesforce, for a Contact Salesforce already knows about) is built here; the reverse direction (Miles Identity → Salesforce, creating a *new* Contact for someone Salesforce has never heard of) is a distinct trigger (self-registration, vendor JIT) and a separate, larger piece of work — listed under Out of scope.
9. **Products may be empty.** A converted Lead with no product selected yet still gets an invited identity record (useful for a subsequent grant later via `/api/admin/access`); `products: []` is valid input, not a validation error.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/db/identity.ts` | modify | add `findUserIdBySalesforceContactId`, `linkSalesforceContactId` (guarded — refuses to overwrite an existing different link), `createUnverifiedIdentity` (mirrors `createVerifiedIdentity`, `is_verified=false`/`verified_at=NULL`, `ON CONFLICT DO NOTHING`), `findUserIdByAnyHandle` (like `findUserIdByVerifiedHandle` but without the `is_verified` filter — doc comment states in bold this must never be used on a login/auth path) |
| `src/services/salesforce-provisioning.ts` | create | `provisionFromSalesforce(input, deps)` — the resolve-or-create/grant/outbox logic, DI'd same shape as `vendor-sso.ts` |
| `src/integrations/salesforce.ts` | create | `getSalesforceAccessToken()`, `linkContactToUser(contactId, userId)` (the back-reference PATCH), `applySalesforceContactLinkEvent(row: OutboxRow)` (outbox dispatch target, zod-validates payload) |
| `src/routes/internal/provision.ts` | create | HMAC+timestamp verification, zod body parse, calls the service, maps errors to status codes — mirrors `routes/admin/vendors.ts`'s shape |
| `src/jobs/outbox-worker.ts` | modify | dispatch by `row.aggregate`: `'vendor_access'` → existing `applyOutboxEvent`, `'salesforce_contact_link'` → new `applySalesforceContactLinkEvent`, else warn+skip (same as today) |
| `src/index.ts` | modify | mount `"/api/internal/provision": { POST: ... }` |
| `tests/db/identity.test.ts` | create | the four new `db/identity.ts` functions against a real schema |
| `tests/services/salesforce-provisioning.test.ts` | create | resolve-by-contactId idempotency, resolve-by-existing-email, create-new-user, hardcoded `NORMAL` role, conflicting-contact-id rejection, outbox row written in the same transaction |
| `tests/integrations/salesforce.test.ts` | create | token fetch + PATCH request shape (mocked `fetch`), `applySalesforceContactLinkEvent` aggregate dispatch (matches/skips), `IntegrationError` on non-2xx |
| `tests/routes/internal/provision.test.ts` | create | valid signature accepted, missing/wrong signature rejected (401), stale timestamp rejected (401), invalid body rejected (400), unknown-error mapping |
| `tests/jobs/outbox-worker.test.ts` | modify or create | dispatcher routes `salesforce_contact_link` and `vendor_access` rows to the right handler; unknown aggregate still warns and doesn't throw |

## Implementation requirements

1. **`src/db/identity.ts` additions**:
   - `findUserIdBySalesforceContactId(contactId, client=sql): Promise<string|null>` — `SELECT id FROM "user" WHERE salesforce_contact_id = $1`.
   - `linkSalesforceContactId(userId, contactId, client=sql): Promise<boolean>` — `UPDATE "user" SET salesforce_contact_id = $2 WHERE id = $1 AND salesforce_contact_id IS NULL`; returns whether a row was updated. Caller treats "not updated" as needing a check (already linked to this same id → fine/idempotent; linked to a *different* id → conflict, throw `ValidationError` in the service).
   - `createUnverifiedIdentity(input: {userId, type, value, source}, client=sql): Promise<UserIdentityRow|null>` — identical to `createVerifiedIdentity` except `is_primary=false, is_verified=false, verified_at=NULL`; same `ON CONFLICT (type, value) DO NOTHING` semantics.
   - `findUserIdByAnyHandle(type, value, client=sql): Promise<string|null>` — same query as `findUserIdByVerifiedHandle` minus the `is_verified = true` filter. Doc comment: **never call this on a login or OTP path** — it exists only for provisioning-time resolution, which does not authenticate anyone.
2. **`src/services/salesforce-provisioning.ts`**:
   - Input type: `{ contactId: string; email: string; phone?: string; firstName: string; lastName?: string; products: ProductId[] }`.
   - Deps (all injectable, defaults hit the real DB/Better-Auth adapter — same DI shape as `vendor-sso.ts`): `findUserIdBySalesforceContactId`, `identityValueExists`, `findUserIdByAnyHandle`, `linkSalesforceContactId`, `createUser: (input) => Promise<{id: string}>` (defaults to throwing, same as `legacy-import.ts`'s `defaultDeps` — the CLI/route entrypoint supplies the real `ctx.internalAdapter.createUser`), `createUnverifiedIdentity`, `grantAccess`, `insertSalesforceLinkOutboxRow: (contactId, userId, client) => Promise<void>`.
   - Logic:
     1. `existingUserId = await deps.findUserIdBySalesforceContactId(input.contactId)`.
     2. If found: `userId = existingUserId` (idempotent replay branch — skip straight to step 4).
     3. Else:
        - `email = normaliseEmail(input.email)`.
        - If `await deps.identityValueExists("email", email)`: `userId = await deps.findUserIdByAnyHandle("email", email)` (must be non-null — the identity exists, so its owner does); `linked = await deps.linkSalesforceContactId(userId, input.contactId)`; if `!linked`, re-check `findUserIdBySalesforceContactId(input.contactId) !== userId` — if the user already has a *different* linked contact id, throw `ValidationError("user ${userId} is already linked to a different Salesforce contact")`.
        - Else: `const created = await deps.createUser({ email, name: displayName(input), salesforceContactId: input.contactId, status: "invited" }); userId = created.id`.
     4. In one `Bun.sql` transaction (`client.begin`): `createUnverifiedIdentity({userId, type:"email", value: email, source:"salesforce"})`; if `input.phone`, normalise via `normalisePhone` and (if it parses) `createUnverifiedIdentity({userId, type:"phone", ...})` too — an unparseable phone is dropped, not a hard failure (Salesforce phone formatting is not this task's problem to fully solve); for each `productId` in `input.products`, `grantAccess({userId, productId, role:"NORMAL", vendorId:null, grantedBy:"system:salesforce-provisioning"})`; insert the `salesforce_contact_link` outbox row.
     5. `log.info("salesforce_user_provisioned", { userId, contactId: input.contactId })` (never the email/phone — security.md never-logged list doesn't name email directly here, but this mirrors the existing "no recipient logged" convention in `integrations/email.ts`/`sms.ts`).
     6. Return `{ userId }`.
3. **`src/integrations/salesforce.ts`**:
   - `getSalesforceAccessToken(): Promise<string>` — `POST {requireLater("SALESFORCE_INSTANCE_URL")}/services/oauth2/token` with `grant_type=client_credentials&client_id=...&client_secret=...` (`application/x-www-form-urlencoded`); throws `IntegrationError("salesforce", ...)` on non-2xx; never logs the returned token (security.md, logger `DENY` list already redacts `token`-named fields as belt-and-braces).
   - `linkContactToUser(contactId: string, userId: string): Promise<void>` — `PATCH {instance}/services/data/v61.0/sobjects/Contact/${contactId}` with `Authorization: Bearer {token}`, body `{"Internal_User_ID__c": userId}`; Salesforce returns `204` on a successful PATCH — anything else is `IntegrationError`.
   - `const SalesforceLinkPayload = z.object({ contactId: z.string(), userId: z.string() })`.
   - `applySalesforceContactLinkEvent(row: OutboxRow): Promise<void>` — `if (row.aggregate !== "salesforce_contact_link") return` (forward-compatible skip, mirrors `authz/tuples.ts`); parse payload (a parse failure throws — real producer bug, must retry/surface via `attempts`/`last_error`); call `linkContactToUser`.
4. **`src/jobs/outbox-worker.ts`** — replace the single `applyOutboxEvent(row, fgaClient)` call with:
   ```ts
   const applyEvent = async (row: OutboxRow) => {
     if (row.aggregate === "vendor_access") return applyOutboxEvent(row, getFgaClient());
     if (row.aggregate === "salesforce_contact_link") return applySalesforceContactLinkEvent(row);
     log.warn("outbox_unknown_aggregate", { id: row.id.toString(), aggregate: row.aggregate });
   };
   ```
   (moves the "unknown aggregate" log here instead of relying on `tuples.ts`'s own internal check, since there are now two known aggregates — `tuples.ts`'s existing internal `row.aggregate !== "vendor_access"` guard becomes dead code for this call site but is harmless/left as defense-in-depth, since `authz/tuples.ts` may still be unit-tested directly).
5. **`src/routes/internal/provision.ts`**:
   - `const provisionBodySchema = z.object({ contactId: z.string().min(1), email: z.string().min(1), phone: z.string().min(1).optional(), firstName: z.string().min(1), lastName: z.string().min(1).optional(), products: z.array(z.enum(PRODUCT_IDS)) })`. **Not exported into `routes/docs.ts`** — `/api/internal/*` is never documented (scalar-api-docs.md rule 2).
   - `verifyInternalSignature(rawBody: string, timestampHeader: string | null, signatureHeader: string | null, secret: string): boolean` — parses timestamp as a number, rejects non-numeric or `|now/1000 - timestamp| > 300`; computes `new Bun.CryptoHasher("sha256", secret).update(\`${timestamp}.${rawBody}\`).digest("hex")`; both digests hex-decoded to `Buffer`s of equal length before `crypto.timingSafeEqual` (a length mismatch is treated as "no match", never thrown past the caller). Exported standalone so it's directly unit-testable without a live `Request`.
   - `provisionRoute(req, services = defaultServices)`: read raw body text once (needed both for signature verification and for parsing — `req.text()` then `JSON.parse` locally, not `req.json()` twice); verify signature → 401 `{error:"unauthenticated"}` on failure; zod-parse → 400 `{error:"invalid_request"}` on failure; call `provisionFromSalesforce`; catch `ValidationError` → 400, anything else unexpected → rethrow (bubbles to the server's generic `error()` handler, same as every other route here). Response: `Response.json({ userId }, { headers: NO_STORE })`.
6. **`src/index.ts`** — add `"/api/internal/provision": { POST: (req) => provisionRoute(req) }` and the corresponding import.

## Data model impact

**None.** `user.salesforce_contact_id` (unique, nullable) and `user.status` (`invited` already a valid `USER_STATUSES` value) already exist via `src/auth.ts`'s `additionalFields`. `user_identity.source` already includes `'salesforce'` (migration 0002's `ck_identity_source`, `IDENTITY_SOURCES`). `outbox` (migration 0006) already has every column a new `aggregate` value needs — no migration for the new `'salesforce_contact_link'` aggregate, same reasoning as prompts/012.

## Security requirements

- **`/api/internal/provision` rejects an unsigned or stale request outright** — HMAC-SHA256 over `{timestamp}.{rawBody}`, timing-safe compared, 300s skew window. This is the specific negative test testing-and-checks.md requires ("`/api/internal/*` rejects an unsigned request").
- **Never mints ADMIN or VENDOR access.** `grantAccess` is called with a hardcoded `role: "NORMAL"` — the request body has no role field at all, so there is no input path to a privileged grant (mirrors `provisionVendorUser`'s hardcoded `VENDOR`).
- **Lead conversion is not identity verification** (AGENTS.md rule 11, restated): every identity row this task writes goes through the new `createUnverifiedIdentity`, never `createVerifiedIdentity`. An unverified identity cannot authenticate or receive a sign-in OTP — untouched, pre-existing invariant, and the reason deferring "activation" (Assumption 7) is safe.
- **No takeover path opened.** This is not vendor federation and not a login-time auto-link (security.md takeover path 3 is specifically about a federated *sign-in* silently linking to a session) — nothing in this task authenticates anyone or establishes a session. The email-match resolution (Assumption 2) only ever attaches metadata and coarse `NORMAL` access to a handle that some product already owns.
- **`INTERNAL_WEBHOOK_SIGNING_SECRET`, `SALESFORCE_CLIENT_SECRET`, and any Salesforce access token never appear in a log line.** All three flow through `requireLater`/direct parameters only; `src/integrations/salesforce.ts` logs only `contactId`/`userId` on success, never the token or secret (belt-and-braces: logger's `DENY` list also catches a `token`-named field if one were ever accidentally nested).
- **IP allowlisting is explicitly out of scope for this task** (an infrastructure/network rule, not application code) — flagged rather than silently assumed solved; the HMAC check is the application-layer half of security.md's "network allowlist AND signed requests."
- **Idempotent by construction, not by hope**: retried callouts for the same `contactId` cannot create a duplicate user (idempotency check first), duplicate identities (`ON CONFLICT DO NOTHING`), duplicate access grants (`grantAccess`'s existing `ON CONFLICT DO UPDATE`), or an infinite pile of outbox rows for the same link (idempotent PATCH, safe to reprocess).

## Authorization impact

- **Layer 1 (RBAC)**: new grants only ever use `product_id ∈ {lms, miles_one, masterclass}` / `role = NORMAL` / `vendor_id = NULL` — no new role, no new product, no change to `hasProductAdmin`/`getActiveAccessForUser`.
- **Layer 2 (graph)**: none. `NORMAL` is not one of the `VENDOR_ROLES` `src/db/access.ts`'s `isVendorScopedRole` checks, so `grantAccess`'s existing vendor-tuple outbox logic produces **no** `vendor_access` row for these grants — correct, since OpenFGA's model (prompts/012) has no relation for plain product membership yet.
- **Layer 3**: none.

## API documentation impact

**`/api/internal/provision` is never added to `src/routes/docs.ts` or any Scalar spec**, in every environment — scalar-api-docs.md rule 2 ("Never document `/api/internal/*`... Publishing their shapes hands an attacker the map"). No existing documented route's schema changes.

## Bun-native check

- No new dependency. Request signing uses `Bun.CryptoHasher("sha256", hmacKey)` (native HMAC support, confirmed in `bun-types`) plus `crypto.timingSafeEqual` (Node-compat builtin, already implicitly available — no package). The Salesforce OAuth2 token fetch and the back-reference PATCH are two native `fetch` calls, matching `integrations/email.ts`/`sms.ts` — no `jsforce` or any Salesforce SDK, despite architecture-plan.md mentioning `jsforce` as an option (see Assumption 5: two `fetch` calls don't need an SDK, and AGENTS.md's stack table doesn't list one).
- Reuses the existing `outbox`/`Bun.cron` drain (step 11) rather than adding a second cron or a bespoke retry loop.

## Acceptance criteria

- [ ] A first-time `POST /api/internal/provision` with a valid signature, an email nobody has claimed, and `products: ["masterclass"]` creates a new `usr_` user with `status='invited'`, one unverified `user_identity` row (`source='salesforce'`), an active `user_product_access` row (`masterclass`/`NORMAL`), and one pending `salesforce_contact_link` outbox row; response is `{"userId": "usr_..."}`.
- [ ] Repeating the exact same request (same `contactId`) is a no-op beyond re-affirming the same rows — no duplicate user, no duplicate identity, no duplicate access row, and the userId in the response is identical.
- [ ] A `contactId` whose email is already claimed by an existing (any-verification-state) identity resolves to that identity's owning user and links `salesforce_contact_id` onto it, rather than creating a second user.
- [ ] A `contactId` that would need to link onto a user already linked to a **different** `salesforce_contact_id` is rejected (400, `ValidationError`) rather than silently overwriting the link.
- [ ] A request with a missing, wrong, or stale (>300s) signature is rejected 401 and writes nothing.
- [ ] A request body with an unknown `products` entry (outside `lms`/`miles_one`/`masterclass`) is rejected 400.
- [ ] The created/updated `user_product_access` row's `role` is always exactly `NORMAL` regardless of any field in the request body (there is no role field to send).
- [ ] Within one outbox-drain cycle, the pending `salesforce_contact_link` row results in a PATCH to Salesforce setting `Internal_User_ID__c`, and the row's `processed_at` is set; a PATCH failure leaves the row pending with `attempts` incremented and `last_error` set, retried on the next drain.
- [ ] `/api/internal/provision` does not appear in `GET /api/docs/openapi.json`'s `paths`.
- [ ] `bun run check` passes.

## Tests to add

- `tests/db/identity.test.ts` (real schema):
  - [ ] `createUnverifiedIdentity` writes `is_verified=false`, `verified_at=NULL`; a repeat call for the same `(type,value)` returns `null`, writes no second row.
  - [ ] `findUserIdByAnyHandle` returns a match regardless of `is_verified`; `findUserIdByVerifiedHandle` still returns `null` for the same unverified row (the two functions must disagree on an unverified handle — that disagreement IS the security boundary).
  - [ ] `linkSalesforceContactId` succeeds when `salesforce_contact_id IS NULL`; returns `false` (no row updated) when already set to any value, including the same one.
- `tests/services/salesforce-provisioning.test.ts` (injected deps, no live DB):
  - [ ] first-time contactId + unclaimed email → `createUser` called, grants exactly `NORMAL` for each requested product, one outbox insert.
  - [ ] repeat contactId → `createUser` never called; existing userId returned.
  - [ ] first-time contactId + already-claimed email → resolves via `findUserIdByAnyHandle`, `createUser` never called, `linkSalesforceContactId` called.
  - [ ] **negative**: resolved user already linked to a different contact id → throws `ValidationError`, no access grant, no outbox row.
  - [ ] `products: []` → zero `grantAccess` calls, user/identity/outbox writes still happen.
- `tests/integrations/salesforce.test.ts` (mocked `fetch`):
  - [ ] `linkContactToUser` sends the expected PATCH URL/body/bearer header; throws `IntegrationError` on a non-2xx token or PATCH response.
  - [ ] `applySalesforceContactLinkEvent` skips (no `fetch` call) for any `aggregate !== "salesforce_contact_link"`.
- `tests/routes/internal/provision.test.ts`:
  - [ ] valid signature + valid body → 200.
  - [ ] **negative**: missing `x-signature` → 401.
  - [ ] **negative**: wrong secret / tampered body → 401.
  - [ ] **negative**: `x-timestamp` older than 300s (even with a signature computed over that same stale timestamp) → 401.
  - [ ] invalid body (missing `contactId`, or `products` containing `"ADMIN"`-shaped garbage) → 400.
- `tests/jobs/outbox-worker.test.ts`:
  - [ ] a `vendor_access` row still dispatches to `applyOutboxEvent`.
  - [ ] a `salesforce_contact_link` row dispatches to `applySalesforceContactLinkEvent`.
  - [ ] an unknown aggregate logs a warning and does not throw.

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun audit`
- [ ] `bun run check`

## How to verify it

```bash
1. bun run check
   → typecheck, full suite (incl. new db/services/integrations/route/job tests), audit all pass

2. bun --hot src/index.ts

3. Compute a valid signature and call the endpoint (dev secret from .env):
   TS=$(date +%s)
   BODY='{"contactId":"003xx0000000001","email":"new.lead@example.com","firstName":"New","products":["masterclass"]}'
   SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$INTERNAL_WEBHOOK_SIGNING_SECRET" -hex | sed 's/^.* //')
   curl -s -X POST localhost:3000/api/internal/provision \
     -H "content-type: application/json" -H "x-timestamp: $TS" -H "x-signature: $SIG" -d "$BODY"
   → 200 {"userId":"usr_..."}

4. Repeat step 3 verbatim
   → 200, identical userId, no new row:
   psql $DATABASE_URL -c "select count(*) from user_identity where source='salesforce'"  → unchanged from step 3

5. curl the same body with a wrong x-signature
   → 401, and confirm no new user row was written

6. psql $DATABASE_URL -c "select aggregate, event_type, payload, processed_at from outbox where aggregate='salesforce_contact_link' order by id desc limit 1"
   → processed_at NULL immediately after step 3, then set within a minute (the existing Bun.cron drain)

7. curl -s localhost:3000/api/docs/openapi.json | grep -c '/api/internal'
   → 0
```

## Out of scope for this task

- **The activation flow** (single-use link/token an invited user consumes to become `active` and verified) — a separate, not-yet-designed feature (Assumption 7). Deferring it does not weaken security: an invited, unverified user cannot authenticate today, same as any other unverified identity.
- **Reverse sync** — pushing self-signup/vendor-JIT users *to* Salesforce as new Contacts (Assumption 8). Different trigger, different direction, a separate task.
- **IP allowlisting** for `/api/internal/*` — an ops/infrastructure action (firewall/security-group), not application code, same category as provisioning `FGA_STORE_ID` itself (prompts/012's own precedent for this kind of out-of-scope item).
- **Dedup/merge integration beyond the existing Tier A (`salesforce_contact_id` match) in `src/db/dedup.ts`** — already wired for when this column gets populated (its own comment says as much); no change needed here.
- **A Salesforce → Miles Identity webhook signature secret rotation endpoint or process** — ops concern, same as any other secret rotation in this codebase.
