-- Extend per-account lead counts to cover the whole funnel, and add the
-- column the upcoming manual "Filter" action will stamp.
--
-- hard_filter_passed_at distinguishes "passed hardFilter+metricsGate, waiting
-- on AI" from "hasn't been checked yet" for leads filtered manually rather than
-- through the automatic crawl -> backfill -> score-lead pipeline (which does
-- both in one pass and never needs this column set).
alter table public.leads
  add column if not exists hard_filter_passed_at timestamptz;

-- Postgres can't change a function's OUT-parameter row type with a plain
-- replace, unlike its body — the old 3-column shape has to be dropped first.
drop function if exists public.lead_counts_by_parent();

create function public.lead_counts_by_parent()
returns table (
  parent_username  text,
  total            bigint,  -- "new": leads ever attributed to this account
  pending_backfill bigint,
  backfilled       bigint,
  -- Passed hardFilter + metricsGate: went to AI (reason_for_score set — only
  -- the AI path writes it) or was manually pre-filtered and is awaiting AI.
  -- Excludes hard/metrics-gate rejections, which never set either field.
  filtered         bigint,
  -- Went through AI scoring, any outcome (qualified/review/AI-rejected).
  verified         bigint
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
    count(*) filter (where l.reason_for_score is not null) as verified
  from public.leads l
  where l.parent_username is not null
  group by l.parent_username;
$$;
