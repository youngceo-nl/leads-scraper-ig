alter table public.app_settings
  add column if not exists instagram_proxy_url text;
