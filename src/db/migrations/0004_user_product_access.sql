-- 0004_user_product_access.sql
-- Layer 1 authorization: coarse, per-product, role-based. Read into token claims
-- from step 7. Resource-level access is the OpenFGA graph (step 11), not this table.
--
-- user_id FK deferred to step 3, as in 0002.

CREATE TABLE user_product_access (
  id         text        PRIMARY KEY,
  user_id    text        NOT NULL,
  product_id text        NOT NULL,
  role       text        NOT NULL,
  vendor_id  text        REFERENCES vendor (id),
  status     text        NOT NULL DEFAULT 'active',
  granted_by text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,

  CONSTRAINT uq_access_user_product_role UNIQUE (user_id, product_id, role),

  CONSTRAINT ck_access_product CHECK (product_id IN ('lms', 'miles_one', 'masterclass')),
  CONSTRAINT ck_access_role CHECK (
    role IN ('CPA', 'CMA', 'CAIRA', 'ADMIN', 'NORMAL', 'VENDOR', 'VENDOR_ADMIN')
  ),
  CONSTRAINT ck_access_status CHECK (status IN ('active', 'revoked')),

  -- Vendor roles are vendor-scoped; non-vendor roles must not carry a vendor.
  -- Both directions matter: a VENDOR without a vendor_id has unbounded scope,
  -- and an ADMIN with one implies a scoping that nothing enforces.
  CONSTRAINT ck_access_vendor_scope CHECK (
    (role IN ('VENDOR', 'VENDOR_ADMIN') AND vendor_id IS NOT NULL) OR
    (role NOT IN ('VENDOR', 'VENDOR_ADMIN') AND vendor_id IS NULL)
  ),

  -- Revocation is a status change, never a DELETE — so it must be dated.
  CONSTRAINT ck_access_revoked_at CHECK (
    status <> 'revoked' OR revoked_at IS NOT NULL
  )
);

CREATE INDEX ix_access_user       ON user_product_access (user_id);
CREATE INDEX ix_access_vendor     ON user_product_access (vendor_id) WHERE vendor_id IS NOT NULL;
-- Answers "all Masterclass vendors" — the query that made this a table rather
-- than a jsonb blob.
CREATE INDEX ix_access_product_role ON user_product_access (product_id, role) WHERE status = 'active';
