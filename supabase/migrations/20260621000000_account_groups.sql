alter table public.app_settings
  add column if not exists active_account_group text default null,
  add column if not exists instagram_proxy_pool text[] default '{}';
