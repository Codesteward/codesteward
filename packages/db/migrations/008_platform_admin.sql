-- Platform operators (install-wide) vs tenant org admins
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS platform_admin BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_platform_admin ON users (platform_admin)
  WHERE platform_admin = true;

-- Bootstrap legacy: first install admin becomes platform operator
UPDATE users
SET platform_admin = true
WHERE id = (
  SELECT id FROM users ORDER BY created_at ASC LIMIT 1
)
AND role = 'admin'
AND platform_admin = false;
