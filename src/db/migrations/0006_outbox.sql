-- 0006_outbox.sql
-- Transactional outbox for OpenFGA tuple sync.
--
-- A domain write and its outbox row commit together, or neither commits. Writing
-- a tuple directly from a handler is a dual write and it will drift — the single
-- most common failure mode in Zanzibar-style deployments.
--
-- Table only. The worker that drains it is step 11.

CREATE TABLE outbox (
  id           bigserial   PRIMARY KEY,
  aggregate    text        NOT NULL,
  event_type   text        NOT NULL,
  payload      jsonb       NOT NULL,
  attempts     int         NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,

  CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0)
);

-- Partial: stays small as processed rows accumulate. The worker claims from here
-- with FOR UPDATE SKIP LOCKED so multiple instances do not double-process.
CREATE INDEX ix_outbox_pending ON outbox (id) WHERE processed_at IS NULL;

COMMENT ON TABLE outbox IS
  'Domain write + outbox row in one transaction. Never write an FGA tuple from a request handler.';
