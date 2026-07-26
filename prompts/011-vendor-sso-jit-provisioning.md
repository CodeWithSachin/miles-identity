# 011 — Inbound vendor SSO: DNS domain verification and JIT provisioning

## Goal

Let a Masterclass vendor's own IdP (SAML 2.0 or OIDC) sign its employees into Miles Identity, gated on DNS-proven domain ownership, and auto-provision those employees with `masterclass`/`VENDOR` access only.

## What it read

- Skills: `.agents/skills/better-auth.md`, `.agents/skills/security.md`, `.agents/skills/scalar-api-docs.md`
- `AGENTS.md` — architecture rules, data model (`vendor`, `user_product_access`), tech-stack table
- `docs/architecture-plan.md` §4.4 (Inbound vendor SSO), §5 (authorization layers)
- Files opened: `src/auth.ts`, `src/db/types.ts`, `src/db/migrations/0003_vendor.sql`, `0004_user_product_access.sql`, `0007_add_user_foreign_keys.sql`, `src/db/access.ts`, `src/services/access.ts`, `src/routes/admin/access.ts`, `src/db/identity.ts`, `src/identity/normalise.ts`, `src/index.ts`, `src/lib/config.ts`, `src/lib/errors.ts`, `src/db/seed-oauth-clients.ts`, `src/db/auth-schema.ts`, `package.json`
- `node_modules/@better-auth/sso/dist/index-P-Jf_8P1.d.mts` and `dist/index.mjs` — read the actual plugin source (not just README) for: `domainVerification` option and its enforcement (`index.mjs:2002,2874,3025` throw `UNAUTHORIZED` pre-callback if `!provider.domainVerified`), `provisionUser` timing (`index.mjs:2193,3142` — runs after the account is created, before the session cookie is set, with **no surrounding try/catch**), and the account-linking path.
- `node_modules/better-auth/dist/oauth2/link-account.mjs` — `handleOAuthUserInfo`: an existing verified user with a matching email is **silently linked** to a new SSO account whenever `isTrustedProvider` is true and `accountLinking?.disableImplicitLinking` is not set — this is exactly security.md takeover path 3.

## Assumptions

