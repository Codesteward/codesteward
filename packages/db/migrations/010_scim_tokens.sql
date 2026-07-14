-- Per-org SCIM bearer tokens for multi-tenant single-domain installs.
-- IdPs cannot set X-Org-Id; org is resolved from token hash and/or path /scim/v2/orgs/:orgKey/

CREATE TABLE IF NOT EXISTS scim_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  label TEXT,
  last4 TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_tokens_hash
  ON scim_tokens (token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scim_tokens_org
  ON scim_tokens (org_id)
  WHERE revoked_at IS NULL;

-- external_id uniqueness is install-wide; for multi-tenant prefer membership scoping in app layer
