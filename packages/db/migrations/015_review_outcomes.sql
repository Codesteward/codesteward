-- Automatic / indirect eval: PR merge outcomes + per-finding dispositions

CREATE TABLE IF NOT EXISTS pr_outcomes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  tenant_id TEXT NOT NULL DEFAULT 'local',
  repo_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_key TEXT NOT NULL,
  merge_sha TEXT,
  base_sha TEXT,
  head_sha TEXT,
  session_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  gate_verdict TEXT,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  rates JSONB NOT NULL DEFAULT '{}'::jsonb,
  paths_changed JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_outcomes_org_pr
  ON pr_outcomes (org_id, pr_key);
CREATE INDEX IF NOT EXISTS idx_pr_outcomes_org_id ON pr_outcomes (org_id);
CREATE INDEX IF NOT EXISTS idx_pr_outcomes_repo_id ON pr_outcomes (repo_id);
CREATE INDEX IF NOT EXISTS idx_pr_outcomes_created ON pr_outcomes (created_at DESC);

CREATE TABLE IF NOT EXISTS finding_outcomes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  tenant_id TEXT NOT NULL DEFAULT 'local',
  repo_id TEXT NOT NULL,
  pr_number INTEGER,
  pr_key TEXT,
  finding_id TEXT,
  fingerprint TEXT,
  kind TEXT NOT NULL,
  session_id TEXT,
  merge_sha TEXT,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
  note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finding_outcomes_org ON finding_outcomes (org_id);
CREATE INDEX IF NOT EXISTS idx_finding_outcomes_repo ON finding_outcomes (repo_id);
CREATE INDEX IF NOT EXISTS idx_finding_outcomes_finding ON finding_outcomes (finding_id);
CREATE INDEX IF NOT EXISTS idx_finding_outcomes_fp ON finding_outcomes (fingerprint);
CREATE INDEX IF NOT EXISTS idx_finding_outcomes_kind ON finding_outcomes (kind);
CREATE INDEX IF NOT EXISTS idx_finding_outcomes_pr ON finding_outcomes (pr_key);
CREATE INDEX IF NOT EXISTS idx_finding_outcomes_created ON finding_outcomes (created_at DESC);

COMMENT ON TABLE pr_outcomes IS 'Post-merge outcome snapshot for address/noise/ignore KPIs';
COMMENT ON TABLE finding_outcomes IS 'Per-finding disposition from human feedback or merge analysis';
