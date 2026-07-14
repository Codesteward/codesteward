-- Session checkpoint summary + failure log + resume attempts (self-heal)

ALTER TABLE review_sessions
  ADD COLUMN IF NOT EXISTS checkpoint JSONB,
  ADD COLUMN IF NOT EXISTS failure_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS resume_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE review_units
  ADD COLUMN IF NOT EXISTS attempts INTEGER,
  ADD COLUMN IF NOT EXISTS last_strategy TEXT,
  ADD COLUMN IF NOT EXISTS healed BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_review_sessions_resume
  ON review_sessions (status, stage)
  WHERE status IN ('running', 'failed', 'pending');
