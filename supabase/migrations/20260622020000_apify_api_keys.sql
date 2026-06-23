alter table app_settings
  add column if not exists apify_api_keys text[] not null default '{}';
