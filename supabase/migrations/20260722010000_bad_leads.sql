-- Bad leads: a human-corrected training collection (docs/bottlenecks/bottleneck02.md).
-- AI scoring still qualifies leads that are off-ICP; this records a human
-- override — with a documented category/reason — for leads that were
-- qualified but shouldn't have been, to later train the system to stop
-- allowing them. Mirrors rejected_seeds's shape/RLS
-- (supabase/migrations/20260721030000_seed_picker.sql) but keyed by lead id,
-- since a lead is a stable row, not just a username.
create table if not exists public.rejected_leads (
  lead_id      uuid primary key references public.leads(id) on delete cascade,
  username     text not null,          -- denormalized for the table display
  category     text not null,          -- preset bad-lead category, see lib/leads/bad-lead.ts
  note         text,                   -- optional free-text detail
  -- Status before we flipped it to rejected, so un-marking restores it
  -- correctly instead of blindly setting it back to "qualified" (which would
  -- be wrong if the lead's real prior state was "review").
  prior_status text,
  marked_by    uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists rejected_leads_created_at_idx
  on public.rejected_leads (created_at desc);

alter table public.rejected_leads enable row level security;
drop policy if exists rejected_leads_all on public.rejected_leads;
create policy rejected_leads_all on public.rejected_leads
  for all to authenticated using (true) with check (true);
