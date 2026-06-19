-- Timestamp written when a bulk backfill is triggered so the UI can show
-- "starting up" before the first profile is processed.
alter table public.app_settings
  add column if not exists backfill_started_at timestamptz default null;
