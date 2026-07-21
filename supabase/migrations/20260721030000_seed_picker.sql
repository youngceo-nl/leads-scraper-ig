-- Seed picker: "Recommended source accounts" section on the Source Accounts
-- page, plus a "bad seed" list for accounts a human explicitly rejected as
-- seed candidates (kept as a future training set, separate from
-- excluded_usernames — that table blocks re-adding LEADS, this is about
-- seed-account judgment, a different signal).

create table if not exists public.rejected_seeds (
  username    text primary key,
  reason      text,
  marked_by   uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists rejected_seeds_created_at_idx
  on public.rejected_seeds (created_at desc);

alter table public.rejected_seeds enable row level security;
drop policy if exists rejected_seeds_all on public.rejected_seeds;
create policy rejected_seeds_all on public.rejected_seeds
  for all to authenticated using (true) with check (true);

-- Who-follows-whom edges, recorded at scrape time going forward. This is the
-- one thing the pipeline never kept: leads.parent_username is single-valued
-- and first-writer-wins (bulkUpsertDiscoveredLeads upserts on username with
-- ignoreDuplicates), so an account followed by 3 seeds only ever remembers
-- the first one that found it. Real multi-seed overlap can only accrue from
-- here forward; it can't be reconstructed for what's already been dropped.
create table if not exists public.following_edges (
  seed_username     text not null,
  followed_username text not null,
  first_seen_at     timestamptz not null default now(),
  primary key (seed_username, followed_username)
);

create index if not exists following_edges_followed_idx
  on public.following_edges (followed_username);

alter table public.following_edges enable row level security;
drop policy if exists following_edges_all on public.following_edges;
create policy following_edges_all on public.following_edges
  for all to authenticated using (true) with check (true);

-- One-time backfill from what we do still have: every lead's single
-- attributed parent. This seeds the table with real (if incomplete) edges —
-- one per account, since that's all leads.parent_username ever recorded —
-- rather than starting the recommender's overlap signal at zero.
insert into public.following_edges (seed_username, followed_username)
select distinct parent_username, username
from public.leads
where parent_username is not null
on conflict do nothing;
