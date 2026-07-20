-- Add the count the dashboard funnel needs to stop hiding the biggest bucket.
--
-- backfilled leads land in exactly one of three places: filtered (went to AI
-- or was manually pre-filtered), needs_filter (pending, untouched), or
-- rejected by hardFilter/metricsGate. Rejected leads never get reason_for_score
-- or hard_filter_passed_at set (see triggerSeedFilter, which explicitly clears
-- both), so they were invisible in the funnel — "0 filtered" read as "nothing
-- happened" when most of the run had actually already been processed and
-- rejected.
drop function if exists public.lead_counts_by_parent();

create function public.lead_counts_by_parent()
returns table (
  parent_username  text,
  total            bigint,
  pending_backfill bigint,
  backfilled       bigint,
  filtered         bigint,
  verified         bigint,
  needs_filter     bigint,
  needs_verify     bigint,
  rejected         bigint
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
    ) as pending_backfill,
    count(*) filter (where l.followers is not null) as backfilled,
    count(*) filter (
      where l.followers is not null
        and (l.reason_for_score is not null or l.hard_filter_passed_at is not null)
    ) as filtered,
    count(*) filter (where l.reason_for_score is not null) as verified,
    count(*) filter (
      where l.followers is not null
        and l.status = 'pending'
        and l.hard_filter_passed_at is null
    ) as needs_filter,
    count(*) filter (
      where l.status = 'pending'
        and l.hard_filter_passed_at is not null
    ) as needs_verify,
    count(*) filter (
      where l.followers is not null
        and l.status = 'rejected'
    ) as rejected
  from public.leads l
  where l.parent_username is not null
  group by l.parent_username;
$$;
