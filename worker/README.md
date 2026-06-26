# Outreach video worker

Standalone Node/TypeScript process that turns a `leads` row into a personalized
outreach video and uploads it to Loom. Runs separately from the Next.js app —
see the project plan (`/Users/julian/.claude/plans/whimsical-moseying-pebble.md`)
for why (Vercel's serverless timeout can't fit a multi-minute Remotion render +
Loom upload).

## Pipeline

```
leads (existing table)
  -> video_jobs (queue row, status starts "pending")
  -> worker poll loop claims one job at a time
       generateScript        — Claude or OpenAI, whichever app_settings.scoring_provider picks
       generateVoiceMp3      — OmniVoice-Studio (default) or OpenAI TTS, loudness-normalized
       recordProspectPage    — Playwright screenshot of the lead's site
       renderRemotionVideo   — composes hook + screenshot (+ base pitch video, if uploaded) into an MP4
       uploadToLoom          — Playwright, reuses a saved login session
  -> video_jobs updated with loom_url / loom_embed_code, status "done"
```

Every stage updates `video_jobs.status` and writes a `video_job_events` row;
on failure the job is marked `failed` with `error_message` set and a debug
screenshot uploaded to the `debug-artifacts` Storage bucket (Playwright
stages only).

## Setup

```bash
cd worker
npm install
npx playwright install chromium   # if not already installed
```

Env vars are read from the main app's `../.env.local` (a worker-local `.env`
can override). See the "Personalized outreach video worker" section in the
repo root's `.env.local.example`. Claude/OpenAI API keys come from
`app_settings` in the DB (same convention as the rest of this app), not env
vars — env vars are only a fallback.

## Running

```bash
npm run worker          # from the repo root — npm --prefix worker run dev
# or, from worker/:
npm run dev              # watch mode
npm start                # one-shot
```

The worker polls `video_jobs` every `WORKER_POLL_INTERVAL_MS` (default 5s)
and processes one job at a time.

## One-time setup: Loom login

The Loom upload module needs a logged-in browser session. Loom doesn't have a
documented "upload any MP4, get a share link" API — this drives the actual
loom.com UI with Playwright, so it's the most fragile piece of the pipeline.

```bash
npm run worker:loom-login     # from the repo root
# or: cd worker && npm run upload-to-loom:login
```

This opens a real (headed) Chrome window at loom.com. Log in by hand
(including any 2FA) — **wait until you actually see your video library
loaded before switching back to the terminal**, then press Enter. The
session is saved to `LOOM_SESSION_DIR` (default `worker/loom-session/`) and
reused by every future upload — re-run this only when the session expires.

Two non-obvious things already fixed in `uploadToLoom.ts`, worth knowing if
you're debugging further:
- It launches with `channel: "chrome"` (your real installed Chrome, not
  Playwright's bundled Chromium) — bundled Chromium got silently logged back
  out by Loom on every attempt during development.
- Loom's upload flow is **not** "drop a file on the page": you have to open
  it via New video → Upload a video (an Uppy dashboard modal), set the file
  input, then click an explicit "Upload N file(s)" confirm button — Uppy does
  not auto-start on file selection. Those dropdown/confirm elements also
  don't satisfy Playwright's normal actionability checks (visible-but-not-
  "interactable" per `role`), so the code matches by text + `force: true`
  rather than `getByRole(...).click()`.

Then validate the upload module on its own, against a real video, before
trusting it inside the full pipeline:

```bash
cd worker && npm run upload-to-loom:test -- /path/to/test-video.mp4
```

**This was built and the click-through mechanics verified (login persists,
modal opens, file attaches, confirm button is found and clicked) but the
actual upload-completing-on-Loom's-end step was NOT verified end-to-end** —
in the sandboxed environment this was developed in, several third-party
domains Loom's frontend depends on for its client-side "feature gate" system
(`statsigapi.net`, `*.datadoghq.com`) returned 403s, which left Loom's JS in
a broken state where the confirm button click registered (correct element,
correct coordinates, no console errors related to the click itself) but
never triggered an actual upload request. `loom.com` itself was reachable —
just not those third-party deps. This is very likely a sandbox-only artifact
that won't occur on your normal network — **run the command above yourself
to confirm**. If it still doesn't reach a `/share/` URL within 10 minutes on
your machine, that's a real bug to chase, and the first thing to check is
whether Loom's UI changed (run with `headless: false` to watch it live).

## OmniVoice-Studio (default TTS provider)

The worker calls OmniVoice-Studio's local, OpenAI-compatible TTS endpoint
(`http://localhost:3900/v1/audio/speech` by default — see
[docs/agentic-voice.md](https://github.com/debpalash/OmniVoice-Studio/blob/main/docs/agentic-voice.md)
in that repo). Install/run OmniVoice-Studio, then in the app create a voice
profile from **the owner's own approved voice sample** (Settings → Voice
Clone) — per the compliance constraint in the project plan, never clone a
third party's voice. Set `OMNIVOICE_VOICE_ID` to that profile's id (from
`GET /v1/audio/voices`).

Until OmniVoice-Studio is set up, set `TTS_PROVIDER=openai` to use OpenAI TTS
instead — same interface, no code changes needed.

## Base pitch video

No base pitch video is recorded yet. The pipeline works without one — the
rendered video is just the personalized hook segment. Once you have one,
upload it to the `video-assets` Storage bucket and insert a row:

```sql
insert into video_assets (type, storage_path) values ('base_pitch_video', '<path-in-bucket>');
```

The worker picks up the most recent `base_pitch_video` row automatically on
its next render.
