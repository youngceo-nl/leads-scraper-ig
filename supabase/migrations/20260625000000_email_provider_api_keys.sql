alter table app_settings
  add column if not exists findymail_api_keys text[] not null default '{}',
  add column if not exists prospeo_api_keys   text[] not null default '{}';
