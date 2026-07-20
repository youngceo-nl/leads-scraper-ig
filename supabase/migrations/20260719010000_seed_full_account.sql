-- Per-seed "full account" mode: scrape the seed's entire following list
-- instead of stopping once a target number of new leads has been found.
--
-- Distinct from max_profiles_to_scrape rather than a sentinel value in it,
-- because the two mean different things: that column caps *new leads*, while
-- this one changes the stopping condition to "the following list ran out".
alter table public.seeds
  add column if not exists scrape_full_following boolean not null default false;
