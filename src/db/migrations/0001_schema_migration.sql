-- 0001_schema_migration.sql
-- The migration ledger. Must be first; the runner bootstraps this before
-- reading applied state. See .agents/skills/postgres-migrations.md

CREATE TABLE IF NOT EXISTS schema_migration (
  version    text        PRIMARY KEY,
  name       text        NOT NULL,
  checksum   text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- checksum is a SHA-256 of the file contents. Forward-only means an applied
-- migration file is immutable; the runner refuses to proceed on a mismatch.
COMMENT ON COLUMN schema_migration.checksum IS
  'SHA-256 of the migration file at apply time. A mismatch means an applied file was edited.';
