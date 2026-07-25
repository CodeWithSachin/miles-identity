# Miles Identity — Centralised SSO & Identity Platform

**Implementation plan v1 · July 2026**

Consolidating authentication **and authorization** for LMS, Miles One, Miles Masterclass and Salesforce into a single OAuth 2.1 / OIDC identity provider — with an alias-based identity model to resolve duplicate emails and phone numbers, and a layered RBAC + graph access-control module.

---

## 1. Where you are today

| # | Product | Frontend | Backend | User types | Auth today |
|---|---------|----------|---------|-----------|-----------|
| 1 | **LMS** | Angular 17 (web) | Node.js | CPA, CMA, CAIRA | Local |
| 2 | **Miles One** | Flutter (mobile) | Django | CPA, CMA, CAIRA, Admin | Local |
| 3 | **Miles Masterclass** | Angular 22 (web) + Flutter | Django | Admin, Normal, **Vendor** | Local |
| 4 | **Salesforce** | — | Salesforce | Leads, Contacts | Salesforce |

Scale: roughly 40K–200K users per product, ~300K–500K total once deduplicated.

**Three problems to solve, in priority order:**

1. **Identity fragmentation.** The same human exists 2–3 times across three auth tables, keyed on different emails and phone numbers. There is no reliable way to answer "is this the same person?"
2. **No SSO.** A user authenticating to LMS must authenticate again for Masterclass. Internal auto-login across products is impossible.
3. **No vendor federation.** Masterclass vendors want their own IdP to log their people into Masterclass without a second login.

Note the ordering. SSO is the visible ask, but **identity resolution is the harder problem and must be solved first** — federating three inconsistent user tables just distributes the inconsistency.

---

## 2. Target architecture

A single standalone service, **Miles Identity**, acting as the OAuth 2.1 / OIDC authorization server for the whole estate. Every product becomes a *relying party*; none of them handle credentials.

```
                        ┌──────────────────────────┐
                        │        Salesforce        │
                        │  Leads → Contacts        │
                        └────────────┬─────────────┘
                          provisioning│ webhook (on Lead conversion)
                                     │  ▲ back-reference write
                                     ▼  │
   ┌───────────────────────────────────────────────────────────────────┐
   │                        MILES IDENTITY                             │
   │                  Bun + Better Auth + Postgres                     │
   │                                                                   │
   │  · Hosted login UI (password, email OTP, SMS OTP, social)          │
   │  · Alias resolution engine  (email/phone → one global user id)     │
   │  · OAuth Provider  → issues JWT access + id tokens, JWKS endpoint  │
   │  · SSO plugin      → inbound vendor SAML 2.0 / OIDC federation     │
   │  · Product access matrix + role claims                            │
   └───┬────────────────┬─────────────────┬───────────────┬────────────┘
       │ OIDC + PKCE    │ OIDC + PKCE     │ OIDC + PKCE   │ SAML / OIDC
       ▼                ▼                 ▼               ▼ (inbound)
 ┌───────────┐   ┌──────────────┐  ┌────────────────┐  ┌──────────────┐
 │  1. LMS   │   │ 2. Miles One │  │ 3. Masterclass │  │ Vendor IdPs  │
 │ Ng17+Node │   │ Flutter+Djngo│  │ Ng22+Flutter+Dj│  │ Azure/Okta/… │
 └───────────┘   └──────────────┘  └────────────────┘  └──────────────┘
   resource         resource            resource
   server           server              server
   (verify JWT via JWKS — no auth logic, no password columns)
```

### Which Better Auth pieces

| Need | Plugin | Status to be aware of |
|---|---|---|
| Act as OAuth/OIDC provider | **`@better-auth/oauth-provider`** + `jwt()` | Current, OAuth 2.1, PKCE+S256 required, JWKS-verifiable, introspection & revocation. Set `disabledPaths: ["/token"]`. |
| ~~`oidcProvider`~~ | — | **Do not use.** Officially "in active development, may not be suitable for production", JWKS not fully implemented, and being deprecated in favour of `oauth-provider`. |
| Inbound vendor SSO | **`@better-auth/sso`** | Supports OIDC, OAuth2 and SAML 2.0. **Self-service** vendor SSO configuration is a paid enterprise feature — see §10.3. |
| Passwordless login | `emailOTP()`, `phoneNumber()` | `phoneNumber` supports `signUpOnVerification`. Replace the default `temp.better-auth.com` placeholder domain with your own. |
| 2FA | `twoFactor()` | Enforce for Admin and Vendor-admin roles. |
| Admin operations | `admin()` | Ban, impersonate, list users. |

### Runtime

Bun is a reasonable choice — Better Auth is built on standard `Request`/`Response` and runs natively. Two caveats worth being deliberate about:

- Put **Redis in front of session lookups** (Better Auth supports secondary storage). At 300K+ users every page view otherwise becomes a Postgres round-trip.
- Miles Identity is now a **single point of failure for four products**. Minimum two instances behind a load balancer, health checks, and an independent uptime alert. This is no longer "just an auth library".

---

## 3. Data model

### 3.1 Core: user + aliases

The central design decision: **an email or phone number is not an identity, it is a *handle* pointing at one.**