1. **One verified domain per vendor**, matching architecture doc §4.4 ("store one `ssoProvider` row per vendor"). `vendor.allowed_email_domains` (already `text[]`) is populated with exactly one entry at registration. Multi-domain vendors are out of scope (see Out of scope).
2. **BA's own `user.emailVerified`/`emailVerified` claim is left alone.** It is already `false` for every non-social account in this system (our alias-OTP plugin bypasses BA's built-in email plugins entirely, per `.agents/skills/better-auth.md`), so a vendor-JIT user is consistent with existing accounts, not a regression. Verification of record lives in `user_identity.is_verified`, set directly by this feature. Reconciling BA's own field is a pre-existing gap, not something this task introduces or fixes.
3. **`provisionUser` cannot prevent the underlying BA `user`/`account` row from being created** (it runs after `handleOAuthUserInfo`, with no surrounding try/catch in the plugin). Throwing from it still prevents the session cookie and our own access grant/identity row from ever being created — no session, no product access, no verified alias — which is the actual security property. An orphaned, access-less BA user row can be left behind for a rejected attempt (mismatched domain, disabled vendor); this is accepted, not remediated, in this task.
4. **"Disabling a provider blocks new logins immediately" (security.md) is enforced by deleting the underlying Better Auth `ssoProvider` row**, not by a flag `provisionUser` checks — because `provisionUser` only fires on first-time registration by default (`provisionUserOnEveryLogin` defaults to `false`), so a returning vendor employee's second login would never re-run it. Deleting the BA provider row makes `/sign-in/sso` and the callback fail closed for every future attempt, first-time or returning. Re-enabling a disabled vendor means re-registering the SSO provider from scratch (its OIDC/SAML config is not retained) — acceptable, since disabling is a rare/administrative action.
5. `grantedBy` on the JIT access grant uses the sentinel `"system:vendor-sso"`. Migration 0007 explicitly notes `granted_by` carries no FK "may be a non-user system actor" — same pattern as any future system-initiated grant.
6. Better Auth's own SSO management endpoints (`/sso/register`, `/sso/update-provider`, `/sso/delete-provider`, `/sso/request-domain-verification`, `/sso/verify-domain`) require only *a* session, not any role — calling them directly would let any signed-in user create/verify/delete SSO providers. These are added to `disabledPaths` (blocking the HTTP route only — `auth.api.*` in-process calls are unaffected, same mechanism already used for `/token`) so the only way to reach them is through our own ADMIN-gated routes. `/sign-in/sso`, `/sso/callback*`, `/sso/saml2/*` (the actual login flow) and the read-only `/sso/providers`, `/sso/get-provider` stay reachable.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/auth.ts` | modify | mount `sso()` from `@better-auth/sso` with `domainVerification.enabled: true`, `provisionUser`, `organizationProvisioning: { disabled: true }`; add the 5 SSO-management paths to `disabledPaths`; add `account.accountLinking.disableImplicitLinking: true` |
| `src/db/vendor.ts` | create | all SQL for the `vendor` table: `createVendor`, `getVendorById`, `getVendorBySsoProviderId`, `setVendorSsoProvider` (registers/re-registers, resets to pending), `activateVendor`, `disableVendorRow` |
| `src/services/vendor-sso.ts` | create | `registerVendorSsoProvider`, `verifyVendorDomain`, `disableVendor` (each: authz check + orchestration), `provisionVendorUser` (the `provisionUser` body: vendor lookup, active check, domain match, verified-identity + VENDOR-access grant) |
| `src/routes/admin/vendors.ts` | create | 4 thin HTTP handlers: create vendor, register/re-register SSO provider, verify domain, disable |
| `src/index.ts` | modify | mount `/api/admin/vendors`, `/api/admin/vendors/:vendorId/sso-provider`, `/api/admin/vendors/:vendorId/verify-domain`, `/api/admin/vendors/:vendorId/disable` |
| `src/db/types.ts` | modify | add `ID_PREFIX.vendorSso = "ssp_"` for the Better-Auth `providerId` we generate |
| `src/routes/docs.ts` | modify (if needed) | confirm the new `/api/admin/vendors*` zod schemas are picked up by the existing "ours" spec generation; no separate wiring expected but verify |
| `tests/db/vendor.test.ts` | create | real-schema tests for `src/db/vendor.ts` |
| `tests/services/vendor-sso.test.ts` | create | injected-dependency tests for authz gate, domain-match, vendor-active gate, negative cases |
| `tests/routes/admin/vendors.test.ts` | create | status-code mapping tests, injected session/services |
| `tests/auth/instance.test.ts` | modify | assert `disabledPaths` includes the 5 SSO-management paths; assert `accountLinking.disableImplicitLinking` is set |

_Better Auth's own tables also change (new `ssoProvider` table, and either a `verification`-table or `secondaryStorage` use for SAML `InResponseTo`/domain-verification-token storage) — via `bun run auth:schema` / `bun run auth:migrate`, not a file in `src/db/migrations/`. See Data model impact._

## Implementation requirements

1. **`src/auth.ts`**: import `sso` from `@better-auth/sso`. Add to `plugins`:
   ```ts
   sso({
     domainVerification: { enabled: true },
     organizationProvisioning: { disabled: true }, // no organization() plugin mounted
     provisionUser: async ({ user, userInfo, provider }) =>
       (await getProvisionVendorUser())({ userId: user.id, email: userInfo.email, ssoProviderId: provider.providerId }),
   })
   ```
   `getProvisionVendorUser` is a lazy `await import("@/services/vendor-sso")` accessor, same jiti/CLI-compatibility reasoning as `getAccessTokenClaimsBuilder` (the service imports `@/db/vendor.ts`, which has a top-level `import ... from "bun"`).
