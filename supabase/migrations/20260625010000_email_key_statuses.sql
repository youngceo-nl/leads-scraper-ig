alter table app_settings
  add column if not exists email_key_statuses jsonb not null default '{}';
