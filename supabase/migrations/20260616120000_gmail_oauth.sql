-- Gmail OAuth (send-only sending + reply-by-threadId reading).
-- Replaces the SMTP app-password flow. The app sends via the Gmail API with the
-- `gmail.send` scope and reads replies ONLY by the threadIds it created, so the
-- platform never lists or searches the user's mailbox.

-- One-time OAuth app credentials + the minted refresh token + the connected
-- Gmail address. Stored in app_settings to match the existing credential pattern.
alter table app_settings
  add column if not exists gmail_oauth_client_id     text,
  add column if not exists gmail_oauth_client_secret text,
  add column if not exists gmail_oauth_refresh_token text,
  add column if not exists gmail_oauth_email         text;

-- Gmail thread id captured at send time. Reply polling fetches ONLY these
-- threads (gmail threads.get), never the broader mailbox.
alter table outreach_messages
  add column if not exists gmail_thread_id text;

create index if not exists outreach_messages_thread_idx
  on outreach_messages (gmail_thread_id)
  where gmail_thread_id is not null;
