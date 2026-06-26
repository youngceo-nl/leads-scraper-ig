alter table app_settings
  add column if not exists yt_cookie_statuses jsonb not null default '{}';
