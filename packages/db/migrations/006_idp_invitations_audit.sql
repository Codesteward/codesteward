-- IdP link, invitations, audit log (product SoT; Keycloak remains IdP)

ALTER TABLE users ADD COLUMN IF NOT EXISTS idp_subject TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS idp_issuer TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_idp
  ON users (idp_issuer, idp_subject)
  WHERE idp_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS org_invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reviewer'
    CHECK (role IN ('owner', 'admin', 'reviewer', 'viewer')),
  token_hash TEXT NOT NULL,
  invited_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON org_invitations (org_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  org_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_events (org_id, created_at DESC);

-- review_sessions already have org_id; ensure isolation index (idempotent)
CREATE INDEX IF NOT EXISTS idx_review_sessions_org_iso ON review_sessions (org_id);
