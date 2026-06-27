alter table leads
  add column if not exists email_v2             text,
  add column if not exists email_v2_status      text,
  add column if not exists email_v2_provider    text,
  add column if not exists email_v2_enriched_at timestamptz,
  add column if not exists email_v2_error       text;
