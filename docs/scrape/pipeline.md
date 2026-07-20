# The pipeline — what everything is for

A reference doc, not a changelog. For *why* things changed, see `scrape.md`
through `scrape_v4.md` in this folder. This is just: what exists today, and
what each piece does.

## The flow, end to end

```
seed account
    │
    ▼
scrape following list  (crawl-seed, Apify)
    │
    ▼
dedupe / exclude        (bulkUpsertDiscoveredLeads)
    │
    ▼
insert as "pending" lead
    │
    ▼
backfill metadata       (followers, bio, recent posts — Apify)
    │
    ▼
hardFilter              (cheap, local, no AI — private/followers/bio/keywords)
    │
    ▼
metricsGate             (engagement rate, reels activity — still local)
    │
    ▼
AI scoring               (score-lead — Claude/OpenAI/etc, ICP fit)
    │
    ▼
qualified / review / rejected
    │
    ▼
handover                (Clay: find an email for qualified, no-email leads)
    │
    ▼
outreach-ready → sent
```

A lead can drop out at any stage. Everything past that point never runs for it.

## Seeds

A **seed** (`seeds` table) is an Instagram account you scrape the *following
list* of — the theory being people a good account follows are often good leads
themselves.

- `following_count` — the seed's own follow count, refreshed from a fresh
  Apify profile lookup every time a crawl starts. This is the ceiling: a scrape
  can never discover more accounts than the seed follows. If it does, the run
  fails loudly rather than silently reporting a number that can't be true.
- `max_profiles_to_scrape` — cap on how many *new* leads one crawl should aim
  for before stopping. `null` means "use the account default."
- `scrape_full_following` — ignore the cap, walk the whole following list.
  Capped internally at 5000 by the Apify actor's own behavior (see Caveats).
- A seed can only be scraped **once** while it has a completed crawl job.
  Scraping it again needs `RESCRAPE_OVERRIDE_PASSWORD` (env var) — see
  `lib/seeds/scraped.ts`. This exists to stop accidentally re-burning Apify
  credits on an account already fully processed.

## Scraping (`crawl-seed`)

**Apify is the standard provider** for pulling a following list — not the
Instagram cookie, which is a fallback only used when no Apify token is
configured. `scrapeFollowingDetailedWithFallback`
(`lib/pipeline/scrape-following.ts`) picks the provider from
`following_scraper_provider`; an explicitly chosen provider fails loudly
instead of silently falling back to a different one. Only `auto` chains
providers, and even then every downgrade gets logged.

Each page of results goes through `bulkUpsertDiscoveredLeads` immediately, so
leads start flowing into the database before the whole scrape finishes.

## Dedupe / exclusion (`bulkUpsertDiscoveredLeads`)

Before a scraped account becomes a lead row, two checks run:

1. **Excluded?** — was this username ever bulk-deleted from the leads page?
   If so it's on `excluded_usernames` and gets dropped before insert, forever
   (until someone removes it from that list). This is the only thing stopping
   a deleted lead from quietly reappearing the next time its seed (or another
   seed that also follows them) gets scraped.
2. **Already exists?** — an `upsert(..., { ignoreDuplicates: true })` on
   `username`. If the row's already there, this insert is a no-op.

The function returns `{ inserted, duplicates, excluded }` so a run knows
exactly why its raw scrape count doesn't match its net-new count.

`parent_username` on the resulting lead is **the account whose following list
produced it** — not necessarily the seed the crawl started from
(`source_seed_id`). Those two only diverge when recursion is involved (next
section). Handover, the leads-page Source badge, and the Pipeline cards all key
off `parent_username`, because it's the one that's actually true.

## Recursion (rare, manual only)

`crawl/recurse.requested` lets the pipeline walk into a *qualified* lead's own
following list, one depth deeper. Today this only fires from **manually
reprocessing a single lead** (the "Process" button on a lead's detail page,
`process-profile.ts`) — the normal automatic crawl → backfill → score-lead path
never triggers it. So most of a database's leads have `parent_username` equal
to a real seed, but a lead discovered via recursion has `parent_username` set
to whichever *other lead* was recursed into.

## Backfill (`backfill-metadata`)

Fills in what the following-list scrape doesn't have: followers, following
count, bio, external link, private/verified flags, and the last ~12 posts
(with `is_reel`/`is_pinned` flags, used later for the activity signal).

**Apify is standard here too.** The profile actor returns posts inline
(`latestPosts`), so this is one Apify call per 100 leads, not two. The
Instagram cookie is the fallback only when no Apify token exists, and only if
the cookie isn't already marked dead.

A lead counts as "backfilled" the moment `followers` is non-null — regardless
of what happens to it afterward.

## hardFilter (`lib/pipeline/filter.ts`)

Cheap, local, no API calls. Runs before anything costs money. Rejects on the
first thing it finds:

| Check | Rejection reason |
| --- | --- |
| Private account | `private_account` |
| Followers below `min_followers` | `followers_below_min (N < min)` |
| Followers above `max_followers` | `followers_above_max (N > max)` |
| No bio, or bio under 5 chars | `no_bio` |
| Zero posts ever captured | `no_recent_posts` |
| Bio/name/username matches an exclude keyword | `excluded_keyword:<word>` |
| Bio doesn't match any include keyword (if any are set) | `no_include_keyword_match` |
| Bio matches junk pattern (meme/fanpage/news/gossip) | `junk_keyword_in_bio` |

