-- Key handover batches to the account whose following list produced the leads,
-- not the seed the crawl started from.
--
-- source_seed_id means "the seed this discovery traces back to". Recursion
-- keeps that seed id while walking *other* accounts' following lists, so
-- @pierree showed 1039 leads when only 461 are his followings — the other 578
-- came from recursing into @bridger_rogers. Grouping by parent_username makes
-- every handover block honestly mean "this account's following list".
--
-- Safe to replace the column outright: handover_batches had 0 rows when this
-- was written (no batch has ever been claimed).

drop index if exists public.handover_batches_one_open_per_seed_idx;
drop index if exists public.handover_batches_seed_idx;

alter table public.handover_batches
  drop column if exists seed_id,
  add column if not exists parent_username text not null;

-- At most one open batch per account, enforced in the database rather than
-- only in the action — a double-submit would otherwise hand the same leads out
-- twice. Scoped by parent so working one account never blocks another.
create unique index if not exists handover_batches_one_open_per_parent_idx
  on public.handover_batches (parent_username)
  where status = 'open';

create index if not exists handover_batches_parent_idx
  on public.handover_batches (parent_username);

-- Handover pools filter leads by the account that produced them.
create index if not exists leads_parent_username_idx
  on public.leads (parent_username);
