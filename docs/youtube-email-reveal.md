# YouTube Email Reveal — How and Why

## Why YouTube is the focus for email discovery

Instagram bios almost never contain an email address. Most ICP leads publish their business email exactly one place: the **YouTube channel About page**, behind the "View email address" button. This button is the highest-yield email source in the pipeline, which is why YouTube lookups happen on every enrichment run even though we discover leads from Instagram.

---

## The two paths

### Path A — Free (public About page)

Some creators publish their email as plain text in their About description. We fetch the `/about` page through ScrapingBee (rendered JS, premium proxy) and scan for any address in the HTML or the embedded `ytInitialData` blob.

- **Cost:** ScrapingBee credits only
- **Cookie required:** No
- **CapSolver required:** No
- **Hit rate:** Low — only a minority of creators publish it openly

### Path B — Gated reveal (headless Chromium + CapSolver)

YouTube hides most business emails behind a "View email address" button that is only visible to logged-in users and triggers a reCAPTCHA Enterprise challenge when clicked. To unlock it we run headless Chromium with a live Google/YouTube session cookie, click the button, solve the CAPTCHA with CapSolver, and read the revealed address.

- **Cost:** CapSolver credits (small, ~$0.001–0.002 per solve)
- **Cookie required:** Yes — a valid `Cookie` header from a logged-in `youtube.com` session
- **CapSolver required:** Yes
- **Hit rate:** High — most creator channels that have a business email expose it here

---

## Full enrichment pipeline order

Every enrichment run walks through these steps in order and stops as soon as it finds an email:

1. **Instagram bio** — scan the bio text for a raw email address (free, instant)
2. **Bio/funnel website** — scrape the website linked in their bio or funnel page (ScrapingBee)
3. **YouTube channel** — resolve the channel URL, then:
   a. Try Path A (free public About scrape)
   b. If a "View email address" button exists, run Path B (gated reveal)

Steps 1–2 are quick checks. Step 3 is where most emails are found.

---

## Resolving the YouTube channel URL

Before we can read the About page we need the channel URL. We try these in order:

1. **Direct bio link** — if the Instagram bio links straight to YouTube, extract the channel URL
2. **Via their website** — crawl the website in their bio, look for a YouTube link (`/about`, social links, etc.)
3. **Serper Google search** — search `"[full name]" site:youtube.com` (and variations with the IG username). Requires a Serper.dev API key.

If none of these resolve a channel, YouTube enrichment is skipped and the lead goes to the churn bucket.

---

## Cookie management

The Google/YouTube session cookie is the authentication credential for Path B. It decays — Google invalidates it after weeks of inactivity or if the account gets flagged.

How cookies are managed:

- **Managed accounts** (preferred): store Google login credentials in Settings → YouTube accounts. The pipeline auto-refreshes the cookie via Playwright when it detects the existing one is dead.
- **Manual cookie** (fallback): paste a raw `Cookie` header from a logged-in browser session in Settings.

A pool of multiple accounts is supported — the pipeline tries each cookie in the pool and stops at the first that works. More accounts = less downtime when one expires.

Cookie liveness is checked before every reveal attempt. If the cookie is dead and auto-refresh fails, the pipeline surfaces an actionable error message in the UI.

---

## Required integrations (Settings page)

| Integration | Required for | Where to get it |
|---|---|---|
| **Serper.dev API key** | Finding the YouTube channel URL via Google | serper.dev |
| **YouTube session cookie** | Reading the gated email (Path B) | Log into YouTube in a browser, copy the `Cookie` header from DevTools |
| **CapSolver API key** | Solving the reCAPTCHA on "View email address" | capsolver.com |

Without Serper: channel lookup only works if the bio already links to YouTube.
Without the cookie: only Path A (free, low hit rate) runs.
Without CapSolver: clicking "View email address" fails at the CAPTCHA step.

---

## Runtime note

Path B uses Playwright (real Chromium). It cannot run inside a serverless function. It works:
- Locally (`npm run dev`) — launches Chrome on your machine
- On a worker with Chrome installed
- Against a remote browser via `BROWSER_WS_ENDPOINT` (connectOverCDP) — the only way to drive it from a serverless deployment
