-- 0002_user_identity.sql
-- Every email and phone number that points at a user.
-- See .agents/skills/alias-identity.md — an email or phone is not an identity,
-- it is a handle that points at one.
--
-- NOTE: user_id has no FK yet. "user" is owned by Better Auth and is created by
-- `bunx auth migrate` in step 3; the FK is added by a step-3 migration.
-- Nothing writes rows before then. (prompts/002, assumption 1)

CREATE TABLE user_identity (
  id          text        PRIMARY KEY,
  user_id     text        NOT NULL,
  type        text        NOT NULL,
  value       text        NOT NULL,
  is_primary  boolean     NOT NULL DEFAULT false,
  is_verified boolean     NOT NULL DEFAULT false,
  source      text        NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- A handle belongs to exactly one user, globally. The single most important
  -- constraint in the alias model.
  CONSTRAINT uq_identity_value UNIQUE (type, value),

  CONSTRAINT ck_identity_type   CHECK (type IN ('email', 'phone')),
  CONSTRAINT ck_identity_source CHECK (source IN ('lms', 'miles_one', 'masterclass', 'salesforce', 'self')),
  CONSTRAINT ck_identity_value_present CHECK (length(value) > 0),

  -- verified_at is set iff is_verified. A half-verified row is unrepresentable.
  CONSTRAINT ck_identity_verified_at CHECK (
    (is_verified = false AND verified_at IS NULL) OR
    (is_verified = true  AND verified_at IS NOT NULL)
  ),

  -- Normalisation enforced in the schema, not merely in the writer.
  -- "Store the normalised form" — comparing normalised-on-read against
  -- raw-in-database is a bug that hides until it merges two strangers.
  CONSTRAINT ck_identity_email_normalised CHECK (
    type <> 'email' OR value = lower(btrim(value))
  ),
  -- E.164. A bare 10-digit number is rejected rather than stored ambiguously.
  CONSTRAINT ck_identity_phone_e164 CHECK (
    type <> 'phone' OR value ~ '^\+[1-9][0-9]{7,14}$'
  )
);

-- Exactly one primary per (user, type).
CREATE UNIQUE INDEX uq_primary_per_type
  ON user_identity (user_id, type) WHERE is_primary;

-- The login hot path. Partial, so it only indexes rows that may authenticate —
-- which also makes the "only verified authenticates" rule cheap to honour.
CREATE INDEX ix_identity_lookup
  ON user_identity (type, value) WHERE is_verified;

-- FK-shaped column: Postgres does not index it for us.
CREATE INDEX ix_identity_user ON user_identity (user_id);
-- tampered
