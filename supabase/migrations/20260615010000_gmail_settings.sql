ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS gmail_user        text,
  ADD COLUMN IF NOT EXISTS gmail_app_password text,
  ADD COLUMN IF NOT EXISTS gmail_from_name   text;
