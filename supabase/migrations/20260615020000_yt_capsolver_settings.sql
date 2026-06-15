-- Add CapSolver API key and YouTube Google session cookie to app_settings.
-- These are used by the headless-Chromium email-reveal path (no ScrapingBee needed).
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS capsolver_api_key text,
  ADD COLUMN IF NOT EXISTS yt_google_cookie  text;
