-- Multi-tenant / multi-org + enterprise SCM app installations

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_organizations_tenant ON organizations (tenant_id);

CREATE TABLE IF NOT EXISTS organization_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reviewer'
    CHECK (role IN ('owner', 'admin', 'reviewer', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members (user_id);

-- GitHub App / GitLab OAuth app registration (per tenant; secrets as refs or inline for self-host)
CREATE TABLE IF NOT EXISTS scm_apps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- github | github_enterprise | gitlab | bitbucket | azure-devops
  auth_mode TEXT NOT NULL DEFAULT 'github_app'
    CHECK (auth_mode IN ('github_app', 'gitlab_oauth', 'oauth_app', 'pat_legacy', 'ado_sp')),
  app_id TEXT,              -- GitHub App id
  client_id TEXT,
  client_secret_ref TEXT,   -- env:NAME | file:/path | inline (discouraged)
  private_key_ref TEXT,     -- PEM for GitHub App
  webhook_secret_ref TEXT,
  base_url TEXT,            -- https://github.com or GHE / GL host
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, app_id)
);
CREATE INDEX IF NOT EXISTS idx_scm_apps_tenant ON scm_apps (tenant_id, provider);

-- Per product-org binding to an SCM installation (e.g. one GH org install)
CREATE TABLE IF NOT EXISTS scm_installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  scm_app_id TEXT REFERENCES scm_apps(id) ON DELETE SET NULL,
  installation_id TEXT NOT NULL,     -- GitHub installation id
  account_login TEXT NOT NULL,       -- acme-corp
  account_type TEXT NOT NULL DEFAULT 'Organization',
  account_id TEXT,
  base_url TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  repository_selection TEXT,         -- all | selected
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, installation_id, base_url)
);
CREATE INDEX IF NOT EXISTS idx_scm_installations_org ON scm_installations (org_id, provider);
CREATE INDEX IF NOT EXISTS idx_scm_installations_tenant ON scm_installations (tenant_id);

-- Token cache (short-lived installation tokens) — optional; may also be in-memory
CREATE TABLE IF NOT EXISTS scm_token_cache (
  installation_pk TEXT PRIMARY KEY REFERENCES scm_installations(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default tenant if empty (self-host single-tenant bootstrap)
INSERT INTO tenants (id, name, slug)
VALUES ('local', 'Local', 'local')
ON CONFLICT (id) DO NOTHING;

INSERT INTO organizations (id, tenant_id, name, slug)
VALUES ('local', 'local', 'Local', 'local')
ON CONFLICT (id) DO NOTHING;
