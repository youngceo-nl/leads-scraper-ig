-- Track follow-up emails separately from initial outreach
alter table public.leads
  add column if not exists followup_count   integer not null default 0,
  add column if not exists last_followup_at timestamptz;

-- Distinguish initial outreach from follow-ups in outreach_messages.
-- All existing rows get 'outreach' via the default.
alter table public.outreach_messages
  add column if not exists email_type text not null default 'outreach'
    check (email_type in ('outreach', 'followup'));
