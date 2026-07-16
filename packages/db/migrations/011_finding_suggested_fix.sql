-- Optional concrete code fix + existing snippet on findings
ALTER TABLE findings ADD COLUMN IF NOT EXISTS suggested_fix TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS existing_code TEXT;
