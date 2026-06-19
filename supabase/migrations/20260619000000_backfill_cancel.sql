-- Flag that lets the UI request a running backfill to stop cleanly.
-- The backfill function checks this at the start of each batch step and
-- clears it when it stops so the next run starts fresh.
alter table public.app_settings
  add column if not exists backfill_cancel_requested boolean not null default false;