2. Extend `disabledPaths` to also disable, in every environment (not just production): `/sso/register`, `/sso/update-provider`, `/sso/delete-provider`, `/sso/request-domain-verification`, `/sso/verify-domain`.
3. Add top-level `account: { accountLinking: { disableImplicitLinking: true } }` to the `betterAuth()` config — the fix for takeover path 3 (silent auto-link of a federated login to an existing verified account by email match).
4. **`src/db/vendor.ts`** (`Bun.sql`, parameterised, mirrors `src/db/access.ts` style):
   - `createVendor(input: { name: string; domain: string }, client)` → insert with `allowed_email_domains = [domain]`, `status = 'pending'`, `sso_provider_id = NULL`. Unique-name conflict surfaces as the existing `uq_vendor_name` constraint (caller maps to 409/400 — see route section).
   - `getVendorById(id, client)`, `getVendorBySsoProviderId(ssoProviderId, client)` → `VendorRow | null`.
   - `setVendorSsoProvider(id, ssoProviderId, client)` → `UPDATE vendor SET sso_provider_id = $1, domain_verified_at = NULL, status = 'pending' WHERE id = $2 RETURNING *` (re-registration always resets verification state — a stale `domain_verified_at` from a previous, now-replaced provider must never carry over).
   - `activateVendor(id, client)` → `UPDATE ... SET domain_verified_at = now(), status = 'active' WHERE id = $1 AND status <> 'disabled' RETURNING *` (a disabled vendor cannot be silently re-activated by a stray verify call).
   - `disableVendorRow(id, client)` → `UPDATE ... SET status = 'disabled', sso_provider_id = NULL WHERE id = $1 RETURNING *`.
5. **`src/services/vendor-sso.ts`** — DB and Better-Auth collaborators injected (same DI pattern as `src/services/access.ts` / `src/services/otp-signin.ts`), so this file is testable without a live database or a live Better Auth instance:
   - `registerVendorSsoProvider(actorUserId, input: { vendorId, issuer, oidcConfig? | samlConfig? }, deps)`:
     1. `hasProductAdmin(actorUserId, "masterclass")` → else `ForbiddenError`.
     2. Load vendor by id → else `NotFoundError`.
     3. Exactly one of `oidcConfig`/`samlConfig` must be present → else `ValidationError` (mirrors `assertVendorScope`'s style in `services/access.ts`).
     4. Generate `providerId = newId("vendorSso")`.
     5. Call injected `registerProvider({ providerId, issuer, domain: vendor.allowed_email_domains[0], oidcConfig, samlConfig })` → wraps `auth.api.registerSSOProvider`.
     6. `setVendorSsoProvider(vendor.id, providerId)`.
     7. Return `{ providerId, domainVerificationToken, dnsRecordHost: "_better-auth-token." + domain, dnsRecordValue: domainVerificationToken }` — the exact instructions an admin needs to hand to the vendor.
   - `verifyVendorDomain(actorUserId, vendorId, deps)`:
     1. Same authz gate.
     2. Load vendor → else `NotFoundError`. `vendor.sso_provider_id === null` → `ValidationError` ("no SSO provider registered").
     3. Call injected `verifyDomain({ providerId: vendor.sso_provider_id })` → wraps `auth.api.verifyDomain`. Propagate its `404`/`409`/`502` as the same status via `IntegrationError`/`ValidationError` mapping in the route (BA already throws a typed `APIError` — the route unwraps `error.status`).
     4. `activateVendor(vendor.id)`.
   - `disableVendor(actorUserId, vendorId, deps)`:
     1. Same authz gate.
     2. Load vendor → else `NotFoundError`.
     3. If `vendor.sso_provider_id` set, call injected `deleteProvider({ providerId })` → wraps `auth.api.deleteSSOProvider`.
     4. `disableVendorRow(vendor.id)`.
   - `provisionVendorUser({ userId, email, ssoProviderId }, deps)` — the `provisionUser` body:
     1. `getVendorBySsoProviderId(ssoProviderId)` → if `null` or `status !== "active"`, throw `ForbiddenError` (fail closed — no vendor row, or a disabled/pending one that somehow still has a live BA provider).
     2. Normalise `email` via `normaliseEmail` (existing `src/identity/normalise.ts`), extract the domain (`split("@")[1]`), and require it to be one of `vendor.allowed_email_domains` → else `ForbiddenError`. This is the actual enforcement that a vendor's IdP cannot assert an email outside the domain it proved ownership of — Better Auth's own `isTrustedProvider` check influences account-linking trust only, it does not block sign-in on a cross-domain email.
     3. `createVerifiedIdentity({ userId, type: "email", value: normalisedEmail, source: "masterclass" })` — `ON CONFLICT DO NOTHING` already makes this idempotent and safe if ever re-run.
     4. `grantAccess({ userId, productId: "masterclass", role: "VENDOR", vendorId: vendor.id, grantedBy: "system:vendor-sso" })` — hardcoded product/role, never derived from any provider- or vendor-supplied field, so there is no path from a vendor assertion to anything but exactly this grant.
6. **`src/routes/admin/vendors.ts`** — thin handlers mirroring `src/routes/admin/access.ts`: parse with zod, resolve session (401 if none), call the service, map `ForbiddenError`→403, `NotFoundError`→404, `ValidationError`→400, `IntegrationError`→502, success → `responseSchema.parse(...)` with `cache-control: no-store`. Exported zod schemas feed Scalar per `.agents/skills/scalar-api-docs.md`.
7. **`src/index.ts`** — mount the 4 routes, all `POST`, right beside `/api/admin/access`.

## Data model impact

- **None** in `src/db/migrations/` — the `vendor` table (0003) already has every column this feature needs.
- **Better Auth's own schema changes**: the `sso` plugin adds its `ssoProvider` table (and, if `secondaryStorage`/Redis isn't used for it, an `InResponseTo`/domain-verification-token store falling back to the `verification` table — already present). Required step, not optional: `bun run auth:schema` (review the generated SQL in `better-auth-schema.sql`), then `bun run auth:migrate`. This is the Better-Auth-owned path (`bunx`/`auth-schema.ts`), never `src/db/migrate.ts` — the two paths stay separate per `.agents/skills/better-auth.md`.

