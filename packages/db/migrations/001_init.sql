-- CodeSteward Review — durable state (Postgres)

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Org settings / configs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_settings (
  org_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  model_profiles JSONB NOT NULL DEFAULT '{}'::jsonb,
  steward_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_settings_tenant ON org_settings (tenant_id);

-- ---------------------------------------------------------------------------
-- Review sessions + append-only events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  tenant_id TEXT NOT NULL DEFAULT 'local',
  repo_id TEXT NOT NULL,
  repo_path TEXT,
  mode TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'api',
  base_sha TEXT,
  head_sha TEXT,
  base_branch TEXT,
  head_branch TEXT,
  pr_number INTEGER,
  scm_provider TEXT,
  scm_full_name TEXT,
  risk_tier TEXT NOT NULL DEFAULT 'full',
  depth TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  stage TEXT NOT NULL DEFAULT 'queued',
  verdict TEXT,
  token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_snapshot_id TEXT,
  parent_session_id TEXT,
  error TEXT,
  checkpoint JSONB,
  failure_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  resume_attempts INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_review_sessions_session_id ON review_sessions (id);
CREATE INDEX IF NOT EXISTS idx_review_sessions_repo_id ON review_sessions (repo_id);
CREATE INDEX IF NOT EXISTS idx_review_sessions_org_id ON review_sessions (org_id);
CREATE INDEX IF NOT EXISTS idx_review_sessions_status ON review_sessions (status);
CREATE INDEX IF NOT EXISTS idx_review_sessions_created ON review_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_sessions_org_repo ON review_sessions (org_id, repo_id);

CREATE TABLE IF NOT EXISTS session_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_sessions (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events (session_id, id);

-- ---------------------------------------------------------------------------
-- Review units + checkpoints (self-healing resume)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_units (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_sessions (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  symbols JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  worker_id TEXT,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  attempts INTEGER,
  last_strategy TEXT,
  healed BOOLEAN,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_units_session_id ON review_units (session_id);
CREATE INDEX IF NOT EXISTS idx_review_units_status ON review_units (status);

CREATE TABLE IF NOT EXISTS unit_checkpoints (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES review_units (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (unit_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_unit_checkpoints_session_id ON unit_checkpoints (session_id);
CREATE INDEX IF NOT EXISTS idx_unit_checkpoints_unit_id ON unit_checkpoints (unit_id);

-- ---------------------------------------------------------------------------
-- Findings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT 'local',
  repo_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  symbol_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  agents JSONB NOT NULL DEFAULT '[]'::jsonb,
  rule_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggestion TEXT,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification JSONB,
  scm_comment_id TEXT,
  cross_repo_origin_repo_id TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_findings_session_id ON findings (session_id);
CREATE INDEX IF NOT EXISTS idx_findings_repo_id ON findings (repo_id);
CREATE INDEX IF NOT EXISTS idx_findings_org_id ON findings (org_id);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings (status);
CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings (fingerprint);
CREATE INDEX IF NOT EXISTS idx_findings_repo_fingerprint ON findings (repo_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_findings_created ON findings (created_at DESC);

-- ---------------------------------------------------------------------------
-- Cross-repo links
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cross_repo_links (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  from_repo_id TEXT NOT NULL,
  to_repo_id TEXT NOT NULL,
  edge_type TEXT NOT NULL DEFAULT 'depends_on_api',
  path_filters JSONB NOT NULL DEFAULT '{"from":[],"to":[]}'::jsonb,
  from_repo_path TEXT,
  to_repo_path TEXT,
  hints JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_depth INTEGER NOT NULL DEFAULT 2,
  token_budget INTEGER NOT NULL DEFAULT 50000,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cross_repo_links_org_id ON cross_repo_links (org_id);
CREATE INDEX IF NOT EXISTS idx_cross_repo_links_from_repo ON cross_repo_links (from_repo_id);
CREATE INDEX IF NOT EXISTS idx_cross_repo_links_to_repo ON cross_repo_links (to_repo_id);

-- ---------------------------------------------------------------------------
-- Learning (reactions, memories, embedding metadata)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS learning_reactions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  tenant_id TEXT NOT NULL DEFAULT 'local',
  finding_id TEXT,
  session_id TEXT,
  repo_id TEXT,
  kind TEXT NOT NULL,
  user_id TEXT,
  comment TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_reactions_finding_id ON learning_reactions (finding_id);
CREATE INDEX IF NOT EXISTS idx_learning_reactions_org_id ON learning_reactions (org_id);
CREATE INDEX IF NOT EXISTS idx_learning_reactions_repo_id ON learning_reactions (repo_id);
CREATE INDEX IF NOT EXISTS idx_learning_reactions_session_id ON learning_reactions (session_id);

CREATE TABLE IF NOT EXISTS learning_memories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  tenant_id TEXT NOT NULL DEFAULT 'local',
  repo_id TEXT,
  kind TEXT NOT NULL DEFAULT 'memory',
  title TEXT,
  body TEXT NOT NULL,
  source TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_memories_org_id ON learning_memories (org_id);
CREATE INDEX IF NOT EXISTS idx_learning_memories_repo_id ON learning_memories (repo_id);

CREATE TABLE IF NOT EXISTS learning_embeddings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  tenant_id TEXT NOT NULL DEFAULT 'local',
  repo_id TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  -- Portable float[] metadata; optional pgvector column can be added later
  embedding JSONB NOT NULL,
  content_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_embeddings_subject ON learning_embeddings (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_learning_embeddings_org_id ON learning_embeddings (org_id);
CREATE INDEX IF NOT EXISTS idx_learning_embeddings_repo_id ON learning_embeddings (repo_id);

-- ---------------------------------------------------------------------------
-- Jobs + transactional outbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_session_id ON jobs (session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, available_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status, available_at);

-- ---------------------------------------------------------------------------
-- SCM webhook delivery log (idempotency)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scm_delivery_log (
  delivery_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'github',
  event_type TEXT,
  org_id TEXT,
  repo_id TEXT,
  payload_hash TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  session_id TEXT,
  job_id TEXT,
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scm_delivery_repo_id ON scm_delivery_log (repo_id);
CREATE INDEX IF NOT EXISTS idx_scm_delivery_status ON scm_delivery_log (status);
CREATE INDEX IF NOT EXISTS idx_scm_delivery_org_id ON scm_delivery_log (org_id);

-- ---------------------------------------------------------------------------
-- Agent failure log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_failure_log (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  unit_id TEXT,
  org_id TEXT,
  repo_id TEXT,
  agent_role TEXT,
  error_class TEXT,
  message TEXT NOT NULL,
  stack TEXT,
  retriable BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_failure_session_id ON agent_failure_log (session_id);
CREATE INDEX IF NOT EXISTS idx_agent_failure_repo_id ON agent_failure_log (repo_id);
CREATE INDEX IF NOT EXISTS idx_agent_failure_org_id ON agent_failure_log (org_id);
CREATE INDEX IF NOT EXISTS idx_agent_failure_created ON agent_failure_log (created_at DESC);
