-- 0005_identity_merge_log.sql
-- Append-only audit of every identity merge. Keeps merges reversible for the
-- inevitable "you merged the wrong two people" ticket.

CREATE TABLE identity_merge_log (
  id               text        PRIMARY KEY,
  survivor_user_id text        NOT NULL,
  merged_user_id   text        NOT NULL,
  tier             text        NOT NULL,
  evidence         jsonb       NOT NULL,
  actor            text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- The confidence tiers from the dedup procedure. D and E arrive only via the
  -- manual review queue, so recording which tier decided a merge is the audit trail.
  CONSTRAINT ck_merge_tier CHECK (tier IN ('A', 'B', 'C', 'D', 'E')),
  CONSTRAINT ck_merge_distinct CHECK (survivor_user_id <> merged_user_id)
);

CREATE INDEX ix_merge_survivor ON identity_merge_log (survivor_user_id);
CREATE INDEX ix_merge_merged   ON identity_merge_log (merged_user_id);

-- Append-only, enforced. Convention does not survive a feature written at 2am.
CREATE OR REPLACE FUNCTION identity_merge_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'identity_merge_log is append-only';
END;
$$;

CREATE TRIGGER trg_merge_log_append_only
  BEFORE UPDATE OR DELETE ON identity_merge_log
  FOR EACH ROW EXECUTE FUNCTION identity_merge_log_append_only();
