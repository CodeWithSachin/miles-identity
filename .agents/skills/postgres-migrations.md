# Skill: postgres-migrations

Read before writing any migration or query. Two migration paths, one database, and they must never overlap.

---

## Two owners, kept separate

| Tables | Owner | How they change |
|---|---|---|
| `session`, `account`, `verification`, `jwks`, `oauthApplication`, `oauthAccessToken`, `oauthConsent`, `ssoProvider`, `twoFactor` | **Better Auth** | `bunx @better-auth/cli migrate` |
| `user_identity`, `user_product_access`, `vendor`, `identity_merge_log`, `outbox` | **Us** | `src/db/migrations/`, `bun run db:migrate` |
| `user` | Better Auth core + our `additionalFields` | CLI, extended via config |

Never hand-edit a Better Auth table. Never let the CLI manage ours. Review generated SQL before applying — this is a production auth store.

## Our migration format

`src/db/migrations/NNNN_<slug>.sql`, four-digit, monotonic, never renumbered. Forward-only.

```sql
-- 0003_user_identity.sql
-- Handles that point at a user. See .agents/skills/alias-identity.md

CREATE TABLE user_identity (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('email','phone')),
  value       text NOT NULL,
  is_primary  boolean NOT NULL DEFAULT false,
  is_verified boolean NOT NULL DEFAULT false,
  source      text NOT NULL CHECK (source IN ('lms','miles_one','masterclass','salesforce','self')),
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_identity_value UNIQUE (type, value)
);

-- exactly one primary per type per user
CREATE UNIQUE INDEX uq_primary_per_type
  ON user_identity (user_id, type) WHERE is_primary;

-- the login hot path
CREATE INDEX ix_identity_lookup
  ON user_identity (type, value) WHERE is_verified;

-- verified_at must be set iff verified
ALTER TABLE user_identity ADD CONSTRAINT ck_verified_at
  CHECK ((is_verified = false AND verified_at IS NULL)
      OR (is_verified = true  AND verified_at IS NOT NULL));
```

**Put invariants in the schema, not only in code.** A `CHECK` or partial unique index cannot be forgotten by a future feature; an application-layer check can.

## Rules

1. **Forward-only.** No down migrations. A mistake is fixed by a new migration.
2. **One concern per file.** Do not bundle unrelated changes.
3. `timestamptz`, never `timestamp`. Store UTC.
4. `text`, not `varchar(n)` — no benefit in Postgres, and the length limit will be wrong.
5. Every FK gets an index. Postgres does not create one automatically.
6. `CREATE INDEX CONCURRENTLY` for any index on a table with real rows — a plain `CREATE INDEX` locks writes.
7. New `NOT NULL` column on a populated table: add nullable → backfill in batches → set `NOT NULL`. Three migrations, not one.
8. Never `DROP COLUMN` in the same release that stops writing it. Stop writing, ship, verify, then drop.
9. Every migration is applied to a staging clone with production-shaped data before production. No exceptions in an auth store.

## Queries — `Bun.sql` only

```ts
import { sql } from "bun";

const rows = await sql`
  SELECT ui.user_id
  FROM user_identity ui
  WHERE ui.type = ${type} AND ui.value = ${value} AND ui.is_verified = true
`;
```

- Interpolation is parameterised. Safe by construction.
- **Identifiers cannot be parameterised.** Never interpolate a table or column name from input — that is injection with extra steps.
- All SQL lives in `src/db/`. No inline queries in services or routes.
- Return typed rows; validate at the boundary if the shape came from outside.

## Transactions

```ts
await sql.begin(async tx => {
  await tx`UPDATE "user" SET status='merged', merged_into_user_id=${survivor} WHERE id=${loser}`;
  await tx`UPDATE user_identity SET user_id=${survivor} WHERE user_id=${loser}`;
  await tx`INSERT INTO identity_merge_log (...) VALUES (...)`;
});
```

Use `tx`, never the outer `sql`, inside the callback — mixing them silently runs statements outside the transaction.

**Always in one transaction:** merges, domain-write-plus-outbox, access grant plus audit row.

## Batch jobs — the legacy import and dedup

- **Keyset pagination**, never `OFFSET`. `WHERE id > $cursor ORDER BY id LIMIT 5000`.
- Resumable: persist the cursor. A 400K-row job will be interrupted.
- Idempotent: re-running must not duplicate. `ON CONFLICT DO NOTHING` or a natural key.
- Log progress and a final reconciliation count. "It finished" is not a result; "412,388 of 412,388, 0 orphans" is.
- Two connections for the legacy import: `sql` for the target, `new SQL(LEGACY_DATABASE_URL)` for the source.

## The `outbox` table

```sql
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  aggregate    text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  last_error   text
);

CREATE INDEX ix_outbox_pending ON outbox (id) WHERE processed_at IS NULL;
```

The worker claims rows with `FOR UPDATE SKIP LOCKED` so multiple instances do not double-process. Never delete unprocessed rows to clear a backlog — that silently drops permission changes.

## Connection pooling

`Bun.sql` pools natively. At 300K+ users behind two or more instances, size the pool against Postgres `max_connections` and put PgBouncer in front if instance count grows. Note Better Auth's `pg` `Pool` is a **second** pool in the same process — count both.
