-- Widen the following_scraper_provider check constraint.
-- 0003 only allowed ('apify','scrapingbee','auto'); the later proxy migration
-- added a 'proxy' option in the app but never updated this constraint, so
-- saving 'proxy' (or the new 'cookie' option) failed with a 23514 violation.
alter table public.app_settings
  drop constraint if exists app_settings_following_scraper_provider_check;

alter table public.app_settings
  add constraint app_settings_following_scraper_provider_check
    check (following_scraper_provider in ('apify','scrapingbee','proxy','cookie','auto'));
