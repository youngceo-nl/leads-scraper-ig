-- Personalized outreach video automation: queue table for the standalone
-- worker (script -> TTS -> screen capture -> Remotion render -> Loom upload),
-- a diagnostic event trail, and a table for reusable global assets (base
-- pitch video, voice sample) that don't exist per-lead.

create table if not exists public.video_jobs (
  id                       uuid primary key default gen_random_uuid(),
  lead_id                  uuid not null references public.leads(id) on delete cascade,
  status                   text not null default 'pending'
    check (status in (
      'pending', 'generating_script', 'generating_audio', 'recording_profile',
      'rendering_video', 'uploading_to_loom', 'done', 'failed'
    )),
  hook_script              text,
  audio_path               text,
  screen_recording_path    text,
  rendered_video_path      text,
  rendered_video_storage_url text,
  loom_url                 text,
  loom_embed_code          text,
  error_message            text,
  attempt_count            integer not null default 0,
  locked_at                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists video_jobs_lead_idx   on public.video_jobs (lead_id, created_at desc);
create index if not exists video_jobs_status_idx on public.video_jobs (status);

create table if not exists public.video_job_events (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.video_jobs(id) on delete cascade,
  event_type  text not null,
  message     text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists video_job_events_job_idx on public.video_job_events (job_id, created_at);

create table if not exists public.video_assets (
  id           uuid primary key default gen_random_uuid(),
  type         text not null check (type in ('base_pitch_video', 'voice_sample')),
  storage_path text,
  public_url   text,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

drop trigger if exists touch_video_jobs on public.video_jobs;
create trigger touch_video_jobs
  before update on public.video_jobs
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- Storage buckets — private; the worker (service role) and the app's signed
-- URLs are the only readers/writers.
-- =============================================================================
insert into storage.buckets (id, name, public)
values
  ('video-assets',      'video-assets',      false),
  ('generated-audio',   'generated-audio',   false),
  ('screen-recordings', 'screen-recordings', false),
  ('rendered-videos',   'rendered-videos',   false),
  ('debug-artifacts',   'debug-artifacts',   false)
on conflict (id) do nothing;

-- =============================================================================
-- RLS — same convention as 0002_rls.sql (single-tenant tool: any
-- authenticated user can read/write, service role bypasses RLS).
-- =============================================================================
alter table public.video_jobs       enable row level security;
alter table public.video_job_events enable row level security;
alter table public.video_assets     enable row level security;

do $$
declare
  t text;
begin
  for t in
    select unnest(array['video_jobs', 'video_job_events', 'video_assets'])
  loop
    execute format('drop policy if exists "%1$s_select" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_modify" on public.%1$s', t);
    execute format('create policy "%1$s_select" on public.%1$s for select to authenticated using (true)', t);
    execute format('create policy "%1$s_modify" on public.%1$s for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
