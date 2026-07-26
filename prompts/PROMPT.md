# Miles Identity — build-in-order prompt index
#
# One feature per prompt. The agent reads AGENTS.md automatically, then the named
# skills, then writes a plan to prompts/NNN-*.md and STOPS for approval.
#
# Any step that adds or changes an HTTP endpoint must also name
# @.agents/skills/scalar-api-docs — an undocumented endpoint is incomplete.

# ✅ 1 — done (prompts/001-config-skeleton.md)
Implement the config module and server skeleton.
Use @.agents/skills/bun-native and @.agents/skills/security.

# ✅ 2 — done (prompts/002-database-data-model.md)
Implement the database layer and data model.
Use @.agents/skills/postgres-migrations and @.agents/skills/alias-identity.

# ✅ 3 — Better Auth core  ← next. Also adds the deferred FKs to "user".
Implement the Better Auth core instance and its schema.
Use @.agents/skills/better-auth, @.agents/skills/postgres-migrations and @.agents/skills/security.

# ✅ 4 — Alias identity model. The core domain problem.
Implement the alias identity model and the resolve endpoint.
Use @.agents/skills/alias-identity and @.agents/skills/security.

# ✅ 5 — Passwordless
Implement email OTP and SMS OTP sign-in wired to the alias resolver.
Use @.agents/skills/better-auth and @.agents/skills/alias-identity.

# ✅ 6 — OAuth provider. Resolve the oauth-provider advisory before starting.
Implement the OAuth provider, JWKS and token claims.
Use @.agents/skills/better-auth and @.agents/skills/security.

# ✅ 7 — Dev OTP flag + Scalar API documentation
Implement the Dev OTP option based on a flag, and create the API documentation using Scalar.
Use @.agents/skills/scalar-api-docs, @.agents/skills/security and @.agents/skills/better-auth.

# ✅ 8 — RBAC (layer 1)
Implement product access RBAC and the admin grant/revoke endpoints.
Use @.agents/skills/security, @.agents/skills/postgres-migrations and @.agents/skills/scalar-api-docs.

# ✅ 9 — First product integration
Integrate Masterclass web as the first OIDC client, legacy login behind a flag.
Use @.agents/skills/better-auth and @.agents/skills/security.

# ✅ 10 — Legacy import and dedup
Implement the legacy hash import, dedup passes and the merge procedure.
Use @.agents/skills/alias-identity and @.agents/skills/postgres-migrations.

# 11 — Vendor SSO
Implement inbound vendor SSO with DNS domain verification and JIT provisioning.
Use @.agents/skills/better-auth, @.agents/skills/security and @.agents/skills/scalar-api-docs.

# 12 — Graph authorization (layer 2)
Implement the OpenFGA model, the outbox worker and shadow mode.
Use @.agents/skills/openfga-authz and @.agents/skills/postgres-migrations.

# 13 — Salesforce
Implement Salesforce provisioning on Lead conversion and the back-reference sync.
Use @.agents/skills/security, @.agents/skills/postgres-migrations and @.agents/skills/scalar-api-docs.

# 14 — Remaining products
Integrate the LMS and then Miles One as OIDC clients.
Use @.agents/skills/better-auth and @.agents/skills/security.

# 15 — Automation
Implement the Bun.cron reconciliation, token cleanup and drain-report jobs.
Use @.agents/skills/bun-native and @.agents/skills/testing-and-checks.

# 16 — Deploy and harden
Implement the deployment setup, Redis session cache and OIDC conformance run.
Use @.agents/skills/security and @.agents/skills/bun-native.