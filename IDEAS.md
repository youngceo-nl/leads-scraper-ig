# Ideas Backlog

## Automated Seed Discovery

**Concept:** Info operators are the best seed accounts (e.g. @joshsklein, @pierree) because they follow other info operators — which is exactly the ICP. Instead of manually adding seeds, automate finding them.

**How it would work:**
1. Use Serper to search Instagram for accounts with bio keywords like "info operator", "course creator", "online business", "coaching program"
2. Filter by follower count (above a threshold)
3. Auto-add qualifying accounts as seeds
4. They run through the normal scrape → backfill → score pipeline

**Why it works:** An info operator's following list is a goldmine of ICP leads.

---

## Manual Lead Input

**Concept:** When you come across an account organically (e.g. someone you see in comments, a DM, a recommendation), manually submit their username and let the app check if they're ICP.

**How it would work:**
1. Input field on the leads page — enter a username or Instagram URL
2. App scrapes the profile, runs it through the hard filter + scoring pipeline
3. Lead appears in the table with a status just like any auto-scraped lead

---

## Seed Discovery from Existing Datapool

**Concept:** Instead of always finding seeds externally, use the leads already in the database. Qualified leads who themselves follow a lot of info operators are good seed accounts — they're already vetted ICP and their following list is likely full of similar profiles.

**How it would work:**
1. Filter qualified leads with high follower counts and strong ICP score
2. Suggest them as potential seed accounts with a "Use as seed" button on the lead detail page
3. One click adds them to Source Accounts and kicks off a scrape

**Why it works:** Bootstraps seed discovery from data already collected — no external search needed, and the quality of the following list is likely high since the account is already ICP-qualified.

---

## Churn Bucket (No Email Found, ICP Qualified)

**Concept:** Qualified leads where no email could be found get stuck — they're good prospects but can't be reached automatically. Instead of letting them rot, put them in a dedicated view so you can process them manually.

**How it would work:**
1. Separate view/filter for leads that are: `status = qualified` + `email IS NULL` + enrichment attempted
2. You periodically review these and handle them through your manual outreach flow (DM, comment, etc.)

**Why it works:** Keeps your qualified pipeline clean and makes sure no good lead falls through the cracks just because their email wasn't findable.


## being able to see what the scrape is doing (eg. 148 accounts found 140 duplicates 8 new accoutns added to the database)

---

## Efficient & Cheap Lead Analysis

**Context:** The LLM is already only used for classification (niche, business model, offer type) — all numeric scores are computed locally for free. The bottleneck is how many leads unnecessarily reach the LLM.

### Levers (cheapest first):

**1. Tight `include_keywords` (free, biggest impact)**
If not configured, everything that passes the hard filter hits the LLM. Keeping keywords like "coach, course, info operator, online business" tight is the single highest-leverage cost reduction — no code changes needed.

**2. Metric fast-reject before LLM (free)**
If all computed metrics are terrible (engagement dead, no posts last 30 days, follower count at the floor), auto-reject without an LLM call. The LLM can't save a dead account. Add a `metricsAutoReject` check before `scoreProfileRouted`.

**3. Bio hash caching (near-free)**
Many accounts copy-paste the same bio template. Store a `sha256(bio)` → classification result in a DB table. Cache hit = zero LLM cost. Cache miss = normal LLM call + store result.

**4. OpenAI Batch API (50% cheaper)**
Queue classification calls and submit them via OpenAI's Batch API instead of per-lead real-time calls. Results come back async (up to 24h), but for background enrichment this is fine. Halves LLM cost with no quality change.

**5. Two-tier model routing**
Use haiku/gpt-4o-mini for obviously borderline cases and a stronger model only when the bio is rich/ambiguous. Simple heuristic: bio length < 50 chars → mini model; longer/more complex → normal model.

## email finder idea
https://getprospect.readme.io/reference/publicapiemailcontroller_publicfindemail

Het enige wat daar nog aan hoeft te gebeuren is dat er consistent een YouTube session cookie draait en dat hij het remote kan runnen zonder dat je je laptop aan hoeft te houden
Clay gebruikt deze providers als email finder waterfall: (aan de hand van domein + full name, en soms ook LinkedIn url)
,
Findymail, Hunter, Prospeo, Kitt, Datagma, Wiza, Icypeas, Enrow, Leadmagic
![Dit zijn de inputs om email te vinden via Clay
De ‘work email”](<Scherm­afbeelding 2026-06-15 om 13.10.23.png>)

Voor ‘personal email’ vinden gebruikt hij deze providers:

rb2b.com

Mixrank

RocketReach

Data Labs

Aviato 

ContactOut

Limadata

Forager

check if deze tools die Clay gebruik niet te duur zijn dat het misschien beter zou zijn om een ander iets te gebruiken
Een LinkedIn email finder API

---

## YouTube Google Account Strategy (for cookie-based email reveal)

**Context:** The headless Chromium + CapSolver flow needs a logged-in Google/YouTube session cookie. The quality of that account affects how long the cookie stays valid and whether YouTube flags the scraping activity.

### New account vs aged profile

**New account (fresh Gmail)**
- Free to create, no risk to existing identity
- YouTube may require phone verification or show more CAPTCHAs for new accounts
- Higher chance of getting flagged/suspended faster because no watch history, subscriptions, or normal usage patterns
- Cookie TTL may be shorter (Google refreshes sessions more aggressively for inactive accounts)
- Good for initial testing — low stakes if it gets banned

**Aged profile (older Gmail with activity)**
- Google trusts older accounts with established activity more
- Fewer CAPTCHAs, more stable cookies, longer session TTL
- Much harder to get flagged for occasional scraping if the account looks like a real user
- Can buy aged accounts (~$5–20) or use a personal secondary Gmail
- Long-term this is the better option

**Decision:** Testing with new accounts first. If sessions expire too fast or CAPTCHA rates become a problem, switch to aged accounts. Goal is eventually to run this remotely (server/worker) without needing the laptop on, with a stable long-lived cookie.

**Note:** Store the cookie in Settings UI (yt_google_cookie field), not just .env.local — so it can be refreshed without a server restart.

