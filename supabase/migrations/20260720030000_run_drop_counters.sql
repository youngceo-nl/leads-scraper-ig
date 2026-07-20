-- Per-run counts for leads dropped before backfill.
--
-- bulkUpsertDiscoveredLeads only ever returned `inserted`, so a run's
-- duplicates (already-existed) and exclusions (previously bulk-deleted) were
-- invisible — for @pierree's fullest run, 505 of 649 scraped accounts were
-- duplicates, and that number existed nowhere.
alter table public.crawl_jobs
  add column if not exists accounts_duplicate int not null default 0,
  add column if not exists accounts_excluded  int not null default 0;

-- Replaces bump_crawl_counters: Postgres can't add a parameter to an existing
-- function signature, so the old 5-arg version is dropped and recreated with
-- the two new counters appended.
drop function if exists public.bump_crawl_counters(uuid, int, int, int, int);

create function public.bump_crawl_counters(
  p_job_id      uuid,
  p_found       int default 0,
  p_backfilled  int default 0,
  p_filtered    int default 0,
  p_verified    int default 0,
  p_duplicate   int default 0,
  p_excluded    int default 0
) returns void
language sql
as $$
  update public.crawl_jobs
     set accounts_found      = accounts_found      + p_found,
         accounts_backfilled = accounts_backfilled + p_backfilled,
         accounts_filtered   = accounts_filtered   + p_filtered,
         accounts_verified   = accounts_verified   + p_verified,
         accounts_duplicate  = accounts_duplicate  + p_duplicate,
         accounts_excluded   = accounts_excluded   + p_excluded
   where id = p_job_id;
$$;
