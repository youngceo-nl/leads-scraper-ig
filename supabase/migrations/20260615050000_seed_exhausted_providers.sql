ALTER TABLE seeds
  ADD COLUMN IF NOT EXISTS exhausted_providers text[] NOT NULL DEFAULT '{}';
