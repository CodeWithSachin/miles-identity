-- 0003_vendor.sql
-- Masterclass vendors whose own IdP may federate into Masterclass.

CREATE TABLE vendor (
  id                    text        PRIMARY KEY,
  name                  text        NOT NULL,
  sso_provider_id       text,
  allowed_email_domains text[]      NOT NULL DEFAULT '{}',
  domain_verified_at    timestamptz,
  status                text        NOT NULL DEFAULT 'pending',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_vendor_name UNIQUE (name),
  CONSTRAINT ck_vendor_status CHECK (status IN ('pending', 'active', 'disabled')),

  -- A vendor's SSO provider cannot be active while its domain is unverified.
  -- An unverified domain means the vendor could assert identities it does not own,
  -- so an active-but-unverified vendor is made unrepresentable here rather than
  -- left to a check that step 10 might forget.
  CONSTRAINT ck_vendor_active_requires_verified_domain CHECK (
    status <> 'active' OR domain_verified_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX uq_vendor_sso_provider
  ON vendor (sso_provider_id) WHERE sso_provider_id IS NOT NULL;
