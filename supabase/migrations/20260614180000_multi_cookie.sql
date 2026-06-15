ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS instagram_session_cookies text[] NOT NULL DEFAULT '{}';

-- Copy existing single cookie into the array if the array is still empty
UPDATE app_settings
SET instagram_session_cookies = ARRAY[instagram_session_cookie]
WHERE instagram_session_cookie IS NOT NULL
  AND instagram_session_cookie <> ''
  AND (array_length(instagram_session_cookies, 1) IS NULL);
