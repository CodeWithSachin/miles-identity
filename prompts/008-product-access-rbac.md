# 008 — Product access RBAC + admin grant/revoke

---

## Goal

Let a product-scoped ADMIN grant or revoke another user's `user_product_access` row, and surface active access as `products` claims on the access token.

## What it read

- Skills: `.agents/skills/security.md`, `.agents/skills/postgres-migrations.md`, `.agents/skills/scalar-api-docs.md`
- Files actually opened: `AGENTS.md`, `src/auth.ts`, `src/db/types.ts`, `src/db/migrations/0004_user_product_access.sql`, `src/db/migrations/0005_identity_merge_log.sql`, `src/db/migrations/0007_add_user_foreign_keys.sql`, `src/routes/identity.ts`, `src/db/identity.ts`, `src/index.ts`, `src/routes/docs.ts`, `prompts/PROMPT.md`, `prompts/TEMPLATE.md`, `package.json`
- Specific facts taken:
  - `user_product_access` (0004) already exists with `UNIQUE (user_id, product_id, role)`, `ck_access_vendor_scope`, and status-flip revocation (never deleted) — no new table needed.
  - `src/auth.ts:16-18` explicitly defers `products`/`vendor_id` token claims to "step 7 (RBAC), once `user_product_access` has read helpers" — this task is that step.
  - `src/authz/` is empty (OpenFGA is roadmap step 12) — this task is Layer 1 (plain Postgres role check) only, per `prompts/PROMPT.md` step 8/12 split.
  - No `role` field exists on `user`; no admin middleware exists anywhere in the codebase yet.
  - `prompts/PROMPT.md` pins a single path: `POST /api/admin/access — grant or revoke product access`.

## Assumptions

