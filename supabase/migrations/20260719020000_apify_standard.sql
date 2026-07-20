-- Apify becomes the standard following scraper.
--
-- It was never actually reachable before: scrape-following.ts hardcoded a
-- Playwright -> cookie chain and ignored this column entirely, so selecting
-- "apify" silently ran Playwright. The scraper now dispatches on this value,
-- which makes the default meaningful for the first time.
alter table public.app_settings
  alter column following_scraper_provider set default 'apify';

-- 'scrapingbee' is no longer a code path; anything on it (or on the old
-- 'auto' default) moves to the standard provider rather than falling through
-- to whatever the chain happens to pick.
update public.app_settings
   set following_scraper_provider = 'apify'
 where following_scraper_provider in ('auto', 'scrapingbee');
