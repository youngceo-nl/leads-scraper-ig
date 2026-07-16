# Ideal Customer Profiles (ICPs)

The lead scoring system (`lib/*/classify.ts`, `lib/scoring/compute.ts`) scores every scraped profile
against **two** ICPs below. Keep this doc in sync with the actual prompts — the prompts are the
source of truth for what the AI scores against; this doc explains *why*.

---

# ICP #1 — Infopreneurs / High-Ticket Coaches

Source: https://webinar-offer-site.vercel.app/
Saved for use when tuning the lead scoring system.

---

## Who We're Looking For

**High-ticket B2C coaches, consultants, and information product operators** who:

- Generate **~$50k–$75k+/month** (established but not yet at $100k/mo)
- Have an **existing engaged audience** — Instagram, YouTube, or email list
  - Engagement matters far more than follower count
- Sell a **high-ticket offer at $500+ USD** through sales calls
- Have **sales capacity** (or willingness to build a team) to handle more calls
- Are **able and willing to record videos and present live**

---

## Fast Disqualifiers

- No engaged audience AND no advertising budget
- Offer under $500 with no upsell path
- Unwilling to record videos or present live
- No capacity to handle increased call volume

---

## Pain Points They Experience

- Growing an audience that doesn't convert into qualified leads
- Content creation overwhelm — constantly feeding the machine
- Uncertainty and cost of paid ads
- Chasing DMs with low conversion rates
- Pressure to discount to close deals
- Sparse sales calendars, low close rates
- Relying on artificial scarcity (fake urgency)

**Root causes:**
- Weak authority positioning
- Offer perceived as interchangeable
- No real urgency mechanism
- Insufficient differentiation from competitors

---

## What They Want

- A calendar full of **pre-sold, qualified sales calls** — without chasing anyone
- **Fast cash collection** ($100k+ within days of a launch)
- Ability to launch **organically without ad spend**
- Freedom from the content creation treadmill
- Becoming the authority in their niche
- A **repeatable, systematized** launch process
- A sales team closing warm, pre-sold leads

---

## The Four Fit Metrics (System Viability)

| Metric | Benchmark |
|---|---|
| Registration / opt-in volume | Low hundreds (proof-of-concept) → thousands (scale) |
| Show rate | 17%+ cold organic · 40%+ warmer audiences |
| Booking rate | Meaningful % of attendees booking calls |
| Close rate | Higher existing close rate = better fit |

**Formula:** Registrations × Show rate × Booking rate × Close rate = clients closed

---

## Fast Qualifying Checklist (7 Questions)

1. High-ticket B2C operator at $50k–$75k+/mo?
2. Engaged audience or usable email list?
3. Offer at $500+ (or sub-$500 with a clear upsell)?
4. Experiencing the pain points above?
5. Willing to record videos and present live?
6. Sales capacity available or being built?
7. Open to organic-first, then paid scale strategy?

---

## Scoring Signals to Prioritize

When evaluating Instagram profiles against this ICP, weight these signals highly:

| Signal | Why It Matters |
|---|---|
| Sells a coaching/consulting/info product | Core offer type |
| Has sales call CTA in bio or funnel | Signals high-ticket, call-based sales |
| Bio link leads to a webinar / VSL / opt-in | Matches the funnel type we serve |
| Niche is coaching, consulting, e-commerce, real estate, music, brand-building | Aligns with existing client roster |
| Engagement rate high relative to follower count | "Engagement matters far more than follower count" |
| Shows authority signals (case studies, testimonials, client results) | Fits "authority deficiency" pain point |
| Mentions DM-based sales or manual outreach | Direct pain point we solve |
| Revenue indicators ($50k–$100k/mo language) | Revenue sweet spot |

**De-prioritize or reject:**
- Affiliate marketers with no own offer
- Pure e-commerce / physical product brands
- Accounts with very high followers but no engagement (bought following)
- Offers under $500 with no upsell signal
- Purely B2B (we target B2C coaches)

---

# ICP #2 — Ad/Sales Agencies

Added when the ICP was broadened to include B2B service agencies alongside infopreneurs.
Source of truth: `lib/groq/classify.ts` (identical prompt in `lib/claude/classify.ts`,
`lib/gemini/classify.ts`, `lib/openai/classify.ts`).

## Who We're Looking For

An **ad/sales agency** sells marketing, advertising, or sales services — media buying, funnel
building, appointment setting, lead generation, SMMA, sales consulting — to **other businesses
(B2B)**, not consumers.

## Scoring Signals

| icp_signal | Criteria |
|---|---|
| **strong** | Visible client results, case studies, testimonials, or a clear "DM/book a call to work with us" offer |
| **moderate** | Right industry (marketing/ad/sales agency) but the offer or proof is unclear — no visible client results |
| **weak / reject** | Agency with no visible client results, case studies, or B2B offer — just a name/logo, or a service business unrelated to marketing/sales (restaurant, salon, contractor, transport) |

**business_model mapping:** `agency` (same enum value as any other service-based business — the
classify prompt explicitly instructs the model to use `agency` for ad/sales/marketing agencies
rather than inventing a separate category).

**Scoring weight:** `lib/scoring/compute.ts` scores `agency` at the same monetization weight as
`course`/`coaching` (+2), up from an earlier +0.5 — an agency with strong signals scores comparably
to an infopreneur, not as an afterthought.

---

## How to View These Leads Today

No dedicated "ICP type" filter exists in the leads UI (`components/leads/filter-bar.tsx`) — use the
existing `business_model` and `status` filters to separate the two ICPs:

- **ICP #1 (Infopreneurs):** `business_model` = `course` or `coaching`, `status` = `qualified` or `review`
- **ICP #2 (Ad/Sales Agencies):** `business_model` = `agency`, `status` = `qualified` or `review`
