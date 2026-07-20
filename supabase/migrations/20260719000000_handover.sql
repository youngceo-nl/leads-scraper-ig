-- =============================================================================
-- Handover — batching qualified leads out to Clay for email enrichment and
-- collecting them back.
--
-- Single-operator by design: this tool has one shared login (see 0002_rls.sql),
-- so a batch has no assignee. Batches are scoped to the source account the
-- leads were scraped from, so several accounts can be in flight at once.
-- =============================================================================

create table if not exists public.handover_batches (
  id         uuid primary key default gen_random_uuid(),
  seed_id    uuid not null references public.seeds(id) on delete cascade,
  status     text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);

-- At most one open batch *per account*, enforced in the database rather than
-- only in the action — a double-submit would otherwise hand the same leads out
-- twice. Scoped by seed so working one account never blocks another.
create unique index if not exists handover_batches_one_open_per_seed_idx
  on public.handover_batches (seed_id)
  where status = 'open';

create index if not exists handover_batches_seed_idx
  on public.handover_batches (seed_id);

alter table public.leads
  add column if not exists handover_batch_id   uuid references public.handover_batches(id) on delete set null,
  add column if not exists handover_enriched_at timestamptz;

-- Pool lookups filter on batch membership; closed-batch review filters by id.
create index if not exists leads_handover_batch_idx on public.leads (handover_batch_id);

alter table public.handover_batches enable row level security;

drop policy if exists "handover_batches_select" on public.handover_batches;
drop policy if exists "handover_batches_modify" on public.handover_batches;
create policy "handover_batches_select" on public.handover_batches
  for select to authenticated using (true);
create policy "handover_batches_modify" on public.handover_batches
  for all to authenticated using (true) with check (true);
