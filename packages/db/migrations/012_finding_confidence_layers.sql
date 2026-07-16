-- Three-level confidence: product (confidence), model self-report, optional token/logprobs
ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS model_confidence DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS token_confidence DOUBLE PRECISION;
