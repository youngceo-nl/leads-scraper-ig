# Scrape & backfill pipeline

State of the scraping path as of 2026-07-19, the bugs found while verifying it,
and the two decisions still open.

## The pipeline

```
scrape following  ->  backfill metadata  ->  hardFilter  ->  AI score  ->  qualified  ->  handover
   (Apify)              (Apify)              (local)        (Claude/etc)
```

A lead only reaches handover if it survives `hardFilter` **and** scores well.
Most losses happen at `hardFilter`, before any AI spend.

## What was fixed

**Full-account crawls returned nothing.** `FULL_ACCOUNT_TARGET` was 50000. The
actor advertises `resultsLimit` up to 500000 but above ~5000 exits SUCCEEDED
with an empty dataset. Measured against `@pierree` (650 following):

| resultsLimit | duration | items |
| ------------ | -------- | ----- |
| 500          | 7.2s     | 500   |
| 5000         | 22.0s    | 649   |
| 7500         | 9.2s     | **0** |
| 50000        | 2.1s     | **0** |

Now 5000. **Do not raise without re-testing the actor** — it fails silently.

**Backfill preferred a dead cookie.** Path selection was `useFreePath = !!entry`,
and `pickCookie` only screens out *rate-limited* cookies, not dead ones. A dead
cookie won the choice and backfill retried it forever instead of falling back.
Apify is now the standard path; the cookie is the fallback and must not be
marked dead.

**Apify backfill guaranteed 100% rejection.** `scrapeProfiles` hardcoded
`recent_posts: []`, and `hardFilter` rejects empty `recent_posts` as
`no_recent_posts`. Every Apify-backfilled lead was dead on arrival. The profile
actor already returns `latestPosts` inline — it was being discarded. Now mapped
via `mapLatestPosts()`, still one actor run.

**Provider reporting lied.** The activity drawer inferred "Playwright" from
"0 scraped and still running", so every Apify crawl displayed as Playwright.
Both the drawer and `crawl-seed`'s cookie-exhaustion tracking now key off the
provider that actually ran.

## Decision 1 — what `no_recent_posts` should mean ✅

Actieve reels is wel goeie indicator 
En engagement 

**Done.** Reels + engagement are now the activity signal. `metricsGate()` could
already reject on both, but `mapLatestPosts()` never set `is_reel`/`is_pinned`,
so `reels_last_30_days` was always 0 and the gate sat inert. Both flags are now
mapped from the Apify payload (`productType === "clips"`, `isPinned`), and
`min_reels_last_30_days` is **1** (was 0) — migration
`20260719030000_reels_activity_gate.sql`.

`hardFilter`'s `no_recent_posts` check stays as a cheap "has ever posted" guard;
the real activity judgement now happens in `metricsGate`. Accounts with fewer
than 3 sampled reels are still never rejected on recency
(`MIN_REEL_SAMPLE_FOR_RECENCY`), so a thin scrape defers to scoring.

Verified live: `@bridger_rogers` → 12 reels, 1 pinned, `reels_last_30_days=1`,
now rejected as `engagement_below_min (0.0007 < 0.005)` — a real judgement
instead of a data gap.

## Decision 2 — re-process leads rejected by the bug ❌ (parked)

**1,771** leads are rejected as `no_recent_posts`; **1,748** of those have empty
`recent_posts` *and* clear the 5,000-follower minimum. They were rejected
because Apify never supplied posts, not on their merits — 31% of all 5,683
rejections.

Re-processing costs Apify credits (one profile-actor run per 100 leads).
Suggested approach: **sample 50 first**, measure how many now pass, then decide
on the rest. `@pierree` proves both kinds exist — some are genuinely inactive,
some were wrongly killed.

this is ok, stick with 50 first, we'll go from there

**Sample of 50 run.** Reset to `pending` and re-run through backfill -> scoring
with posts now populated. 33 of 50 resolved, 17 still in the scoring queue:

