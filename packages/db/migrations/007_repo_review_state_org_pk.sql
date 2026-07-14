-- Multi-org isolation: last_reviewed_sha is per (org_id, repo_id), not repo_id alone.

-- Drop legacy single-column primary key and recreate composite
ALTER TABLE repo_review_state DROP CONSTRAINT IF EXISTS repo_review_state_pkey;

-- Deduplicate if any rows share repo_id with different org_id (keep latest per pair)
DELETE FROM repo_review_state a
USING repo_review_state b
WHERE a.repo_id = b.repo_id
  AND a.org_id = b.org_id
  AND a.ctid < b.ctid;

ALTER TABLE repo_review_state
  ADD CONSTRAINT repo_review_state_pkey PRIMARY KEY (org_id, repo_id);

CREATE INDEX IF NOT EXISTS idx_repo_review_state_repo_id ON repo_review_state (repo_id);
