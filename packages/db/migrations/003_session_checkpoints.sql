-- Session-level checkpoints (no unit FK) + repo review state for learning

CREATE TABLE IF NOT EXISTS session_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session_id
  ON session_checkpoints (session_id);
CREATE INDEX IF NOT EXISTS idx_session_checkpoints_updated
  ON session_checkpoints (updated_at DESC);

-- Incremental gate: last reviewed SHA per repo
CREATE TABLE IF NOT EXISTS repo_review_state (
  repo_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  last_reviewed_sha TEXT,
  last_session_id TEXT,
  last_pr_number INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_repo_review_state_org_id ON repo_review_state (org_id);
