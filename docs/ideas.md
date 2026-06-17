# Ideas

## IP Rotator for Instagram scraping

Wire up a rotating proxy to `fetchProfileMetadataDirect` so the backfill never hits IP-level rate limits.

**What we have:**
- Cookie pool with round-robin rotation (`lib/instagram/cookie-pool.ts`)
- Free direct fetch scraper (`lib/instagram/direct.ts`)
- Cookie-based provider in `scrape-profile.ts` (just added)

**What's missing:**
- `instagram_proxy_url` field in `AppSettings` (`lib/types.ts`)
- DB migration for the new column
- `undici` `ProxyAgent` in `fetchProfileMetadataDirect` — pass the proxy URL per-request so each fetch goes through a different IP
- Settings form field for the proxy URL
- The Playwright scraper already handles `proxyUrl` (same format), so that path is already covered

**Expected format:** `http://user:pass@rotating-proxy-host:port`

**Why:** With 10-20 cookies + IP rotation, there's no practical rate limit ceiling. The backfill of 2500+ leads could finish in under an hour at zero Apify cost.

**Cheapness angle:** Only route through the proxy when Instagram returns a 429 (reactive), instead of using it for every request (proactive). This minimizes proxy bandwidth cost while still breaking through rate limits when they hit.
