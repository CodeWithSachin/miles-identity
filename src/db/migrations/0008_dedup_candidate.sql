-- 0008_dedup_candidate.sql
-- The reviewed mapping table §8 (docs/architecture-plan.md) requires: dedup
-- output is a candidate pair + evidence + confidence tier, never an automatic
-- merge by itself. See .agents/skills/alias-identity.md.
--
-- "user" already exists by this point in the roadmap (unlike migration 0002's
-- timing, deferred until step 3) — the FK is direct, not deferred.

CREATE TABLE dedup_candidate (
  id         text        PRIMARY KEY,
  user_id_a  text        NOT NULL REFERENCES "user"(id),
  user_id_b  text        NOT NULL REFERENCES "user"(id),
  tier       text        NOT NULL,
  evidence   jsonb       NOT NULL,
  status     text        NOT NULL DEFAULT 'pending',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_dedup_tier   CHECK (tier IN ('A', 'B', 'C', 'D', 'E')),
  CONSTRAINT ck_dedup_status CHECK (status IN ('pending', 'merged', 'rejected')),

  -- A pair, not a self-match. A merge target is always two distinct users.
  CONSTRAINT ck_dedup_distinct CHECK (user_id_a <> user_id_b),

  -- Re-running the dedup pass must not duplicate a candidate already queued or
  -- decided (postgres-migrations.md: batch jobs must be idempotent).
  CONSTRAINT uq_dedup_pair UNIQUE (user_id_a, user_id_b)
);

CREATE INDEX ix_dedup_user_a ON dedup_candidate (user_id_a);
CREATE INDEX ix_dedup_user_b ON dedup_candidate (user_id_b);

-- The manual review queue's hot path: "show me everything still pending, by tier".
CREATE INDEX ix_dedup_pending ON dedup_candidate (tier) WHERE status = 'pending';
