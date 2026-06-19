-- Allow 'bounced' as a valid status on outreach_messages.
-- The original inline CHECK got the auto-generated name outreach_messages_status_check.
alter table public.outreach_messages
  drop constraint if exists outreach_messages_status_check;

alter table public.outreach_messages
  add constraint outreach_messages_status_check
  check (status in ('sent', 'failed', 'bounced'));

alter table public.outreach_messages
  add column if not exists bounced_at timestamptz;
