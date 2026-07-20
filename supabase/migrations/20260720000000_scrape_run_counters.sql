-- Live funnel counters for a scrape run.
--
-- crawl_jobs already had profiles_scraped / new_leads / qualified_count, but
-- crawl-seed only writes them in its final set-counters step — so they read 0
-- for the entire run, which is exactly the window worth watching. These four
-- are incremented as each stage completes instead.
alter table public.crawl_jobs
  add column if not exists accounts_found      int not null default 0,
  add column if not exists accounts_backfilled int not null default 0,
  add column if not exists accounts_filtered   int not null default 0,
  add column if not exists accounts_verified   int not null default 0;

-- Atomic increment. score-lead runs concurrently (several leads at once), so a
-- read-modify-write from the application would silently lose counts.
create or replace function public.bump_crawl_counters(
  p_job_id      uuid,
  p_found       int default 0,
  p_backfilled  int default 0,
  p_filtered    int default 0,
  p_verified    int default 0
) returns void
language sql
as $$
  update public.crawl_jobs
     set accounts_found      = accounts_found      + p_found,
         accounts_backfilled = accounts_backfilled + p_backfilled,
         accounts_filtered   = accounts_filtered   + p_filtered,
         accounts_verified   = accounts_verified   + p_verified
   where id = p_job_id;
$$;
