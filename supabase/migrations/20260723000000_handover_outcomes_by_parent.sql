-- Per-account outcomes from the Clay handover round-trip — a genuinely
-- different question from lead_counts_by_parent() (which tracks the scrape ->
-- backfill -> AI-score pipeline), so it gets its own function rather than a
-- 4th revision of that one. Powers the source-account tag's hover popover on
-- Outreach Ready (docs/handover/tracking.md).
create or replace function public.handover_outcomes_by_parent()
returns table (
  parent_username text,
  accepted        bigint,  -- Clay found an email
  no_email        bigint,  -- came back from Clay, nothing found
  marked_bad      bigint   -- operator flagged bad while working the batch
)
language sql
stable
as $$
  select
    l.parent_username,
    count(*) filter (
      where l.email_provider = 'clay' and l.email is not null
    ) as accepted,
    count(*) filter (
      where l.handover_enriched_at is not null
        and l.email is null
        and l.status <> 'rejected'
    ) as no_email,
    count(*) filter (where rl.lead_id is not null) as marked_bad
  from public.leads l
  left join public.rejected_leads rl on rl.lead_id = l.id
  where l.parent_username is not null
  group by l.parent_username;
$$;
