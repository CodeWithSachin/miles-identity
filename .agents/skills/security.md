# Skill: security

Read before any route, token, or integration work. Everything here applies without being restated in a prompt.

---

## Threat model in one line

This service authenticates ~300K–500K people across four products and federates external vendor identity providers. A bug here is an account-takeover or a cross-tenant data leak, not a rendering glitch.

## Never leaves the server

Database credentials · Better Auth secret · JWKS private keys · Salesforce integration secret · SMS gateway keys · email provider keys · OpenFGA store credentials · vendor SAML signing keys · pairwise secret · internal API signing keys.

**Never** in source, tests, fixtures, error messages, or a log line. All secrets flow through validated config in `lib/config.ts`.

## Never logged, at any level

Access tokens · refresh tokens · id tokens · authorization codes · OTP codes · passwords · password hashes · session tokens · full phone numbers · SAML assertions.

Log the `usr_` id. That is enough to investigate anything.

```ts
// WRONG
console.log("login failed", { email, password, otp });
// RIGHT
console.log({ event: "login_failed", userId, reason: "bad_credentials" });
```

## Token rules

| Rule | Why |
|---|---|
| JWT access tokens only, reject opaque | introspection per request makes this service a bottleneck and DOS target |
| 5–15 min TTL — **override the 3600s default** | bounds the revocation window |
| Refresh rotates every use; reuse revokes the family | detects stolen refresh tokens |
| Revoke sessions **and** refresh tokens on ban, suspend, password change, **and every merge** | otherwise a ghost identity works for the full token window |
| Never enable `pairwiseSecret` | breaks the one-global-`sub` premise |
| Introspect only on admin / payment / export endpoints | hybrid: cheap by default, strict where it matters |

## Enumeration

`/api/identity/resolve` answers "does this handle exist here?" for 300K+ people. Treat it as hostile.

- Identical response **shape** and **timing** for hit and miss. No early return on miss.
- Rate limit per IP **and** per handle. A distributed slow scan against one handle is also an attack.
- Never differentiate "no account" from "wrong password".
- Alert on scan patterns.

The same applies to password reset, OTP request, and signup — all three leak existence if the response differs.

## Account takeover paths — the four that matter here

1. **Unverified alias can log in.** Only `is_verified = true` authenticates. Ever.
2. **Alias-linking OTP sent to the newly claimed handle.** It goes to the already-verified handle instead.
3. **Federated login auto-linked to a password account by email.** Never. Requires an explicit verified link step.
4. **Vendor asserts a domain it does not own.** DNS TXT verification before the SSO provider can be activated.

Each of these gets a negative test. They are not theoretical — they are the standard ways identity systems get breached.

## Vendor federation

- `domain_verified_at` must be non-null before an SSO provider activates. Enforce in the writer **and** as a schema constraint.
- JIT-provisioned vendor users get `masterclass` access only. A vendor IdP can never mint LMS, Miles One, or ADMIN access.
- Disabling a provider blocks new logins immediately; existing tokens drain over the TTL. Revoke explicitly if the disable is a security response.
- Validate SAML: signature, `Issuer`, `Audience`, `NotBefore`/`NotOnOrAfter`, and replay via `InResponseTo`. Do not trust an assertion because it parsed.
- Map attributes explicitly. Never copy an unmapped attribute into a user field.

## Internal endpoints

`/api/internal/*` is not reachable from the public internet. Network allowlist **and** signed requests — either alone is insufficient.

- Salesforce callouts: verify the signature, enforce an idempotency key on `contactId`, rate limit.
- Provisioned users are `status='invited'` with **unverified** identities. Lead conversion is not identity verification.

## Authorization

- Every `/api/admin/*` and `/api/internal/*` handler performs an explicit check. There is no implicit default and no middleware you may assume ran.
- Deny by default. If OpenFGA is unreachable: deny plus alert, never allow.
- 2FA mandatory for `ADMIN` and `VENDOR_ADMIN`.
- Admin impersonation is logged with actor, target, and reason — always.

## Input validation

zod at every boundary: HTTP bodies, query params, webhook payloads, SAML attributes, environment variables. Inside the boundary, trust the types.

Never interpolate a SQL identifier from input. Never build a redirect URL from unvalidated input — validate against the client's registered `redirectUrls`.

## Dependencies

- `bun audit` is part of `bun run check`. A failing audit blocks the task.
- `bun why <pkg>` before adding anything. Justify it in the plan against the stack table in AGENTS.md.
- `linker = "isolated"` catches phantom dependencies.
- `exact = true` — no silent minor drift in an auth service.

## What to do when unsure

Stop. Ask one question. Write the assumption into the plan. Do not guess on a security boundary — a wrong guess here is an incident, and "the plan didn't say" is not a defence.
