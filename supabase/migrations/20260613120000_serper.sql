alter table public.app_settings
  add column if not exists serper_api_key text;
