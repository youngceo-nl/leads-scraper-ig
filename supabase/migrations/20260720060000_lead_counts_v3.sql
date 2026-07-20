-- Add the two counts the Filter/AI Verify dropdown needs, defined to match
-- exactly what triggerSeedFilter/triggerSeedVerify each query — not derived by
-- subtracting other totals, which would silently include leads those actions
-- don't actually touch (e.g. a hard/metrics-gate rejection has followers set
-- and neither flag set, so `backfilled - filtered` would wrongly count it as
-- "needs filter" even though it's already rejected, not pending).
drop function if exists public.lead_counts_by_parent();

create function public.lead_counts_by_parent()
returns table (
  parent_username  text,
  total            bigint,
  pending_backfill bigint,
  backfilled       bigint,
  filtered         bigint,
  verified         bigint,
  needs_filter     bigint,  -- matches triggerSeedFilter's query exactly
  needs_verify     bigint   -- matches triggerSeedVerify's query exactly
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
    ) as needs_verify
  from public.leads l
  where l.parent_username is not null
  group by l.parent_username;
$$;