## Security requirements

- **Takeover path 3 (federated login auto-linked to a password account by email)**: closed via `account.accountLinking.disableImplicitLinking: true`. Without it, `handleOAuthUserInfo` silently links any SSO login to an existing user with a matching, already-verified email whenever the domain is verified (`isTrustedProvider`) — exactly the forbidden behaviour. With it, that case now returns `{error: "account not linked"}` → the SSO callback redirects with an error instead of establishing a session. An explicit verified-link flow for that case is a separate, unbuilt feature (see Out of scope).
- **Takeover path 4 (vendor asserts a domain it does not own)**: two independent layers — (a) Better Auth's `domainVerification.enabled` gate refuses to even start a sign-in against an unverified provider (`UNAUTHORIZED` thrown before any account is touched); (b) `provisionVendorUser` independently re-checks the asserted email's domain against `vendor.allowed_email_domains`, because Better Auth's own domain check only affects account-linking trust, not whether a *new* JIT user may be created for an out-of-domain email.
- **JIT scope**: `provisionVendorUser` hardcodes `product_id: "masterclass"`, `role: "VENDOR"`. There is no parameter, mapped attribute, or vendor-controlled field that can widen this — a vendor IdP can never mint LMS, Miles One, or ADMIN access, satisfying security.md directly.
- **Disabling a vendor blocks all future logins immediately** (not just new sign-ups) by deleting the underlying Better Auth `ssoProvider` row (see Assumption 4) — the sign-in/callback endpoints then have no provider to resolve at all, for a first-time or returning user alike. Existing sessions/tokens are not force-revoked here (security.md: "existing tokens drain over the TTL" — already true given the 5–15 min access-token TTL and database-backed sessions; explicit session revocation on disable is a separate action, out of scope for this task).
- **Secrets never logged**: `oidcConfig.clientSecret`, `samlConfig.cert`/`privateKey`, and the raw `domainVerificationToken` value must never appear in a `log.info`/`log.error` call — only vendor id / provider id / event name, matching the existing `log.info("access_granted", {...})` shape in `services/access.ts`.
- **No implicit default on admin routes**: every handler in `src/routes/admin/vendors.ts` performs its own `hasProductAdmin(actorUserId, "masterclass")` check, same as `routes/admin/access.ts` — no shared middleware assumed.
- **Better Auth's own SSO-mutation endpoints are not reachable directly** (Assumption 6) — closes the gap where any authenticated user (not just an ADMIN) could otherwise call `POST /api/auth/sso/register` themselves.
- 2FA: `.agents/skills/better-auth.md` lists `twoFactor()` as mandatory for ADMIN/VENDOR_ADMIN, but the plugin isn't mounted yet (pre-existing gap, already flagged with a `ponytail:` comment in `routes/admin/access.ts`). This task does not mount it — same gap, not widened, not fixed here.

