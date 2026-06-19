# Pipeline Debug Plan

Current state (2026-06-19):
- 74 qualified leads, 21 with email (53 not_found)
- 24 leads missing follower data (need backfill)
- ScrapingBee quota hit → scraping blocked
- YouTube "View email" reveal failing for most leads
- Inngest itself is working (jobs run, but dev server loses queue on restart)

---

## 1. Lead Scraping

### 1a — Fix ScrapingBee quota block
- **Problem**: ScrapingBee hit 1000 call/month limit → all `scraped` actions fail with 401
- **Fix**: Either upgrade the ScrapingBee plan, or remove ScrapingBee dependency from the scraping path and use direct Instagram session cookies instead
- **Checkpoint**: Trigger a scrape on a seed → crawl_logs shows `scraped` with `status=success`

### 1b — Verify Apify actor runs end-to-end
- **Problem**: Several crawl_jobs have `status=failed` with no error stored
- **Fix**: Add error logging to catch and store Apify actor errors in crawl_jobs.error
- **Checkpoint**: Start a scrape job → job reaches `status=completed`, new leads appear in table

### 1c — Verify new leads get scored automatically
- **Checkpoint**: New leads from scrape appear with a score, not stuck at `status=pending`

---

## 2. Backfill

### 2a — Verify Apify backfill actor works
- **Problem**: 24 leads have no follower data; backfill jobs were showing stale (Inngest queue loss)
- **Fix**: Confirm the Apify profile actor is not hitting quota/auth errors
- **Checkpoint**: Trigger "Backfill metadata (24)" → leads get followers/bio populated within a few minutes

### 2b — Backfill error visibility
- **Problem**: When backfill fails, there's no visible error on the lead row
- **Fix**: Surface `backfill_error` field in the leads table UI
- **Checkpoint**: A failed backfill shows a reason on the lead row

---

## 3. Email Enrichment

### 3a — YouTube cookie / CapSolver (highest impact)
- **Problem**: "View email" reveal failing on most YouTube channels — either cookie expired or captcha not solved
- **Fix**: Refresh YouTube session cookie in Settings, verify CapSolver key is active
- **Checkpoint**: Single lead with a YouTube channel → enrichment returns `email_status=found` via YouTube

### 3b — Hunter.io key
- **Problem**: Unclear if Hunter key is set; 53 leads came back `not_found` even with domains available
- **Fix**: Check `hunter_api_key` is set in app_settings; test a single lookup
- **Checkpoint**: Lead with a personal domain → enrichment finds email via Hunter

### 3c — Bulk re-enrich without email (53 leads)
- **Problem**: 53 qualified leads have `email_status=not_found` — many from before YouTube was prioritised
- **Fix**: After 3a + 3b are confirmed working, trigger "Re-enrich without email (53)" from ··· menu
- **Checkpoint**: Count drops from 53 toward 0 over ~30 min as Inngest works through them

---

## Order to tackle

1. **3a** (YouTube cookie) — biggest lever, unblocks email for most leads
2. **3b** (Hunter key) — quick config check
3. **3c** (bulk re-enrich) — only after 3a+3b confirmed
4. **1a** (ScrapingBee) — unblocks new lead intake
5. **2a** (backfill) — fill gaps in existing leads
6. **1b / 1c** (scraping errors + auto-score) — polish after basics work
