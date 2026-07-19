-- =============================================================================
-- Handover — batching qualified leads out to Clay for email enrichment and
-- collecting them back.
--
-- Single-operator by design: this tool has one shared login (see 0002_rls.sql),
-- so a batch has no assignee. At most one batch is open at a time, which is
-- what stops the same leads being handed out twice.
-- =============================================================================

create table if not exists public.handover_batches (
  id         uuid primary key default gen_random_uuid(),
  status     text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);

-- At most one open batch, enforced in the database rather than only in the
-- action — a double-submit would otherwise hand the same leads out twice.
create unique index if not exists handover_batches_one_open_idx
  on public.handover_batches (status)
  where status = 'open';

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
