alter table app_settings
  add column if not exists scrapingbee_api_keys text[] not null default '{}';
