# Miles Identity

Centralised OAuth 2.1 / OIDC identity provider for the Miles estate. Bun-native.

One place that answers **who a person is**, **which handles identify them**, and **what they may touch** — for LMS, Miles One, Miles Masterclass, Salesforce, and federated Masterclass vendors.

---

## Why this exists

| Problem | What this fixes it with |
|---|---|
| The same human exists 2–3 times across three auth tables, keyed on different emails and phone numbers | **Alias identity model** — one global `usr_` id, many verified handles |
| A user authenticating to LMS must authenticate again for Masterclass | **OIDC SSO** — one session, every product |
| Masterclass vendors want their own IdP to log their people in | **Inbound SAML 2.0 / OIDC federation**, scoped to Masterclass |
| Access depends on packages, direct grants, cohorts, promos and vendor ownership | **Layered RBAC + OpenFGA graph + conditions** |

Identity resolution is the hard problem and is solved first. Federating three inconsistent user tables would only distribute the inconsistency.

## Stack

| Concern | Choice |
|---|---|
| Runtime, package manager, test runner, bundler | **Bun ≥ 1.3.14** |
| HTTP | `Bun.serve` native routes |
| Postgres (our queries) | `Bun.sql` |
| Postgres (Better Auth internals) | `pg` Pool — Kysely requirement, the one exception |
| Cache / sessions | `Bun.redis` |
| Password hashing | `Bun.password` — argon2id, verifies bcrypt too |
| Scheduled jobs | `Bun.cron` |
| Auth framework | `better-auth` 1.6.25 |
| OAuth/OIDC provider | `@better-auth/oauth-provider` + `jwt()` |
| Vendor SSO | `@better-auth/sso` |
| Authorization | `@openfga/sdk` |
| Validation | `zod` |
| Language | TypeScript 7, strict, no `any` |

**Bun-native is a hard rule.** If Bun ships a feature, we use it — no Express, no Drizzle, no bcrypt, no node-cron, no dotenv, no Jest. The full do/don't table is in [`AGENTS.md`](./AGENTS.md).

## Getting started

```bash
bun --version                 # expect 1.3.x — this project assumes ≥ 1.3.14
bun install

cp .env.example .env.local    # fill it in; Bun loads .env files automatically
openssl rand -base64 32       # → BETTER_AUTH_SECRET

# Two databases: one for development, one the test suite may create and drop
# schemas in. Pointing tests at your dev database works but leaves schema churn.
createdb miles_identity
createdb miles_identity_test

export DATABASE_URL="postgres://$(whoami)@localhost:5432/miles_identity"
export TEST_DATABASE_URL="postgres://$(whoami)@localhost:5432/miles_identity_test"

bun run db:migrate            # our tables
bun run db:seed               # dev fixtures (refuses to run in production)
bun run auth:migrate          # Better Auth's tables (review the SQL first)

bun run dev                   # bun --hot src/index.ts
```

Adjust the connection strings if your local Postgres role is not your username. Your role needs `CREATE` on the test database — owning it is enough, since schema creation is how the suite isolates each run.

### Checks

```bash
bun run verify                # typecheck + test — the everyday pair
bun run test:db               # just the database suites
bun run test:watch            # while developing
bun run check                 # verify + bun audit
```

`bun run check` currently **exits 1** on a known `@better-auth/oauth-provider` advisory — see the Known gaps section. Use `bun run verify` until that is resolved; no audit ignore has been added, deliberately.

## Layout

```
AGENTS.md              the contract — read before every task
.agents/skills/        reference material, named per task
prompts/               approved implementation plans, numbered
src/
  index.ts             Bun.serve entry — routes only
  auth.ts              the single betterAuth() instance
  routes/              thin handlers
  services/            business logic, testable without HTTP
  identity/            alias resolution, merge, dedup — the core domain
  authz/               OpenFGA model and wrappers
  db/                  Bun.sql queries, migrations, outbox worker
  integrations/        Salesforce, SMS, email
  jobs/                Bun.cron schedules
  lib/                 config, logging, errors, ids
tests/                 mirrors src/
docs/                  architecture plan and decision records
```

## How we build here — Vibe Engineering

Rules are written once and enforced everywhere. Prompts stay short. The AI writes the detailed plan; you review the plan, not the keystrokes.

```
short prompt  →  AI reads AGENTS.md + named skills  →  AI writes prompts/NNN-*.md
              →  YOU review & approve  →  AI implements  →  bun run check  →  you verify
```

Your everyday prompt looks like this:

```
Implement the alias resolution endpoint.
Use @.agents/skills/alias-identity and @.agents/skills/postgres-migrations.
```

One feature per prompt. Never write "read AGENTS.md" — it loads automatically. See [`prompts/README.md`](./prompts/README.md) for how to review a plan.

## Build order

Do not jump ahead. Full table in [`AGENTS.md`](./AGENTS.md#build-in-order-roadmap).

`config → database → Better Auth core → alias model → passwordless → OAuth provider → RBAC → first product (Masterclass) → legacy import → vendor SSO → graph authz → Salesforce → remaining products → automation → deploy & harden`

## Non-negotiables

These are security boundaries, not preferences:

1. **Only verified identities authenticate.** An unverified alias that can log in is account takeover.
2. **Alias-linking OTPs go to the already-verified handle**, never the newly claimed one.
3. `/api/identity/resolve` returns an **identical shape and timing** for hit and miss — it is a user-enumeration oracle otherwise.
4. **JWT access tokens only**, 5–15 min TTL. The library default is 3600s; always override.
5. **Revoke sessions and refresh tokens on every merge**, or a ghost identity keeps working.
6. **Never enable pairwise `sub`.** Every product must see the same id.
7. **Never auto-merge on phone alone.** Shared numbers are common; a wrong merge is a breach.
8. **Vendor SSO needs DNS domain verification** and stays scoped to Masterclass.
9. **Never dual-write OpenFGA tuples.** Transactional outbox, always.
10. **Shadow mode before graph enforcement.** No exceptions.

## Known gaps to track

- **`@better-auth/oauth-provider` advisory GHSA-p2fr-6hmx-4528** — access tokens for unauthorized audiences via unbound resource indicators. A direct dependency, unused until step 6, patched only in `1.7.0-rc`/`beta`. `bun run check` exits 1 on it until resolved. Decide at the start of step 6; see `prompts/001-config-skeleton.md`.
- **Better Auth is not OIDC-certified.** The official conformance suite is a real production gate, and a vendor security review may ask for a certification we cannot produce.
- **This service is a single point of failure for four products.** Minimum two instances, Redis session cache, independent uptime alerting.
- **`AUTH_USER_MODEL` migrations** in both Django apps are the most likely source of schedule slip.

## Docs

- [`AGENTS.md`](./AGENTS.md) — the contract: scope, architecture, stack, data model, security, standards
- [`.agents/skills/`](./.agents/skills/) — per-task reference material
- [`prompts/README.md`](./prompts/README.md) — the loop, and how to review a plan
- `docs/` — architecture plan and decision records
# miles-identity
