-- Remove proxy functionality. Drops the proxy credential columns + cookie pool
-- added in 20260614120000_proxy_settings.sql, and narrows the following-scraper
-- provider constraint back to the supported set ('proxy' removed; 'cookie' kept).

-- Any rows still set to the removed 'proxy' provider fall back to 'auto'.
update public.app_settings
  set following_scraper_provider = 'auto'
  where following_scraper_provider = 'proxy';

alter table public.app_settings
  drop constraint if exists app_settings_following_scraper_provider_check;

alter table public.app_settings
  add constraint app_settings_following_scraper_provider_check
    check (following_scraper_provider in ('apify','scrapingbee','cookie','auto'));

alter table public.app_settings
  drop column if exists instagram_cookies,
  drop column if exists proxy_provider,
  drop column if exists iproyal_user,
  drop column if exists iproyal_pass,
  drop column if exists nineproxy_user,
  drop column if exists nineproxy_pass,
  drop column if exists dataimpulse_user,
  drop column if exists dataimpulse_pass;