```ts
// Global person. One row per human, forever.
export const user = pgTable("user", {
  id:                 text("id").primaryKey(),          // "usr_9988" — immutable, never reused
  name:               text("name").notNull(),
  image:              text("image"),
  salesforceContactId:text("salesforce_contact_id").unique(),  // 003... Contact, never 00Q Lead
  status:             text("status").notNull().default("active"), // active|invited|suspended|merged
  mergedIntoUserId:   text("merged_into_user_id"),      // set when this row was merged away
  createdAt:          timestamp("created_at").notNull(),
  updatedAt:          timestamp("updated_at").notNull(),
});

// Every email and phone number the person can be reached at or log in with.
export const userIdentity = pgTable("user_identity", {
  id:         text("id").primaryKey(),
  userId:     text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  type:       text("type").notNull(),        // 'email' | 'phone'
  value:      text("value").notNull(),       // normalised: email lowercased, phone E.164
  isPrimary:  boolean("is_primary").notNull().default(false),
  isVerified: boolean("is_verified").notNull().default(false),
  source:     text("source").notNull(),      // 'lms' | 'miles_one' | 'masterclass' | 'salesforce' | 'self'
  verifiedAt: timestamp("verified_at"),
  createdAt:  timestamp("created_at").notNull(),
}, (t) => [
  unique("uq_identity_value").on(t.type, t.value),          // globally unique handle
  uniqueIndex("uq_primary_per_type")
    .on(t.userId, t.type).where(sql`is_primary = true`),     // exactly one primary per type
]);
```

**Hard security rule:** only `isVerified = true` identities may be used to authenticate or to receive an OTP. An unverified alias that can log in is an account-takeover vector — anyone could claim `ceo@miles.com` as an alias and log in as them.

### 3.2 Product access — relational, not JSONB

The Google AI-mode sketch used a `jsonb` access matrix. Use a table instead: you will need to query "all Masterclass vendors", audit grant/revoke, and let admins manage this in a UI. JSONB makes all three painful.

```ts
export const userProductAccess = pgTable("user_product_access", {
  id:        text("id").primaryKey(),
  userId:    text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull(),   // 'lms' | 'miles_one' | 'masterclass'
  role:      text("role").notNull(),         // CPA|CMA|CAIRA|ADMIN|NORMAL|VENDOR|VENDOR_ADMIN
  vendorId:  text("vendor_id"),              // set only for VENDOR* roles
  status:    text("status").notNull().default("active"),
  grantedBy: text("granted_by"),
  grantedAt: timestamp("granted_at").notNull(),
  revokedAt: timestamp("revoked_at"),
}, (t) => [unique().on(t.userId, t.productId, t.role)]);
```

Plus a `vendor` table (id, name, sso_provider_id, allowed_email_domains, status) and an `identity_merge_log` for audit.

### 3.3 Token claims

Access token, RS256, verifiable at `/api/auth/jwks`:

```json
{
  "iss": "https://id.miles.com",
  "sub": "usr_9988",
  "aud": "masterclass-api",
  "email": "primary@example.com",
  "email_verified": true,
  "products": { "lms": ["CMA"], "masterclass": ["VENDOR"] },
  "vendor_id": "vnd_04",
  "amr": ["otp"],
  "exp": 1900000000
}
```

Keep it small. Do not put the full alias list in the token — expose it at `/userinfo` for the profile screen only.

**Note on roles in the token.** Embedding the `products` role map in the JWT is common and fine at your scale, but it is the part you will outgrow first: claims go stale within the token window, and the payload grows as products multiply. The direction of travel is coarse scopes in the token plus externalised authorization at the resource server — which is exactly what **§5** specifies. Design the resource-server middleware so authorization decisions are made in one swappable place per product, rather than read directly off claims at every endpoint.

### 3.4 Token statefulness and revocation

Three layers, with different answers. This is a deliberate design choice, not an accident of the framework.