## Authorization impact

- **Layer 1 (RBAC)**: new grant path into `user_product_access` — system-initiated (`grantedBy: "system:vendor-sso"`), always `product_id="masterclass"`, `role="VENDOR"`, `vendor_id` set. Uses the existing `grantAccess` writer unchanged.
- **Layer 2 (OpenFGA graph)**: `None` — `src/authz/` does not exist yet in this codebase; no outbox events are written anywhere yet for access grants (`grantAccess`/`grantProductAccess` write no outbox row today), so this task does not introduce a new gap, just doesn't close the pre-existing one.
- **Layer 3 (conditions)**: `None`.

## API documentation impact

- **Routes added**: `POST /api/admin/vendors`, `POST /api/admin/vendors/:vendorId/sso-provider`, `POST /api/admin/vendors/:vendorId/verify-domain`, `POST /api/admin/vendors/:vendorId/disable`. All session-authed, ADMIN-for-`masterclass`-only, documented via the zod request/response schemas exported from `src/routes/admin/vendors.ts` (same pattern as `routes/admin/access.ts`) — one definition, not a parallel one.
- **Better Auth's half**: `/api/auth/sso/*` routes newly appear in the plugin's own generated spec. `disabledPaths` removes 5 of them from being *servable*, but the `openAPI()` plugin may still list them as declared-but-disabled — verify during manual check (below) and, if the spec still describes them as callable, treat that as a doc-accuracy bug to flag (not silently ship a spec that lies about what's reachable). `/sign-in/sso`, `/sso/callback*`, `/sso/saml2/*`, `/sso/providers`, `/sso/get-provider` remain live and documented as-is by the plugin.
- **Error responses**: 401 unauthenticated; 403 not-ADMIN-for-masterclass; 404 vendor/provider not found; 400 malformed body or vendor already has no pending provider to verify; 502 Better Auth's own DNS lookup failure surfaced from `verifyDomain`. None of these are the enumeration-sensitive kind `.agents/skills/scalar-api-docs.md` warns about (`/api/identity/resolve`'s indistinguishable-hit-or-miss shape) — these are ordinary admin-console error codes and are described honestly, differing per case.
- Nothing here is `/api/internal/*` — no exclusion needed on that account.

## Bun-native check

- New dependencies: `none`. `@better-auth/sso@1.6.25` is already a declared dependency (`package.json`) and unused until now — this task is what activates it.

## Acceptance criteria

