alter table public.leads
  add column if not exists youtube_url           text,
  add column if not exists youtube_lookup_error  text;

create index if not exists leads_youtube_url_idx on public.leads (youtube_url);
