-- The seed's own follower-list size — the hard ceiling "Found" can never
-- exceed. Refreshed at scrape time (not read from an old lead row: leads.following
-- for @pierree read 837 from a stale backfill while his real profile shows 650,
-- so the ceiling must come from a fresh check, not existing lead data).
alter table public.seeds
  add column if not exists following_count int;