- [ ] An admin holding `ADMIN` for `masterclass` can create a vendor, register an SSO provider (OIDC or SAML), receive DNS TXT instructions, verify the domain, and the vendor row flips to `active` with `domain_verified_at` set.
- [ ] A sign-in attempt against a vendor whose domain is not yet verified is rejected before any user is touched.
- [ ] A first-time vendor employee signing in via the verified provider ends up with: a `user` row, a verified `user_identity` row for their email, and exactly one `user_product_access` row (`masterclass`/`VENDOR`/that vendor's id) — no LMS, Miles One, or ADMIN access.
- [ ] A sign-in asserting an email outside the vendor's verified domain is rejected and grants nothing.
- [ ] Disabling a vendor causes an immediate sign-in failure for both a brand-new and a previously-provisioned employee of that vendor.
- [ ] An existing user with a verified password/OTP account and the same email as an incoming SSO identity is **not** silently linked — the login errors instead.
- [ ] `POST /api/auth/sso/register` (and the other 4 disabled paths) returns 404/not-found when called directly, unauthenticated or not.
- [ ] `bun run check` passes.

## Tests to add

- `tests/db/vendor.test.ts` (real schema, mirrors `tests/db/access.test.ts`):
  - [ ] `createVendor` stores a single-element `allowed_email_domains`, `status='pending'`.
  - [ ] `setVendorSsoProvider` resets `domain_verified_at` to null and `status` to `pending` even if previously active (re-registration clears stale verification).
  - [ ] `activateVendor` refuses to activate (no-op / stays disabled) a `disabled` vendor.
  - [ ] `disableVendorRow` clears `sso_provider_id`.
- `tests/services/vendor-sso.test.ts` (injected deps, no live DB/Better Auth):
  - [ ] `registerVendorSsoProvider` — 403 (`ForbiddenError`) for a non-ADMIN actor.
  - [ ] `registerVendorSsoProvider` — `ValidationError` when both or neither of `oidcConfig`/`samlConfig` supplied.
  - [ ] `verifyVendorDomain` — `ValidationError` when the vendor has no registered provider.
  - [ ] `provisionVendorUser` — grants exactly `masterclass`/`VENDOR` for a matching-domain, active vendor.
  - [ ] `provisionVendorUser` — **negative**: throws and grants nothing when the vendor is `pending`/`disabled`.
  - [ ] `provisionVendorUser` — **negative**: throws and grants nothing when the asserted email's domain is not in `allowed_email_domains`.
- `tests/routes/admin/vendors.test.ts` (injected session/services, mirrors `tests/routes/admin/access.test.ts`):
  - [ ] 401 with no session; 403 when the service throws `ForbiddenError`; 404 on `NotFoundError`; 400 on `ValidationError`; 200 on success for each of the 4 handlers.
- `tests/auth/instance.test.ts` (extend):
  - [ ] `disabledPaths` contains all 5 SSO-management paths.
  - [ ] `account.accountLinking.disableImplicitLinking === true`.

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun audit`
- [ ] `bun run auth:schema` then review `better-auth-schema.sql`, then `bun run auth:migrate` on a staging clone (Better Auth schema changed — new `ssoProvider` table)
- [ ] the 4 new `/api/admin/vendors*` routes appear correctly in the Scalar reference

## How to verify it

```bash
1. bun run check
   → typecheck, full test suite, and audit all pass

2. bun run auth:schema
   → writes/updates better-auth-schema.sql including CREATE TABLE "ssoProvider" — review it
3. bun run auth:migrate
   → applies it to DATABASE_URL

4. bun run dev
5. curl -s localhost:3000/api/docs/openapi.json | jq '.paths | keys' | grep vendors
   → the 4 new admin routes are present

6. curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/auth/sso/register \
     -H 'content-type: application/json' -d '{}'
   → 404 (path disabled — the security property this task is actually gating)

7. (with a real admin session cookie)
   curl -s -X POST localhost:3000/api/admin/vendors -H 'content-type: application/json' \
     -H "cookie: $ADMIN_SESSION" -d '{"name":"Acme Prep","domain":"acmeprep.example"}'
   → 200, vendor row with status "pending"
```

Step 6 is the security-property check: it proves an unauthenticated, non-admin caller cannot reach Better Auth's own SSO-provider mutation endpoints, regardless of session — only our ADMIN-gated routes can.

## Out of scope for this task

- Multi-domain vendors (one verified domain per vendor only, matching architecture doc §4.4).
- An explicit "link this federated login to my existing account" flow — disabling implicit linking (correctly) blocks that case; building the deliberate opt-in link step is a separate feature.
- Force-revoking existing sessions/tokens when a vendor is disabled — only new sign-ins are blocked; the security.md line "revoke explicitly if the disable is a security response" implies that revocation is a distinct, deliberate action, not automatic here.
- `twoFactor()` for ADMIN/VENDOR_ADMIN — pre-existing gap, not introduced or fixed by this task.
- OpenFGA / Layer 2 authorization tuples for the new access grant — `src/authz/` doesn't exist yet.
- A GET/list endpoint for admin vendor management beyond what each mutating call already returns — Better Auth's own `/sso/providers`/`/sso/get-provider` cover provider inspection; a vendor-status listing view can follow later if actually needed.
- Reconciling Better Auth's own `user.emailVerified` field for JIT-provisioned users (Assumption 2).
