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

# 5 — Passwordless
Implement email OTP and SMS OTP sign-in wired to the alias resolver.
Use @.agents/skills/better-auth and @.agents/skills/alias-identity.

# 6 — OAuth provider. Resolve the oauth-provider advisory before starting.
Implement the OAuth provider, JWKS and token claims.
Use @.agents/skills/better-auth and @.agents/skills/security.

# 7 — RBAC (layer 1)
Implement product access RBAC and the admin grant/revoke endpoints.
Use @.agents/skills/security and @.agents/skills/postgres-migrations.

# 8 — First product integration
Integrate Masterclass web as the first OIDC client, legacy login behind a flag.
Use @.agents/skills/better-auth and @.agents/skills/security.

# 9 — Legacy import and dedup
Implement the legacy hash import, dedup passes and the merge procedure.
Use @.agents/skills/alias-identity and @.agents/skills/postgres-migrations.

# 10 — Vendor SSO
Implement inbound vendor SSO with DNS domain verification and JIT provisioning.
Use @.agents/skills/better-auth and @.agents/skills/security.

# 11 — Graph authorization (layer 2)
Implement the OpenFGA model, the outbox worker and shadow mode.
Use @.agents/skills/openfga-authz and @.agents/skills/postgres-migrations.

# 12 — Salesforce
Implement Salesforce provisioning on Lead conversion and the back-reference sync.
Use @.agents/skills/security and @.agents/skills/postgres-migrations.

# 13 — Remaining products
Integrate the LMS and then Miles One as OIDC clients.
Use @.agents/skills/better-auth and @.agents/skills/security.

# 14 — Automation
Implement the Bun.cron reconciliation, token cleanup and drain-report jobs.
Use @.agents/skills/bun-native and @.agents/skills/testing-and-checks.

# 15 — Deploy and harden
Implement the deployment setup, Redis session cache and OIDC conformance run.
Use @.agents/skills/security and @.agents/skills/bun-native.