-- Per-user UI preferences (product tour completion, etc.)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.preferences IS 'Client UX preferences, e.g. productTour.firstReviewStatus';