| Layer | Stateful? | Revocation |
|---|---|---|
| IdP session cookie (browser ↔ Miles Identity) | **Stateful** — row in `session`, cached in Redis | Delete the row → instant |
| Access token (products' APIs) | **Stateless by choice** — see below | Not until `exp` |
| Refresh token | **Stateful** — stored, rotated on every use | RFC 7009 revoke → instant |

`oauth-provider` chooses the access-token format by whether the client sends a `resource` parameter:

- **With `resource`** → signed JWT. Django and Node verify locally against JWKS. No DB hit, no call back to Miles Identity.
- **Without `resource`** → opaque string. The resource server must call `/oauth2/introspect` per request; revocation deletes the row immediately.

**Decision: JWT-only. Deny opaque tokens at the product APIs.** Three backends introspecting on every call would make Miles Identity a latency bottleneck and a DOS target for the whole estate — and introspection requires a `client_secret`, which the Flutter and Angular clients cannot hold. (Introspection bearer-token and private-key-JWT auth methods are also not yet implemented in the plugin.) This matches the plugin's own recommendation.

**The cost is a revocation window.** `accessTokenExpiresIn` defaults to **1 hour** — override it to **5–15 minutes**. Per-scope shorter expiries are supported; use them for privileged scopes. Three events in this plan need explicit handling:

| Event | Behaviour | Handling |
|---|---|---|
| Admin bans a user | Existing access token valid until `exp` | Delete IdP session + revoke refresh tokens → out at next refresh |
| Identity merge fires | Tokens carrying the merged-away `sub` stay valid | Revoke both users' refresh tokens as step 7 of the merge procedure (§8) |
| Vendor SSO provider disabled | Blocks new logins immediately | Existing vendor tokens drain over the window |

If a window is unacceptable for privileged operations, go hybrid rather than global: **stateless JWT for normal reads, introspection only on admin / payment / data-export endpoints.** Alternative middle ground — a Redis deny-list of revoked `sub` values replicated to each product's middleware, checked in memory with no round-trip to Miles Identity.

**Do not enable `pairwiseSecret`.** Pairwise subject identifiers give each client a different `sub` for the same person. That directly breaks the premise that every product resolves to the same `usr_9988`, which is the whole point of the alias model. Public subject type only.

---

## 4. Authentication flows

### 4.1 Alias-aware login

```
User types any handle: work@x.com | old@gmail.com | +919999988888
        │
        ▼
POST /auth/resolve-identity   { handle }
        │  normalise → lookup user_identity (verified only)
        ├── no match ──────────► generic "check your details" + rate limit
        │                        (never reveal whether a handle exists)
        └── match → usr_9988
                │
                ▼
   Offer methods actually available to usr_9988:
   password · email OTP to that handle · SMS OTP to that handle
                │
                ▼
   Better Auth issues ONE session for usr_9988
   (OTP goes to the handle the user typed; the session is always the global user)
```

The lookup endpoint must be rate-limited per IP **and** per handle, and must return an identical response shape for hit and miss. Otherwise it becomes a user-enumeration oracle for your entire user base.

### 4.2 Internal SSO — web (Angular 17 and 22)

Standard OIDC authorization code + PKCE against `https://id.miles.com`. Because the Miles Identity session cookie lives on the IdP's own domain, silent re-authentication works **regardless of whether products share a parent domain** — the browser is doing a first-party redirect, not a third-party cookie read.

```
LMS (no token) → 302 /authorize?client_id=lms&code_challenge=…
    │
    ├─ IdP session cookie present → skipConsent (trusted client) → 302 back with code
    └─ absent → login UI → … → 302 back with code
    │
    ▼
LMS exchanges code + verifier → access + refresh token
```

Two decisions here:

- **Register LMS / Miles One / Masterclass as `trustedClients` with `skipConsent: true`.** These are first-party; a consent screen between your own products is friction with no benefit. Vendor and any future third-party clients keep consent on.
- **Prefer a BFF (backend-for-frontend) over browser-held tokens.** Have the Angular app's own backend hold the refresh token and set an `HttpOnly` session cookie. Tokens in `localStorage` are readable by any XSS on the page, and silent-renew-via-iframe is unreliable now that browsers block third-party cookies. If you must go SPA-direct, use `angular-oauth2-oidc` with in-memory storage and refresh-token rotation.

### 4.3 Internal SSO — mobile (Flutter, Miles One and Masterclass)

Authorization code + PKCE with `flutter_appauth`.

**Use the system browser** — `ASWebAuthenticationSession` on iOS, Chrome Custom Tabs on Android. Do **not** use an embedded `InAppWebView`: an embedded webview has its own cookie jar, so it defeats SSO between your two Flutter apps, and Google and Microsoft both refuse OAuth in embedded webviews (you would break social and vendor Azure login).

Redirect to a claimed scheme (`com.miles.one://oauth/callback`), store the refresh token in the platform keychain/keystore, rotate on every use.

### 4.4 Inbound vendor SSO (Masterclass)

Miles Identity is the *service provider* for the vendor's IdP and the *identity provider* for Masterclass:

```
Vendor user → masterclass.miles.com
    → id.miles.com/authorize?client_id=masterclass&login_hint=user@vendorco.com
    → Miles Identity matches vendorco.com to a registered SSO provider
    → SAML AuthnRequest / OIDC redirect to the vendor IdP
    → assertion returns; attributes mapped (email, first, last, groups)
    → JIT provision: create user + verified email identity
                     + user_product_access(masterclass, VENDOR, vendor_id)
    → 302 back to Masterclass with code
```

Guardrails:

- **Domain claim verification.** A vendor must prove control of `vendorco.com` (DNS TXT) before their IdP can assert identities for that domain. Otherwise vendor A can assert vendor B's users — or yours.
- **Never auto-link a federated login to an existing password account by email alone.** Require an explicit verified link step, or you have created a takeover path.
- Restrict JIT-provisioned users to Masterclass only. A vendor IdP must not be able to mint LMS access.
- Store one `ssoProvider` row per vendor, disable-able independently.

### 4.5 Salesforce provisioning

The AI-mode guidance here is correct and worth keeping: **do not create auth accounts on Lead creation.** Leads are 40–60% junk; you would flood the identity store with dead rows and give attackers an email-bombing surface.

```
Lead created ──────────► stays in Salesforce only. No Miles Identity record.
Lead converted (IsConverted = true)
   → Record-Triggered Flow → HTTP callout (signed, allowlisted IP)
   → POST /internal/provision { contactId, email, phone, firstName, products[] }
   → Miles Identity: resolve-or-create user, attach identities (unverified),
                     status = 'invited', grant product access
   → send activation link (single-use, 72h TTL)
   → respond { userId } → Flow writes it to Contact.Internal_User_ID__c
```

- Link on **Contact ID (003…)**, never Lead ID (00Q…) — the ID changes on conversion.
- Idempotency key on `contactId` so retried callouts don't duplicate.
- Direct self-signup and vendor JIT also create users; Salesforce is *a* source, not *the* source. Reverse-sync new signups to Salesforce as Contacts via `jsforce`.
- Admin and Vendor users never come from Salesforce — provision them through the Miles Identity admin UI.

---

## 5. Authorization — the user access module

Authentication answers *who is this*. This section answers *what may they touch*. Keep the two separated: Miles Identity owns identity and coarse product access; resource-level decisions live next to the data.

### 5.1 Which model — RBAC, ABAC or graph?

Your two answers decide this:

- Entitlements are **mixed** — packages, individual course grants, cohorts, promos, admin overrides. Several independent paths can grant access to the same course.
- **Vendor admins manage their own staff** — delegation exists inside a vendor.

Scored against your actual requirements:

| Requirement | RBAC | ABAC | Graph (ReBAC) |
|---|---|---|---|
| Can this user open Masterclass at all? | ✅ ideal | ⚠️ overkill | ⚠️ overkill |
| Is this user an Admin? | ✅ ideal | ⚠️ | ⚠️ |
| Learner sees only enrolled courses | ❌ role explosion | ⚠️ per-object policy | ✅ natural |
| Access via package **or** direct grant **or** cohort | ❌ | ⚠️ policy per path | ✅ union of relations |
| Vendor user sees only that vendor's content | ❌ needs scope hack | ⚠️ | ✅ natural |
| Vendor admin grants roles to own staff | ❌ | ❌ | ✅ natural |
| Enrolment valid until a date / subscription active | ❌ | ✅ ideal | ✅ via conditions |
| **"List every course this user can see"** (the LMS home screen) | ❌ | ❌ **hard blocker** | ✅ `ListObjects` |

Two findings matter more than the rest:

**Pure RBAC breaks on object-level access.** The moment permission depends on *which* course, RBAC needs a role per course. At 200K learners that is role explosion, and it is the classic reason teams abandon RBAC-only.

**Pure ABAC cannot enumerate.** Policy engines answer one question at a time: "can Anne view course 42?" They are poor at the reverse query — "list all courses Anne can view" — because there is no reverse index. That query *is* your course catalogue and your Masterclass library screen. This is the decisive argument, and it is easy to miss until the first catalogue page is built on it.

### 5.2 Recommendation: layered, with graph as the resource layer

Not one model — three layers, each doing what it is good at.

```
┌──────────────────────────────────────────────────────────────────────┐
│ LAYER 1 · RBAC  — coarse, in the access token                        │
│   "Can this user open Masterclass? Are they an Admin?"               │
│   Source: user_product_access (§3.2). ~80% of all checks.            │
│   Cost: zero — already in the JWT claims.                            │
└──────────────────────────────────────────────────────────────────────┘
                              │  passes the gate
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ LAYER 2 · GRAPH (ReBAC) — resource-level, per request                │
│   "May this user view course 42? Which courses may they view?"       │
│   Handles: package→course, direct grants, cohorts, vendor ownership, │
│            vendor-admin delegation. Union of paths, natively.        │
│   Engine: OpenFGA. Answers Check + ListObjects.                      │
└──────────────────────────────────────────────────────────────────────┘
                              │  relation found
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ LAYER 3 · ABAC — conditions ON the graph edges, not a separate engine│
│   "…and is the enrolment still in its validity window?"              │
│   "…and is the subscription active? …is the content published?"      │
└──────────────────────────────────────────────────────────────────────┘
```

**Do not build a separate ABAC/policy engine.** OpenFGA's *Conditions* feature expresses ABAC directly on relationship tuples using CEL, and — critically — conditions are honoured by `ListObjects` as well as `Check`, so a time-expired enrolment simply drops out of the catalogue. A validity window becomes:

```
type course
  relations
    define viewer: [user with active_enrolment] or member from owning_package
                     or member from cohort or viewer from vendor

condition active_enrolment(current_time: timestamp, valid_from: timestamp, valid_until: timestamp) {
  current_time >= valid_from && current_time < valid_until
}
```

That single model line is your mixed-entitlement requirement: *direct grant* **or** *package membership* **or** *cohort* **or** *vendor ownership*, with the time condition applied. In RBAC that is four role families; in ABAC it is four policies that still cannot list.

### 5.3 Engine choice

| | OpenFGA | SpiceDB | Permify |
|---|---|---|---|
| Origin / licence | Auth0/Okta → CNCF, Apache-2 | Authzed, OSS + managed | OSS |
| **Python + Node SDKs** | **Both, first-party** | Go-centric, others thinner | Both |
| ABAC conditions | Yes (CEL) | Caveats | Attribute extension |
| Enumeration | `Check` / `ListObjects` / `ListUsers` | `LookupResources` | `lookup` |

**Recommend OpenFGA.** The deciding factor is your polyglot estate: first-party SDKs for **both Node (LMS) and Python (two Django apps)** means one authorization model with no hand-rolled client. CNCF governance and Apache-2 also avoid re-running the certification conversation from §10.3.

### 5.4 The model sketch

```
type user
type vendor
  relations
    define admin: [user]                       # vendor admin manages own staff
    define staff: [user] or admin
type package
  relations
    define subscriber: [user with active_subscription]
type cohort
  relations
    define member: [user with active_enrolment]
type course
  relations
    define owning_vendor: [vendor]
    define in_package:    [package]
    define in_cohort:     [cohort]
    define viewer: [user with active_enrolment]      # direct / promo / admin override
                   or subscriber from in_package     # package path
                   or member from in_cohort          # batch path
                   or staff from owning_vendor       # vendor path
    define editor: admin from owning_vendor
```

Vendor isolation, mixed entitlement and delegation all fall out of that one `viewer` definition. Add `type chapter` with `parent: [course]` when you need chapter-level granularity — one line, no re-architecture.

### 5.5 Non-negotiable operating rules

1. **Never put fine-grained permissions in the JWT.** Coarse roles only (§3.3). Resource decisions are made at request time against the graph. Tokens carrying course lists would bloat and go stale.
2. **The graph is not on the login path.** Miles Identity must not call OpenFGA during authentication. Authorization is per-resource-request; keeping them separate stops an authz outage from becoming a login outage.
3. **Tuple sync is the real operational risk.** Enrolment created in LMS Postgres → tuple must appear in OpenFGA. A naive dual write will drift. Use a **transactional outbox**: write the domain row and an outbox event in one transaction, then a worker writes the tuple. Plus a nightly reconciliation job that diffs product data against tuples and reports orphans. This is the single most common failure mode in Zanzibar-style deployments.
4. **One store, typed objects — not one store per product.** Vendor → course → learner traversal crosses product boundaries. Namespacing inside a single model preserves that.
5. **Use `ListObjects` for pages, never N × `Check`.** A catalogue page doing 200 individual checks will be slow and will hammer the service. Fetch the permitted set once, then filter.
6. **Every product keeps one swappable authorization module.** One `can()` / permission-service entry point per codebase — never `if (user.role === 'ADMIN')` scattered through controllers. This is what makes the RBAC → graph migration a change in one file per product.
7. **Deny by default, and test the model.** OpenFGA model tests run in CI. A negative test per relation: vendor A cannot read vendor B's course; an expired learner cannot read a course they finished paying for.

### 5.6 Phasing — do not build all three layers at once

| When | What | Why |
|---|---|---|
| **Phase 1** (with the IdP) | Layer 1 RBAC only — `user_product_access`, roles in claims, one authorization module per product | Unblocks SSO. Sufficient for product gating and admin panels. |
| **Phase 5–6** (LMS + Miles One) | Stand up OpenFGA, model courses/packages/cohorts/vendors, backfill tuples, run **shadow mode** — graph decides, RBAC still enforces, log disagreements | Catches model errors with zero user impact. Do not skip shadow mode. |
| **Post-cutover** | Flip enforcement to graph, add conditions (Layer 3), then chapter-level granularity if needed | Incremental, reversible. |

Backfilling tuples for 300K+ users × their entitlements is a batch job of the same character as the identity dedup in §8 — plan it the same way, with reconciliation counts before enforcement flips.

---

## 6. What moves and what stays

| Moves to Miles Identity | Stays in product DBs |
|---|---|
| Password hashes and salts | Course progress, quiz scores, certificates (LMS) |
| All emails and phone numbers (alias table) | Class schedules, watch state, vendor content (Masterclass) |
| Social provider connections | Device tokens, push prefs, app state (Miles One) |
| Vendor SSO configuration | Product-specific profile fields |
| Sessions, refresh tokens, MFA enrolments | Leads, opportunities, activity (Salesforce) |
| Product access matrix + roles | Nothing that answers "who is this person" |

### The safe way to re-key product tables

The AI-mode plan suggested rewriting each product's user primary key to the new global ID. **Don't.** Rewriting a PK means cascading every FK across three schemas — high risk, hard to roll back, and it breaks any external reference or report.

Instead, keep local PKs and add a mapped column:

```sql
-- LMS, Miles One, Masterclass — same pattern in each
ALTER TABLE users ADD COLUMN identity_user_id VARCHAR(64);
CREATE UNIQUE INDEX uq_users_identity ON users(identity_user_id);
-- backfill from the mapping table, then:
ALTER TABLE users ALTER COLUMN identity_user_id SET NOT NULL;
```

Then, once all traffic resolves via `identity_user_id`:

```sql
ALTER TABLE users DROP COLUMN password, DROP COLUMN last_login_ip;  -- etc.
```

For Django, swap `AbstractUser` for a plain profile model keyed by `identity_user_id`. Expect a real migration here — `AUTH_USER_MODEL` changes are invasive. Budget for it explicitly in both Django apps.

---

## 7. Password migration — bulk import, not runtime proxying

The AI-mode suggestion was to have Miles Identity call the legacy databases at login time to check passwords. That works, but it keeps three legacy auth paths alive indefinitely and creates an internal endpoint that verifies arbitrary credentials. There is a cleaner route.

**Django and Node hashes are both verifiable in TypeScript.** Django's default is `pbkdf2_sha256$<iterations>$<salt>$<hash>`, reproducible with `crypto.pbkdf2`. Node/LMS is almost certainly bcrypt. So: **import the hash strings** and override Better Auth's verifier with a format dispatcher.

```ts
emailAndPassword: {
  enabled: true,
  password: {
    hash: async (pw) => await argon2id(pw),          // all NEW passwords use argon2id
    verify: async ({ hash, password }) => {
      if (hash.startsWith("pbkdf2_sha256$")) return verifyDjangoPbkdf2(password, hash);
      if (/^\$2[aby]\$/.test(hash))          return bcrypt.compare(password, hash);
      if (hash.startsWith("$argon2"))        return argon2Verify(hash, password);
      return false;
    },
  },
},
```

Then **rehash to argon2id on the next successful login** (`after` hook on sign-in). Legacy formats drain naturally; you can report on the remaining tail and force-reset the stragglers at cutoff.

Store the legacy format in an `imported_hash_algo` column so you can measure the drain. Verify every branch against real production hashes in staging before cutover — there are known reports of hash-verification failures after Better Auth migrations, so treat this as a tested path, not an assumed one.

---

## 8. Identity deduplication — the actual hard part

Run this **before** any SSO goes live. Output is a reviewed mapping table, not an automatic merge.

### Pass 1 — extract and normalise

Pull every user row from LMS, Miles One, Masterclass and Salesforce Contacts into a staging table. Normalise: emails lowercased and trimmed; phones to E.164 (assume `+91` where bare 10-digit Indian numbers appear — validate this assumption against a sample first).

### Pass 2 — deterministic matching, tiered by confidence

| Tier | Rule | Action |
|---|---|---|
| A | Same `salesforce_contact_id` | Auto-merge |
| B | Identical verified email | Auto-merge |
| C | Identical E.164 phone **and** same name (fuzzy ≥ 0.9) | Auto-merge |
| D | Identical phone, different name | **Manual review queue** |
| E | Same name + same institution, no shared handle | **Manual review queue** |

Tier D is the trap: shared family or office numbers are common, and auto-merging two different people into one account is a data breach that is very hard to unwind. Never auto-merge on phone alone.

### Pass 3 — merge, reversibly

```
1. Pick surviving user (oldest verified account, or Salesforce-linked)
2. Move all identities to survivor; first verified handle per type → is_primary
3. Union product access (widest role wins, log the widening)
4. Write identity_merge_log { survivorId, mergedId, tier, evidence, actor, ts }
5. Loser row: status='merged', merged_into_user_id=survivorId  — DO NOT DELETE
6. Update product DB identity_user_id → survivorId
7. Revoke BOTH users' sessions and refresh tokens (§3.4) — otherwise tokens
   carrying the merged-away `sub` stay live for the access-token window
```

Keeping the merged row means a stale reference resolves to the survivor instead of 404-ing, and merges stay reversible for the inevitable "you merged the wrong two people" ticket.

### Pass 4 — lazy consolidation at login

For handles missed by the batch (unverified, or not present in any source):

```
User logs in with an unrecognised handle
   → does it match an existing user by any other signal?
   → "We found an existing Miles account. Verify with an OTP to link them."
   → OTP to the ALREADY-VERIFIED handle on the existing account  ← critical
   → on success: attach new handle as verified alias
```

Send the confirmation OTP to the **existing verified** handle, not the new one. Sending it to the new handle lets an attacker attach their own address to your account.

---

## 9. Phased rollout

Sequenced so that user-facing risk arrives last, and each phase is independently valuable.

### Phase 0 — Discovery (1–2 weeks)

Answer, in writing:

- Exact hash algorithm and parameters in each of the three products
- Row counts, and how many rows have a verified email vs verified phone vs neither
- Domain strategy: subdomains of `miles.com` or separate TLDs (§11)
- SMS gateway (Gupshup / Twilio / MSG91) and transactional email provider, with throughput headroom for a login-storm
- Full list of OAuth apps, redirect URIs and social providers currently configured
- Which vendors want SSO, with which IdP, and how many are expected in 12 months
- Staging environments with production-shaped data for all three products

**Deliverable:** decision record + dedup dry-run report showing estimated duplicate count.

### Phase 1 — Build Miles Identity (3–4 weeks)

Bun + Better Auth + Postgres + Redis. `oauth-provider` + `jwt` + `emailOTP` + `phoneNumber` + `twoFactor` + `admin` + `sso`. Alias schema, resolve-identity endpoint, multi-format password verifier, hosted login UI (themed per `client_id`), admin console for users/access/vendors. **Layer 1 RBAC only — no graph engine yet (§5.6).** No production traffic.

**Exit:** the **official OpenID Foundation conformance suite** passes (see §10.3 — this gate is load-bearing because Better Auth is not certified); JWKS rotation tested; a scripted PKCE flow works end to end; opaque tokens rejected at every resource server.

### Phase 2 — Identity consolidation (2–3 weeks, overlaps Phase 1)

Run the dedup passes into staging. Work the manual review queue. Load hashes. Backfill `identity_user_id` in all three product DBs. Reconcile counts per product and per handle type.

**Exit:** every product user row has an `identity_user_id`; review queue empty; duplicate rate measured and signed off.

### Phase 3 — Pilot: Masterclass web (2 weeks)

Smallest, newest, most SSO-motivated. Angular 22 → OIDC via BFF. Django Masterclass becomes a resource server validating JWTs against JWKS (`PyJWT` + cached JWKS, or `django-oauth-toolkit`). Legacy Django login stays behind a feature flag.

**Exit:** ≥99% login success for a week; p95 auth latency within budget; rollback exercised at least once.

### Phase 4 — Vendor SSO (2 weeks)

One friendly vendor first. DNS domain verification, SAML metadata exchange, attribute mapping, JIT provisioning scoped to Masterclass. Then document a repeatable onboarding runbook.

**Exit:** vendor user logs in with zero Miles credentials; access confined to Masterclass; disabling the provider immediately blocks new logins.

### Phase 5 — LMS + Miles One (3–4 weeks)

LMS Angular 17 + Node (jose/JWKS middleware). Miles One Flutter + Django — the `AUTH_USER_MODEL` change lands here, so allow slack. At the end of this phase, **internal cross-product auto-login is live**: a user on LMS lands in Masterclass without re-entering credentials.

In parallel: stand up OpenFGA, author the model from §5.4, backfill tuples, and run **shadow mode** — the graph decides, RBAC still enforces, disagreements logged and reviewed.

**Exit:** SSO demonstrated across all three products in one browser session and across both Flutter apps; shadow-mode disagreement rate at zero for a week; catalogue pages within their latency budget using `ListObjects`.

### Phase 6 — Salesforce integration (1–2 weeks)

Lead-conversion Flow → provisioning callout. `Internal_User_ID__c` back-reference. Reverse sync of self-signups. Backfill `salesforce_contact_id` on existing matched users.

### Phase 7 — Legacy cutoff (30–60 days after Phase 5)

Remove legacy login routes, drop password columns, delete legacy session tables. Force-reset the remaining un-rehashed tail. Retire feature flags.

**Total: ~14–18 weeks** for a small dedicated team, assuming Phase 0 answers arrive quickly. The two Django `AUTH_USER_MODEL` migrations and the manual dedup review are the most likely sources of slippage.

---

## 10. Standards conformance, and build vs buy

### 10.1 What in this plan is industry standard

Every protocol-level choice here is the mainstream pattern, not a house style. Google, Okta, Entra ID and Auth0 all work this way:

| Choice | Specification it implements |
|---|---|
| Central authorization server, products as resource servers | OAuth 2.0 (RFC 6749) + OpenID Connect Core 1.0 |
| Authorization code + PKCE for every client | OAuth 2.1; mandatory for SPAs and native apps |
| System browser for Flutter, never an embedded webview | RFC 8252 (OAuth for Native Apps) |
| JWT access tokens verified via JWKS | RFC 9068 (JWT Profile for OAuth 2.0 Access Tokens) |
| Short access token + rotating refresh token | RFC 9700 (OAuth 2.0 Security Best Current Practice) |
| BFF for browser apps rather than tokens in JS | Current BCP recommendation for browser-based apps |
| `iss` in the authorization response | RFC 9207 (mix-up attack defence) |
| Token revocation / introspection endpoints | RFC 7009 / RFC 7662 |
| Vendor SAML 2.0 + OIDC federation with JIT provisioning | Standard B2B SaaS pattern (SCIM is the mature sibling for full lifecycle) |

### 10.2 What is *not* a protocol standard

- **The alias model.** No specification defines "one person, many verified handles" — OIDC has no such concept. It is, however, a well-recognised CIAM feature implemented above the protocol: Auth0 calls it Account Linking, Okta and Keycloak both have equivalents. The tiered-confidence dedup in §8 is bespoke, but that is forced by your data, not chosen.
- **Roles embedded in access-token claims.** Common and workable, but see the note in §3.3 — externalised authorization is where this goes next.

### 10.3 Build vs buy — decide this in Phase 0

The protocol choices above are standard. **Implementing the authorization server yourself is not** — it is the road less travelled. Most organisations at 300–500K users deploy a certified implementation (Keycloak, Ory Hydra, Entra, Okta) rather than run their own.

**Certification is the concrete gap.** The OpenID Foundation runs a formal conformance programme. Ory Hydra and Keycloak appear on the certified implementations list; **Better Auth does not appear on it**, and `oauth-provider` is new enough that this is unlikely to change soon. Two consequences to plan for:

1. The OIDC conformance suite as the **Phase 1 exit gate is load-bearing**, not a formality. Run the official test suite, not just your own happy-path scripts.
2. **Vendor security reviews may ask for a certification you cannot produce.** If your target vendors are large regulated enterprises, raise this in Phase 0 rather than discovering it during a vendor's procurement process.

The Better Auth path remains sound, and `oauth-provider` is the right current piece for it. But be clear-eyed about what you are taking on, because the honest comparison matters more here than in a single-app deployment.

**What you are building yourself:** hosted login UI, admin console, vendor SSO self-service onboarding, SAML metadata management, audit logging, token introspection surface, and the operational maturity to keep a four-product SPOF up.

**What a dedicated IdP gives you off the shelf:** Keycloak, Zitadel, Logto and Ory all ship SAML self-service, admin UIs, audit logs and battle-tested OIDC conformance. Keycloak and Zitadel are self-hostable and free.

| Factor | Better Auth | Keycloak / Zitadel / Hydra | Auth0 / Okta / WorkOS |
|---|---|---|---|
| Licence cost at 400K users | Free (self-host) | Free (self-host) | Significant, MAU-metered |
| **OIDC certified** | **No** | **Yes** | Yes |
| Vendor SAML self-service | Enterprise tier / build it | Included | Included |
| Admin console + audit logs | Build it | Included | Included |
| Alias model as designed here | Native — it's your schema | Fights the built-in model | Hard or impossible |
| Ops burden | Highest | High | Lowest |
| Team fit (TS-heavy) | Best | Java / Go operational skills | N/A |

**The tiebreaker is the alias system.** A custom identity-resolution model with tiered merge confidence and a review queue is exactly the thing packaged IdPs make painful, and it is your highest-value requirement. That argues for Better Auth — but if vendor count is heading past ~20 and you need each vendor's admin to self-configure their own SAML, price the Better Auth enterprise tier against Zitadel before committing.

---

## 11. Open decisions

| # | Decision | Why it matters |
|---|---|---|
| 1 | Subdomains of `miles.com`, or separate TLDs? | Doesn't affect OIDC SSO (first-party redirect), but does affect cookie strategy for the BFF, CSRF config, and CORS. Subdomains are simpler. |
| 2 | BFF or SPA-direct token handling? | BFF is materially more secure. Costs a thin backend per Angular app. Recommend BFF. |
| 3 | Integer PKs or UUIDs in existing product user tables? | Determines the shape of the `identity_user_id` backfill and whether reports break. |
| 4 | Can users self-manage aliases in profile settings? | If yes, needs OTP verification per added handle plus an admin override path. Recommend yes, verified-only. |
| 5 | Is 2FA mandatory, and for whom? | Recommend mandatory for Admin and Vendor-admin, optional for learners. |
| 6 | SMS gateway and cost per OTP | Phone-OTP-first login at 300K+ users has a real recurring cost. Model it. |
| 7 | Real-time or nightly Salesforce sync? | Real-time on provisioning (must be), nightly is fine for profile drift. |
| 8 | Retention on merged user rows | Recommend indefinite for audit; confirm against your DPDP Act obligations. |
| 9 | Access-token TTL, and is a revocation window acceptable? | Default is 1 hour — too long. Recommend 5–15 min, with introspection only on privileged endpoints (§3.4). |
| 10 | Do your target vendors require an OIDC-certified IdP? | Better Auth is not certified (§10.3). Ask your two largest prospective vendors before Phase 1, not during their procurement review. |
| 11 | Is chapter-level access control needed, or is course-level enough? | Decides whether `type chapter` enters the model in Phase 5 or later. One line either way, but it multiplies tuple count. |
| 12 | Who owns the authorization model — one team, or per product? | Recommend one owner for the shared model, PRs from product teams. Three teams editing one graph independently goes wrong fast. |
| 13 | Managed OpenFGA (Okta FGA) or self-hosted? | Self-hosting adds another stateful service to operate. Weigh against the ops load already added by Miles Identity. |

---

## 12. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Wrong merge — two people become one account | **Critical** | Never auto-merge on phone alone; tiered confidence; manual queue for D/E; reversible merges; `identity_merge_log` |
| Miles Identity outage takes down all four products | **Critical** | Multi-instance + LB, Redis session cache, independent monitoring, documented degraded mode |
| Vendor IdP asserts identities it doesn't own | **Critical** | DNS domain verification before activation; JIT scoped to Masterclass only; no auto-link to existing accounts by email |
| `resolve-identity` becomes a user-enumeration oracle | High | Identical responses for hit/miss; rate limit per IP and per handle; alert on scan patterns |
| Password hash import verification fails | High | Test every hash branch against real production hashes in staging; measure rehash drain; keep force-reset as fallback |
| Django `AUTH_USER_MODEL` migration overruns | High | Treat as its own workstream in Phase 5; rehearse on a staging clone |
| Login storm exceeds SMS/email throughput at cutover | Medium | Provider headroom agreed in Phase 0; phase by product; off-peak cutover |
| `oauth-provider` gaps found late | Medium | Official OIDC conformance suite as the Phase 1 exit gate, not an afterthought |
| Banned or merged user keeps access for the token window | Medium | 5–15 min access-token TTL; revoke sessions + refresh tokens on ban and on merge; introspect on privileged endpoints (§3.4) |
| Vendor procurement blocks on lack of OIDC certification | Medium | Confirm with your two largest prospective vendors in Phase 0; keep Zitadel/Hydra as a costed fallback |
| Tokens exfiltrated via XSS in Angular apps | Medium | BFF pattern; 15-min access tokens; refresh rotation; strict CSP |
| Scope creep into a full CIAM product | Medium | Freeze scope at: authn, alias resolution, product access, vendor federation, authorization model. Billing and pricing stay in the products. |
| Authorization tuples drift out of sync with product data | **High** | Transactional outbox, never dual write; nightly reconciliation job; shadow mode before enforcement (§5.5, §5.6) |
| Authz service outage blocks all content access | High | Keep it off the login path (§5.5); cache `ListObjects` results per page; define a documented degraded mode |
| Catalogue pages built on N × `Check` become slow | Medium | Mandate `ListObjects` for any list view; add a latency budget to the Phase 5 exit criteria |
| Wrong authorization model shipped to production | High | Model tests in CI with negative cases; shadow-mode disagreement log reviewed before flipping enforcement |

---

## 13. Summary

1. **Build Miles Identity** as a standalone Bun + Better Auth OAuth 2.1 / OIDC provider using `@better-auth/oauth-provider` and `jwt` — not the deprecated `oidcProvider`.
2. **Model identity as one global user with many verified aliases.** This is the core of the plan; everything else depends on it.
3. **Deduplicate before federating.** Tiered confidence, manual review for ambiguous matches, reversible merges.
4. **Products become resource servers** that verify JWTs via JWKS and hold zero credentials. Map to the global ID with a new indexed column — don't rewrite primary keys.
5. **Stateless JWT access tokens, stateful sessions and refresh tokens.** 5–15 minute TTL, rotation, revoke on ban and on merge. Introspection only on privileged endpoints. No pairwise `sub`.
6. **Import password hashes and dispatch on format**, rehashing to argon2id on next login, rather than proxying to legacy databases at runtime.
7. **Vendor SSO via the SSO plugin**, gated on DNS domain verification and scoped strictly to Masterclass.
8. **Salesforce provisions on Lead conversion only**, linked on Contact ID.
9. **Roll out Masterclass → vendor SSO → LMS → Miles One → Salesforce**, then cut off legacy auth after 30–60 days. Around 14–18 weeks.
10. **Authorization is layered, not one model** (§5): RBAC in the token for product gating, OpenFGA graph for resource-level access, ABAC as conditions on graph edges. Ship RBAC in Phase 1, graph in Phase 5 behind shadow mode.
11. **Every protocol choice here is industry standard** (§10.1). The non-standard decision is building the authorization server rather than deploying a certified one — justified by the alias requirement, but re-test it in Phase 0.

---

## Sources

- [OAuth Provider plugin — Better Auth](https://www.better-auth.com/docs/plugins/oauth-provider)
- [OIDC Provider plugin (deprecated) — Better Auth](https://www.better-auth.com/docs/plugins/oidc-provider)
- [Single Sign-On / SAML plugin — Better Auth](https://www.better-auth.com/docs/plugins/sso)
- [Phone Number plugin — Better Auth](https://better-auth.com/docs/plugins/phone-number)
- [Two-Factor Authentication — Better Auth](https://better-auth.com/docs/plugins/two-factor)
- [Migrating from Supabase Auth to Better Auth](https://better-auth.com/docs/guides/supabase-migration-guide)
- [Password hash error after migration — better-auth issue #4762](https://github.com/better-auth/better-auth/issues/4762)
- [OAuth 2.1 draft](https://oauth.net/2.1/)
- [RFC 9207 — OAuth 2.0 Authorization Server Issuer Identification](https://datatracker.ietf.org/doc/html/rfc9207)
- [RFC 8252 — OAuth 2.0 for Native Apps](https://datatracker.ietf.org/doc/html/rfc8252)
- [RFC 9068 — JWT Profile for OAuth 2.0 Access Tokens](https://datatracker.ietf.org/doc/html/rfc9068)
- [RFC 9700 — OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/rfc9700)
- [RFC 7009 — OAuth 2.0 Token Revocation](https://datatracker.ietf.org/doc/html/rfc7009)
- [RFC 7662 — OAuth 2.0 Token Introspection](https://datatracker.ietf.org/doc/html/rfc7662)
- [Certified OpenID Connect Implementations — OpenID Foundation](https://openid.net/developers/certified-openid-connect-implementations/)
- [Ory Hydra — OpenID Certified OAuth 2.1 / OIDC provider](https://github.com/ory/hydra)
- [OpenFGA — Conditions (ABAC on relationship tuples)](https://openfga.dev/docs/modeling/conditions)
- [OpenFGA — ListObjects API](https://openfga.dev/docs/getting-started/perform-list-objects)
- [OpenFGA — Roles and Permissions modelling](https://openfga.dev/docs/modeling/roles-and-permissions)
- [OpenFGA — Parent-Child Objects](https://openfga.dev/docs/modeling/parent-child)
- [RBAC vs ABAC vs ReBAC — CIAM Compass](https://guptadeepak.com/ciam-compass/guides/rbac-vs-abac-vs-rebac/)
- [OpenFGA vs Permify vs SpiceDB (2026)](https://www.pkgpulse.com/guides/openfga-vs-permify-vs-spicedb-zanzibar-authorization-2026)
- [Google Zanzibar paper](https://research.google/pubs/pub48190/)
