-- Structured specialist rationale (forwarded to senior verifier; not raw chat transcripts)
ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS reasoning TEXT;