`no_recent_posts` now means **"has ever posted"** — not "recently active."
Recency moved to the metrics gate below, so this stays a cheap existence check.

## metricsGate (`lib/pipeline/filter.ts`)

Still local, still free — computed from the posts backfill already fetched.

- **Engagement rate** below `min_engagement_rate` → `engagement_below_min`.
- **Reels in the last 30 days** below `min_reels_last_30_days` →
  `reels_30d_below_min`. This is the actual activity signal — a dormant
  account with old posts still on file won't pass this even though it clears
  `no_recent_posts`.
- Reels-recency only applies once **at least 3 reels were actually scraped**
  (`MIN_REEL_SAMPLE_FOR_RECENCY`). A thin sample (dead cookie, scraper gap)
  defers to AI scoring instead of hard-rejecting a lead we just couldn't see
  clearly.

## `hard_filter_passed_at`

A timestamp, set only by the **manual Filter action** on the Pipeline page. It
marks "passed hardFilter + metricsGate, waiting on AI" as a durable, queryable
state. The *automatic* pipeline (crawl → backfill → score-lead) never sets
this — it runs both gates and AI scoring in one pass and has no need to park a
lead in between.

## AI scoring

Two separate entry points, both landing on the same `ClaudeScore` shape:

- **`score-lead`** (`lead/score.requested`) — the standard, lightweight path.
  Scores off data already in the row (no fresh scraping). Fired automatically
  by backfill for every lead it just touched, and by the manual **AI Verify**
  action.
- **`process-profile`** (`crawl/profile.discovered`) — the heavier manual path
  used by the "Process" button: fresh profile+posts scrape, then the same
  gates, then scoring, then recursion if qualified.

Both run `hardFilter` → `metricsGate` → AI classification, in that order, and
both write the same fields:

```
icp_fit_score, traction_score, monetization_score, activity_score,
overall_score, niche, business_model, offer_type, audience_type,
reason_for_score, recommended_action → status
```

`recommended_action` (`qualified` / `review` / `reject`) becomes `status`
directly. **Every rejection write — hard filter, metrics gate, or AI — clears
`reason_for_score` and `recommended_action`.** Skipping that on a re-processed
lead is exactly the bug that made `@pierree`'s "AI verified" count read wrong
during v4's build (see `scrape_v4.md`); it's now enforced at every write site.

## Handover

Once a lead is `qualified` (or `review`) with no email, it's eligible for
**handover** — batches of up to 15 leads copied out to Clay's email-finder
waterfall, then imported back with (or without) a found email.

Batches are keyed by **`parent_username`**, same reasoning as everywhere else:
a batch means "this account's actual followings," not "whatever a crawl
starting here happened to touch." One open batch per account at a time,
enforced in the database. Leads with no `parent_username` at all (manual
imports, CSV adds) land in a single "Unattributed" bucket rather than being
invisible.

## Outreach

Downstream of handover: `/outreach-ready` lists qualified leads with a usable
email that haven't been contacted, lets you review/edit the generated
subject+body, and sends via Gmail. Outside the scope of this doc — see
`components/outreach/` if you need the details.

---

## The Pipeline page (`/logs`) — funnel glossary

Each seed gets a card with a **funnel row** and a **per-run history**. These
are two different scopes and answer different questions:

| | Scope | Source |
| --- | --- | --- |
| Funnel row (card header) | This seed's **whole history**, right now | Current lead-table state |
| Expanded run rows | **One specific crawl**, as it happened | That run's own counters |

### Funnel row stages

| Stage | What it counts | Why it can be `—` |
| --- | --- | --- |
| **found** | The seed's `following_count` — the ceiling | Unknown until a scrape has fetched it fresh |
| **duplicates removed** | Scraped accounts that were already in `leads` | Summed only from runs that both recorded it *and* actually scraped something — see worked example |
| **excluded** | Scraped accounts on the bulk-delete exclusion list | Same |
| **new** | `count(*)` of leads with this `parent_username`, ever | Always known — current DB state |
| **backfilled** | Of those, how many have `followers` populated | Always known |
| **filtered** | Of those, passed hardFilter+metricsGate — went to AI, or manually pre-filtered and waiting | Always known |
| **AI verified** | Of those, actually scored by AI (`reason_for_score` set) | Always known |

### Worked example — reading a real card

This is `@pierree`'s actual card on `/logs` right now:

```
@pierree   3 ok · 3 failed
  — found · — duplicates removed · — excluded · 462 new · 462 backfilled · 30 filtered · 17 AI verified
```

Reading it left to right, against the sections above:

- **`3 ok · 3 failed`** — of his 6 crawl runs ever, 3 finished (**Scraping**),
  3 didn't (bad Apify call, cancelled, etc.). Nothing to do with leads yet.
