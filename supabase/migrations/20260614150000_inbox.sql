-- Inbox: lead replies to outreach emails.
-- Populated by reading the Gmail mailbox over IMAP and matching incoming mail
-- to a prior outreach send via the reply's In-Reply-To/References headers (or,
-- as a fallback, the sender address matching a lead we actually emailed).
-- ONLY outreach-related replies are ever stored here.

create table if not exists public.inbox_messages (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             uuid not null references public.leads(id) on delete cascade,
  outreach_message_id uuid references public.outreach_messages(id) on delete set null,
  gmail_message_id    text,            -- Message-ID header of the reply (dedupe key)
  imap_uid            bigint,          -- IMAP UID in INBOX (debug / re-fetch)
  from_email          text,
  from_name           text,
  subject             text,
  snippet             text,            -- first ~200 chars of the plain-text body
  body_text           text,
  body_html           text,
  in_reply_to         text,            -- the message-id this reply answers
  received_at         timestamptz not null default now(),
  is_read             boolean not null default false,
  created_at          timestamptz not null default now()
);

-- Dedupe on the reply's Message-ID so repeated syncs are idempotent.
create unique index if not exists inbox_messages_gmail_id_uidx
  on public.inbox_messages (gmail_message_id) where gmail_message_id is not null;
create index if not exists inbox_messages_lead_idx       on public.inbox_messages (lead_id, received_at desc);
create index if not exists inbox_messages_received_idx   on public.inbox_messages (received_at desc);
create index if not exists inbox_messages_unread_idx     on public.inbox_messages (is_read) where is_read = false;

alter table public.inbox_messages enable row level security;
drop policy if exists inbox_messages_all on public.inbox_messages;
create policy inbox_messages_all on public.inbox_messages
  for all to authenticated using (true) with check (true);

-- Denormalised reply counters on the lead row for the leads table / detail page.
alter table public.leads
  add column if not exists reply_count    integer not null default 0,
  add column if not exists last_reply_at  timestamptz;
