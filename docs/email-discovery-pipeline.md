# Email Discovery Pipeline

Short-circuit at each step — only proceed to the next if no email was found.

---

## Step 1 — Instagram Bio

Parse the IG profile bio text for any email address using a regex match.

- **Source:** bio field from scraped IG profile
- **Exit condition:** email found → done

---

## Step 2 — External Link Detection

Check the link-in-bio URL for known aggregator patterns.

- **Patterns to match:** `linktr.ee`, `geni.us`, or similar link-in-bio services
- **Exit condition:** email found on landing page → done

### Step 2a — Extract YouTube URL from Linktree

If the URL matches a linktree-style page, visit the link (via ScrapingBee) and scan all outbound links for a YouTube channel URL.

- **Pattern to match:** `youtube.com/`, `youtu.be/`
- **Exit condition:** YouTube URL found → proceed to Step 5

---

## Step 3 — Find YouTube Profile via Link-in-Bio (ScrapingBee)

Use the extracted linktree/bio link to locate a YouTube channel directly.

- **Method:** ScrapingBee renders the JS-heavy link-in-bio page and extracts all `<a href>` targets
- **Look for:** any `youtube.com/channel/`, `youtube.com/@handle`, or `youtu.be/` URL
- **Exit condition:** YouTube channel URL found → proceed to Step 5

---

## Step 4 — Serper API Fallback Search

If no YouTube link was found through the bio/linktree, run a targeted web search.

- **Search query:** `"<Full Name from IG profile>" youtube.com`
- **Method:** Serper API (`/search`)
- **Extract:** first organic result matching `youtube.com/channel/` or `youtube.com/@`
- **Exit condition:** YouTube channel URL found → proceed to Step 5 | not found → return `no_youtube_found`

---

## Step 5 — YouTube About Page — Check for Email

Visit the YouTube channel's About page and check if an email is directly visible.

- **URL pattern:** `https://www.youtube.com/@<handle>/about`
- **Check:** scrape visible contact email (sometimes shown without captcha for logged-in or public profiles)
- **Exit condition:** email found → done | email behind captcha → proceed to Step 6

---

## Step 6 — CapSolver Captcha Bypass

If the email on the About page is behind a "Show email" captcha, call CapSolver to solve it.

- **API:** `https://www.capsolver.com/`
- **Task type:** `ReCaptchaV3TaskProbelessly` or `HCaptchaTask` depending on what YouTube serves
- **Flow:**
  1. Submit captcha task to CapSolver → receive `taskId`
  2. Poll CapSolver until `status: ready` → receive solution token
  3. Replay the "Show email" request with the solved token
  4. Extract email from response
- **Exit condition:** email extracted → done | captcha solve failed / email still hidden → return `no_email_found`

---

## Return Values

| Outcome | Value |
|---|---|
| Email found at any step | `{ email: "...", source: "ig_bio" \| "linktree" \| "yt_about" \| "yt_captcha_solved" }` |
| YouTube not found | `{ email: null, reason: "no_youtube_found" }` |
| No email on About page | `{ email: null, reason: "no_email_on_about_page" }` |
| CapSolver failed | `{ email: null, reason: "captcha_solve_failed" }` |