- **`— found`** — no crawl has started for this seed *since* the
  `following_count` column existed, so nothing has fetched his current follow
  count yet. Not "we don't know his follow count" — it's "this card hasn't
  been told to check." The next scrape of `@pierree` fills this in.
- **`— duplicates removed` / `— excluded`** — none of his 6 runs happened after
  these two counters existed, so there's genuinely nothing measured to sum.
  Two things worth spelling out, because both were wrong at different points
  while this doc was being written:
  - A run that scraped 500 accounts and found 0 *new* leads (his
    `2026-07-19 16:31` run) is **not** the same as a run that measured 0
    duplicates — every one of those 500 had to be a duplicate or an exclusion,
    that count was just never recorded. A run only counts as having measured
    anything if `found + duplicates + excluded` actually accounts for
    everything it scraped — under current code those three always sum to what
    was scraped, so if they read 0 while `profiles_scraped` doesn't, the run
    predates tracking, full stop.
  - Even a *correctly-measured* run doesn't earn a real number on its own if it
    scraped nothing (a run cancelled instantly, say) — 2 of his 6 runs are like
    that. Summing only those two would produce a technically-true "0" that
    still says nothing about the 1,772 real accounts his other 4 runs
    (untracked) actually scraped. So the seed-level number only counts as real
    once the runs backing it collectively scraped *something* — otherwise it
    stays a dash even though a "measured" run exists.
- **`462 new`** — `count(*)` of leads with `parent_username = 'pierree'` in the
  table right now. This is cumulative across every scrape of him, ever,
  including the ones from before today's counters existed — which is why it's
  a real number and not a dash. See **Dedupe / exclusion**.
- **`462 backfilled`** — all 462 have `followers` populated. See **Backfill**.
  Equal to `new` here means backfill has fully caught up; on a seed with a
  gap (e.g. `@yusufertabak`: 145/1,027), that gap is exactly what the
  **Backfill** action targets.
- **`30 filtered`** — of those 462, 30 have been through **hardFilter** +
  **metricsGate** (survived, and either went to AI already or are parked at
  `hard_filter_passed_at` waiting to). The other 432 are backfilled leads that
  are *either* already rejected by an earlier automatic pass, *or* genuinely
  untouched — the **Filter** action's target is specifically the untouched
  subset, `status = 'pending'` ones, not "462 minus 30."
- **`17 AI verified`** — of those 30 filtered, 17 have actually been scored
  (**AI scoring**, `reason_for_score` set). The remaining `30 − 17 = 13` passed
  the filter and are sitting ready — that's exactly what the **AI Verify**
  action's count would show for this seed right now.

`—` always means *"never measured,"* never a hidden zero. `found`/`duplicates`/
`excluded` can only be measured once a run has actually recorded them (today
onward for duplicates/excluded; the moment a crawl starts for found).
`new`/`backfilled`/`filtered`/`verified` are computed from current lead state,
so they're never stale in this way — that's precisely why the "backfilled"
figure used to dash out on old runs, and now doesn't.

`found` and `new` will basically never match exactly, even at full coverage:
`found` is a **live snapshot** (the seed's follow count *today*); `new` is a
**historical accumulation** across every scrape of that seed, on whatever days
they happened. People unfollow, get deleted, or go private in between. The gap
between them (`found − new`) is the informative number — how much of the
current pool still isn't in the database.

### The three manual actions

Each seed's card has a selector (Backfill / Filter / AI Verify) and a
**Start** button — selecting never runs anything by itself.

| Action | What it does | Cost | Targets |
| --- | --- | --- | --- |
| **Backfill** | Fetch followers/bio/posts via Apify | Apify credits | `parent_username` leads with `followers IS NULL`, not already erroring/rejected |
| **Filter** | Run hardFilter+metricsGate locally | Free (no API calls) | Backfilled, `pending`, never filter-checked |
| **AI Verify** | Fan out `lead/score.requested` | AI credits (~$0.0001/lead) | Passed Filter, `pending`, never scored |

None of the three touch a lead that's already been rejected — nothing
re-litigates a past decision or re-spends credits on it.

## Caveats worth knowing

- **The Apify following-actor has an undocumented ceiling.** `resultsLimit`
  above ~5000 makes it return an empty dataset instead of erroring. Full-account
  scrapes are capped at 5000 for exactly this reason — don't raise it without
  re-testing (see `scrape.md`).
- **The Instagram cookie is dead and that's fine.** Apify covers both the
  following scrape and backfill; the cookie is only a fallback if no Apify
  token exists. The old "scraping will fail" banner only shows now when that's
  actually true.
- **Re-scraping an already-scraped seed needs `RESCRAPE_OVERRIDE_PASSWORD`.**
  Set as an env var, not in `app_settings` — deliberately not visible from the
  Settings page.
- **`.update()` vs `persistLead()`'s full-row upsert.** `persistLead` (used by
  `process-profile`) always writes every scoring field, explicitly nulling
  what's absent — so it can't go stale. Anywhere that uses a narrower
  `.update()` with a specific field list (like `score-lead`'s rejection paths)
  has to remember to null the fields a full-row write would have cleared for
  free. Worth checking for this pattern before adding another narrow-update
  write path.