| outcome                    |  n | reading                                  |
| -------------------------- | -: | ---------------------------------------- |
| still pending (scoring)    | 17 | backfilled with posts, awaiting AI score |
| `no_include_keyword_match` | 15 | real ICP judgement                       |
| `engagement_below_min`     |  8 | real, mostly 0.001–0.004 vs 0.005 floor  |
| `reels_30d_below_min`      |  5 | the new reels gate firing                |
| `followers_below_min`      |  4 | followers came back 0 — dead/renamed     |
| `no_recent_posts`          |  1 | genuinely has no posts                   |

**Qualified so far: 0 of 33 resolved.** The fix works — only 1 of 50 still hits
`no_recent_posts`, versus 50 of 50 before — but these leads are now being
rejected for *real* reasons rather than a data gap. On this evidence the
remaining ~1,700 are unlikely to yield much: the dominant rejections are
keyword-match and engagement, neither of which the bug caused.

### ❌ Not doing this — parked deliberately

The remaining ~1,700 stay as they are. Effort goes into making the pipeline
correct from here forward, not into salvaging old records. The evidence supports
it: 0 of 33 resolved sample leads qualified, and the rejections that dominate
(`no_include_keyword_match`, `engagement_below_min`) were never caused by the
bug — those leads would have been rejected anyway.

Re-open only if the pipeline starts producing far fewer qualified leads than
expected, which would suggest the gates are wrong rather than the leads.

Caveat on the numbers above: the 50 sampled ids were not recorded before the
script was deleted, so the sample can no longer be isolated by query — a later
re-count by timestamp sweeps in unrelated work. The 0-of-33 figure is as
measured at the time and cannot be tightened after the fact.

## Known-good settings

- `following_scraper_provider`: `apify` (default and current value)
- `APIFY_FOLLOWING_ACTOR`: `scraping_solutions~instagram-scraper-followers-following-no-cookies`
- `APIFY_PROFILE_ACTOR`: `apify~instagram-profile-scraper` (returns `latestPosts`)
- `min_followers`: 5000 · `max_followers`: 500000
- `min_posts_last_30_days`: 0 (inactive — see Decision 1)

## Open issues not yet addressed

- **IG cookie is dead.** ✅ Doesn't block Apify scraping or backfill, but the
  `auto` provider chain and any cookie path still depend on it.

we won't be using IG cookie in the forseeable future.

**Done.** The banner claimed *"Instagram cookie is expired — scraping will
fail"*, which was untrue while Apify is configured. Both cookie banners on
`/leads` are now gated on `!apifyConfigured`, so they only appear when Apify
genuinely can't cover the work. Cookie code is left in place as the fallback for
when no Apify token exists.

- **`logCrawl` isn't wrapped in `step.run`** ✅, so Inngest replays duplicate it —
  a single page logged three identical lines. Cosmetic.

this seems technical. fix if necessary or helpful.

**Done.** The page-loop `logCrawl` in `crawl-seed.ts` is now inside
`step.run("log-page-N", …)`, so Inngest memoises it and replays no longer
re-write the row.

- **`source_seed_id` means "seed the crawl originated from", not "whose
  following list this came from".** ✅ `@pierree` shows 1,039 leads but only 461
  are his followings; 578 came from recursing into `@bridger_rogers`. Handover
  blocks inherit this. Fix would be to scope by `parent_username`.

yes fix this for sure, pierree only has 650 following and you said we scraped 1039 leads from him? That's bullshit.

**Done.** Everything user-facing now groups by `parent_username`:

- Migration `20260719040000_handover_by_parent.sql` replaces
  `handover_batches.seed_id` with `parent_username` and re-points the
  one-open-batch index. Safe as a straight swap — the table had 0 rows.
- `lib/handover/overview.ts` groups by `parent_username`; `batch.ts` and
  `app/actions/handover.ts` key every function on it.
- **The 1,039 you saw was the leads-table Source badge**, which counted by
  `source_seed_id`. It now counts by `parent_username`, so `@pierree` reads his
  actual followings and recursion-derived leads are credited to the account they
  really came from.
- Scraped seeds with an empty pool still get a block, and a new
  **Unattributed** block covers the 271 handover-eligible leads with no parent
  (imports, manual adds) that were previously unreachable. 19 blocks -> 22.