1. **Admin authority (confirmed with user):** the caller must hold an **active** `user_product_access` row with `role = 'ADMIN'` for the **same `product_id`** as the grant/revoke target. Product-scoped, not global. A LMS admin cannot touch Masterclass access and vice versa.
2. **2FA gap (confirmed with user):** the security skill requires 2FA for `ADMIN`/`VENDOR_ADMIN`, but Better Auth's `twoFactor` plugin isn't mounted yet (deferred per `src/auth.ts` step-6 comment). This task enforces the role check only. A `// ponytail:` comment marks the gap and names the upgrade path (enforce 2FA once the plugin lands); this is not a blocker for this task.
3. **Auth transport:** the admin console calls this over a Better Auth session cookie (`auth.api.getSession`), not a Bearer JWT — no product is yet integrated as an OAuth client (that's step 9+), so cookie session is the only real caller today. Session lookup is a live DB read, satisfying the "introspect on admin endpoints" rule without adding anything.
4. **Single endpoint, discriminated body:** `POST /api/admin/access` with an `action: "grant" | "revoke"` field, per the path AGENTS.md already pins, rather than two routes.
5. **No new audit table:** `user_product_access.granted_by/granted_at/revoked_at` already is the audit trail (grants/revokes are never deleted). A separate `admin_access_log` table would duplicate it — not building one. A structured log line (`usr_` ids only) is emitted on every grant/revoke for operational visibility.
6. **No self-lockout protection:** an ADMIN can revoke their own last ADMIN row for a product. Not building lockout prevention — flagging it here rather than guessing it's wanted.
7. **VENDOR_ADMIN cannot call this endpoint.** Vendor-admin self-service over their own vendor's `VENDOR` rows is not in scope here (natural fit for step 11, vendor SSO) — this task's caller check is `role = 'ADMIN'` only.
8. Granting a role that already has an **active** row is idempotent (no-op, returns the existing row) rather than a 409 — simpler than inventing a conflict error for a same-state request.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/db/access.ts` | create | `Bun.sql` queries: `grantAccess`, `revokeAccess`, `getActiveAccessForUser`, `findAdminAccess` |
| `src/services/access.ts` | create | Business logic: authorize caller, validate vendor_id/role pairing, call db layer |
| `src/routes/admin/access.ts` | create | Thin handler: session lookup, zod parse, call service, shape response. Exports `bodySchema`/`responseSchema` for docs. |
| `src/index.ts` | modify | Register `"/api/admin/access": { POST: adminAccessRoute }` |
| `src/auth.ts` | modify | `customAccessTokenClaims` adds `products: [{ product_id, role, vendor_id }]` from `getActiveAccessForUser`, replacing the identity-only stub |
| `src/routes/docs.ts` | modify | Add the `/api/admin/access` path to the generated spec, reusing the route's zod schemas |
| `tests/services/access.test.ts` | create | Unit tests for grant/revoke/authorize logic |
| `tests/routes/admin/access.test.ts` | create | Route-level tests: auth, authorization, happy path |

No migration file — `user_product_access` (0004) already has everything this task needs.

## Implementation requirements

1. `src/db/access.ts`:
   - `getActiveAccessForUser(userId, client = sql)`: `SELECT product_id, role, vendor_id FROM user_product_access WHERE user_id = $1 AND status = 'active'`.
   - `findAdminAccess(userId, productId, client = sql)`: same query filtered to `role = 'ADMIN'`, used for the authorization check. Returns boolean via row presence.
   - `grantAccess({ userId, productId, role, vendorId, grantedBy }, client = sql)`: `INSERT ... ON CONFLICT (user_id, product_id, role) DO UPDATE SET status = 'active', vendor_id = EXCLUDED.vendor_id, granted_by = EXCLUDED.granted_by, granted_at = now(), revoked_at = NULL RETURNING *`. New id via `newId("access")` only on insert path (`ON CONFLICT` reuses the existing id — do not regenerate it).
   - `revokeAccess({ userId, productId, role }, client = sql)`: `UPDATE user_product_access SET status = 'revoked', revoked_at = now() WHERE user_id = $1 AND product_id = $2 AND role = $3 AND status = 'active' RETURNING *`. Returns `null` if no active row matched (already revoked or never existed) — caller maps this to 404.
2. `src/services/access.ts`:
   - `grantProductAccess(actorUserId, input)`: calls `findAdminAccess(actorUserId, input.productId)`; throws a typed `ForbiddenError` if false. Validates `vendorId` is present iff `role` is `VENDOR`/`VENDOR_ADMIN` (mirrors `ck_access_vendor_scope` — belt and suspenders, DB still enforces it). Confirms the target `user_id` exists (`SELECT 1 FROM "user" WHERE id = $1`) before granting, throwing `NotFoundError` if not. Calls `grantAccess`, logs `{ event: "access_granted", actorUserId, targetUserId, productId, role }`.
   - `revokeProductAccess(actorUserId, input)`: same authorization check, calls `revokeAccess`, throws `NotFoundError` if it returns null, logs `{ event: "access_revoked", ... }`.
3. `src/routes/admin/access.ts`:
   - `bodySchema`: `z.discriminatedUnion("action", [grantSchema, revokeSchema])` where both share `{ user_id: z.string().min(1), product_id: z.enum(PRODUCT_IDS), role: z.enum(ROLES) }` and `grantSchema` adds `vendor_id: z.string().min(1).optional()`.
   - Handler: `auth.api.getSession({ headers: req.headers })` → 401 if no session. `safeParse` body → 400 `invalid_request`. Dispatch to `grantProductAccess`/`revokeProductAccess` by `action`. Map `ForbiddenError` → 403 `forbidden`, `NotFoundError` → 404 `not_found`. Success → 200 with the row (camelCase via `responseSchema`).
4. `src/auth.ts`: replace the identity-only `customAccessTokenClaims` return with `{ email, email_verified, products: await getActiveAccessForUser(user.id) }` (map to `{ product_id, role, vendor_id }` per row) — matches the comment already sitting on that line.
5. `src/routes/docs.ts`: add `/api/admin/access` → `post` with the discriminated `bodySchema`/`responseSchema`, marked `security: [{ session: [] }]` (or the doc equivalent already used for other session-authed routes), described as admin-only.

## Data model impact

None. `user_product_access` (migration 0004, FK added in 0007) already has every column and constraint this task needs. Save rules already enforced in schema (`ck_access_vendor_scope`, `uq_access_user_product_role`, `ck_access_revoked_at`) — no new writer-side duplication beyond the belt-and-suspenders vendor_id check in the service (fails fast with a clean 400 instead of surfacing a raw constraint violation).

## Security requirements

- Server-side only: the authorization check (`findAdminAccess`) runs in `services/access.ts`, never trusted from the request.
- No new secrets touched.
- Takeover paths: this endpoint does not authenticate anyone and does not touch `user_identity`, so none of the four listed paths apply directly. The relevant risk here is **privilege escalation** — an ADMIN for product A granting themselves ADMIN on product B. Closed by the product-scoped check (assumption 1): `findAdminAccess` is always scoped to the target `product_id`, not just "is ADMIN somewhere."
- No enumeration concern: this is an authenticated admin-only endpoint, not a public identity check: differentiating "user not found" from "not authorized" in the response is fine and useful for an admin console.
- Rate limiting: not adding any — this isn't a public/anonymous endpoint like `/api/identity/resolve`; Better Auth's session lookup is already the gate.
- 2FA: **not enforced in this task** (assumption 2) — `// ponytail: role-check only, no 2FA gate; enforce once the twoFactor plugin is mounted (roadmap)` left in `src/routes/admin/access.ts`.
- Every branch of the handler is one of: 401 (no session), 400 (bad body), 403 (not admin for this product), 404 (target user or active row not found), 200. No implicit-allow path.

## Authorization impact

- **Layer 1 (RBAC):** this task builds it — grant/revoke against `user_product_access`, gated by a caller's own active `ADMIN` row for the same product.
- **Layer 2 (graph/OpenFGA):** none. `src/authz/` stays empty; no outbox events are written by this task (outbox exists for step 12 tuple sync — out of scope here, confirmed by `prompts/PROMPT.md`).
- **Layer 3 (conditions):** none.

## API documentation impact

- Route added: `POST /api/admin/access`.
- Request schema: `bodySchema` (discriminated union, see above) in `src/routes/admin/access.ts`, reused as-is in `docs.ts` — no parallel spec.
- Response schema: `responseSchema` — the `UserProductAccessRow` shape (camelCase), same object validated with `.parse()` before the route returns it.
- Auth requirement: Better Auth session cookie; documented as session-authed, admin-only (not public, not the internal/signed-request scheme).
- Visibility: admin-only, but **documented** (not excluded like `/api/internal/*`) — it's reachable from the admin console, not network-allowlisted.
- Error responses documented honestly: `401 unauthenticated`, `400 invalid_request`, `403 forbidden` (caller lacks ADMIN for this product), `404 not_found` (target user, or no active row to revoke). No indistinct-by-design response here (that rule is for the public resolve/OTP endpoints only).

## Bun-native check

- New dependencies: `none`. `Bun.sql`, `zod` (already a dependency), and Better Auth's existing session API cover everything.

## Acceptance criteria

- [ ] An ADMIN for `product_id=X` can grant any role (with vendor_id when required) to another user for product X.
- [ ] The same ADMIN gets 403 attempting to grant/revoke access for a different `product_id` where they hold no ADMIN row.
- [ ] A non-admin (or unauthenticated) caller gets 401/403, never a silent no-op.
- [ ] Revoking an already-revoked or nonexistent row returns 404, not a false 200.
- [ ] Granting an already-active role is idempotent — returns the existing row, does not duplicate or error.
- [ ] A fresh access token for a user with active `user_product_access` rows carries a `products` claim reflecting exactly those rows; a revoked row is absent from the claim on the next token issuance.
- [ ] `/api/admin/access` appears correctly in the Scalar reference (non-prod) with accurate request/response shapes and error responses.

## Tests to add

- [ ] `tests/services/access.test.ts` — `grantProductAccess` inserts a new row for an authorized ADMIN
- [ ] `tests/services/access.test.ts` — `grantProductAccess` reactivates a previously revoked row (status flips back, `revoked_at` clears)
- [ ] `tests/services/access.test.ts` — `grantProductAccess` throws `ForbiddenError` when the actor is ADMIN for a different product — the escalation case
- [ ] `tests/services/access.test.ts` — `grantProductAccess` throws when `role` is `VENDOR`/`VENDOR_ADMIN` and `vendor_id` is missing
- [ ] `tests/services/access.test.ts` — `grantProductAccess` throws `NotFoundError` for an unknown target `user_id`
- [ ] `tests/services/access.test.ts` — `revokeProductAccess` sets `status='revoked'` and `revoked_at`, and is idempotent-safe (second call throws `NotFoundError`, doesn't error the DB)
- [ ] `tests/routes/admin/access.test.ts` — no session → 401
- [ ] `tests/routes/admin/access.test.ts` — session present but not ADMIN for the target product → 403
- [ ] `tests/routes/admin/access.test.ts` — malformed body (bad `product_id`/`role` enum, or missing `vendor_id` for a vendor role) → 400
- [ ] `tests/auth.test.ts` (or wherever token claims are already tested) — `customAccessTokenClaims` includes `products` matching active access rows only

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun audit`
- [ ] `bun run db:migrate` on a staging clone — N/A, no migration in this task, but confirm nothing else is pending
- [ ] the changed route appears correctly in the Scalar reference

## How to verify it

```bash
1. bun run check
   → typecheck clean, all tests pass, audit clean

2. bun run dev
   → server starts

3. Sign in as a seeded user with an ADMIN row for product "lms", grant CPA access to another user:
   curl -s -b cookies.txt -X POST localhost:3000/api/admin/access \
     -H 'content-type: application/json' \
     -d '{"action":"grant","user_id":"usr_target","product_id":"lms","role":"CPA"}'
   → 200, body has status:"active", granted_by:"usr_<admin>", granted_at set, revoked_at null

4. Same admin attempts the same call with "product_id":"masterclass"
   → 403 {"error":"forbidden"}  ← the escalation-prevention check, not just a 200

5. curl the resolve schema check:
   curl -s localhost:3000/api/docs/openapi.json | jq '.paths."/api/admin/access"'
   → present, matches the zod schema

6. NODE_ENV=production bun src/index.ts &
   curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/docs   → 404  (unchanged, re-confirms step 7's rule still holds)
```

## Out of scope for this task

- OpenFGA tuple writes / outbox events for access changes (step 12).
- Vendor-admin self-service over their own vendor's rows (natural step 11 extension).
- 2FA enforcement for ADMIN/VENDOR_ADMIN (blocked on the `twoFactor` plugin landing — flagged with a `ponytail:` comment, not built here).
- Self-lockout prevention (an admin revoking their own last ADMIN row).
- A dedicated `admin_access_log` audit table — `user_product_access`'s own columns already are the audit trail.
- Listing/searching access (`GET /api/admin/access?...`) — only grant/revoke were asked for.
