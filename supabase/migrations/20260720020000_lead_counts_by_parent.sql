-- Per-account lead counts, aggregated in the database.
--
-- These were being computed by selecting every lead row and counting in JS,
-- which silently truncated: PostgREST caps an unbounded select at 1000 rows and
-- the table has ~7.7k. Counts for anything outside that first page came back as
-- 0, so the Pipeline card hid its "x/y backfilled" segment entirely.
--
-- Keyed by parent_username — the account whose following list produced the
-- lead — matching handover and the leads Source badge. source_seed_id would
-- also sweep in leads found by recursing into other accounts.
create or replace function public.lead_counts_by_parent()
returns table (
  parent_username text,
  total           bigint,
  pending_backfill bigint
)
language sql
stable
as $$
  select
    l.parent_username,
    count(*) as total,
    count(*) filter (
      where l.followers is null
        and (l.backfill_error is null or l.backfill_error = 'apify_exhausted')
        and l.status <> 'rejected'
    ) as pending_backfill
  from public.leads l
  where l.parent_username is not null
  group by l.parent_username;
$$;
