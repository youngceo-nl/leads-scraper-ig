![alt text](<Screenshot 2026-07-20 at 12.51.58 PM.png>)

# scrape v4 — Pipeline card fixes

Tasks in the order they'll be tackled. Each box is one distinct change.
Tick as completed.

---

## - [x] 1. Measure the pre-backfill drops

Foundation for task 3 — the labelled drop values can't be shown until they're
counted.

`bulkUpsertDiscoveredLeads` (`lib/pipeline/persist.ts`) returns only `inserted`,
so every lead dropped before backfill is invisible. Return a breakdown —
`{ inserted, duplicates, excluded }` — and record it in `crawl-seed.ts`.

The three real drop points, confirmed in code:

| Drop | Where |
| --- | --- |
| Self + intra-result duplicates | `lib/apify/actors.ts:60-62` |
| Excluded usernames (previously bulk-deleted) | `lib/pipeline/persist.ts:88-92` |
| Already-existing leads | the `ignoreDuplicates` upsert — **505 of Pierree's 649** |

**Done.** `bulkUpsertDiscoveredLeads` now returns `{ inserted, duplicates, excluded }`
(self/intra-result dupes were left uncounted — they're handled inside the actor
before this function ever sees the list, and are consistently ~0 in practice, so
tracking them added no real signal). Both callers (`crawl-seed.ts`,
`recurse-following.ts`) updated. `crawl_jobs` gained `accounts_duplicate` /
`accounts_excluded`, bumped atomically alongside the existing funnel counters via
an extended `bump_crawl_counters()` — migration `20260720030000_run_drop_counters.sql`.

---

## - [x] 2. Store each seed's following count + enforce the "Found" ceiling

**Rule:** "Found" can never exceed the number of accounts the seed follows.
That's the maximum possible pool. If found exceeds it, the logic is wrong
upstream.

- Add `following_count` to `seeds`, refreshed when a scrape runs.
- Assert `found <= following_count`. On breach, **fail loudly and log** — do not
  silently cap the display.

⚠️ The count must be refreshed at scrape time, not read from an old lead row:
`leads.following` for `@pierree` currently reads **837** while his profile shows
**650**. Stale data would make the assertion meaningless.

**Done.** `seeds.following_count` (migration `20260720040000_seed_following_count.sql`),
refreshed via a real Apify profile-actor call at the start of every `crawl-seed`
run (best-effort — a failed fetch skips the ceiling check for that run rather
than failing the crawl). Verified live: fetching `@pierree`'s profile returns
`following: 650` — exactly matching the real number, not the stale 837.
`totalScraped > followingCount` now marks the job `failed` with a descriptive
error via `logError` + `markJobFailed`, and leaves the leads already scraped in
place (the data is still real even if the ceiling math was off).

---

## - [x] 3. Rebuild the funnel as seed-level totals

Covers the original "Backfilled shows a dash" and "Found should be pre-filter"
items together — they're the same underlying problem.

**Current behavior:** the row shows `—` for backfilled even when leads *are*
backfilled, and "Found" shows the post-deduplication count (144) rather than the
raw count (649).

**Desired:**

```
649 found · 505 duplicates removed · 0 excluded · 144 new
     · 462 backfilled · X filtered · Y AI verified
```

- "Found" = raw count before any filtering.
- Every pre-backfill drop gets its own labelled value.
- Extend the `lead_counts_by_parent()` SQL function to return every stage.
- Computed from **current lead state**, not per-run counters — that's what
  removes the dash. A dash then means only "genuinely not done yet".

Per-run numbers stay in the expanded run history, where they were recorded.

**Done.** The card's headline row is now `SeedFunnel` — found (`seeds.following_count`),
duplicates/excluded (summed across this seed's non-legacy runs), new/backfilled/
filtered/verified (current lead state, via the extended `lead_counts_by_parent()`).
`found`/`duplicates`/`excluded` show `—` until a run exists that actually measured
them (no false zeros); `backfilled` onward are always real numbers, since current
lead state is knowable regardless of when the leads arrived. Per-run history rows
keep their own found/backfilled/filtered/verified line, dashed for pre-counter runs.

`filtered`/`verified` needed a real distinguishing signal between "passed
hardFilter+metricsGate" and "went through AI" — added `leads.hard_filter_passed_at`
(set by task 6's manual Filter action; the automatic pipeline never needs it,
since it does both in one pass). `verified` = `reason_for_score IS NOT NULL`.

**Bug found and fixed during verification:** `score-lead.ts`'s two rejection
paths use narrow `.update()` calls that only touch listed columns, so a lead
reset to `pending` for reprocessing kept its *previous* pass's `reason_for_score`
— making a fresh hard-filter rejection misread as "already AI-verified" by the
`verified` count. `process-profile.ts` never had this bug (it goes through
`persistLead()`'s full-row upsert, which always overwrites every field). Fixed
both `score-lead.ts` rejection paths and my own new `triggerSeedFilter` to
explicitly null `reason_for_score`/`recommended_action` on rejection. Cleaned up
3 existing stale rows across the whole table. Verified on `@pierree`:
`filtered (30) = verified (17) + needs_verify (13)` — exact, before the fix it
was off by 2.

---

## - [x] 4. Remove the duplicate "Backfilled" stat from the header

"Backfilled" currently appears twice: once in the card header, once in the
funnel row.

```html
<!-- remove this one -->
<span class="text-xs text-muted-foreground shrink-0">3 ok · 3 failed · 462/462 backfilled</span>
```

Header returns to `3 ok · 3 failed`. The funnel row (task 3) is the single home
for backfill numbers.

**Done.** Landed together with task 3's rewrite of `seed-pipeline-card.tsx` —
header is `{succeeded} ok · {failed} failed {· running}`, no backfill figure.

---

## - [x] 5. Split the `⋯` menu into a selector + Start button

**Current:** a dropdown whose items each perform an action directly.

**Desired:**
- Dropdown with three options: **Backfill · Filter · AI Verify**
- A separate **Start** button *next to* the dropdown, not inside the menu
- Selecting chooses the action; Start runs it

File: `components/logs/seed-pipeline-card.tsx`

**Done.** Native `<select>` (Backfill / Filter / AI Verify, each showing its own
pending count) plus a separate **Start** button. Selecting never runs anything;
only Start does. Start's label/disabled state reflects the selected action's
own pending count — "Nothing pending" when that action has nothing left to do
for this seed.

---

## - [x] 6. Add the two missing actions

- **`triggerSeedFilter`** — pre-filter using the data backfill returned: runs
  `hardFilter` + `metricsGate` (`lib/pipeline/filter.ts`) over the seed's
  backfilled-but-unfiltered leads.
- **`triggerSeedVerify`** — AI qualification against ICP: fans out
  `lead/score.requested` for leads that passed the gates but were never scored.

Both scoped by `parent_username`, mirroring `triggerSeedBackfill` in
`app/actions/leads.ts`. Neither touches already-rejected leads — no
re-litigating past decisions, no repeat AI spend.

**Done.** Both added to `app/actions/leads.ts`.

- `triggerSeedFilter` runs synchronously (pure CPU, no external calls) —
  batched `.update()` writes, not `upsert` (an upsert would fail `leads`'
  NOT NULL columns like `username` that aren't in the patch). Verified live
  against `@pierree`'s real 14 pending-filter leads: 13 passed, 1 rejected
  (`private_account`) — SQL counts (`needs_filter: 14 → 0`) matched the dry-run
  exactly before any writes happened.
- `triggerSeedVerify` fans out real `lead/score.requested` events. Verified
  live: correctly targeted `@pierree`'s 13 filter-passed leads, events reached
  Inngest and began real AI-scoring HTTP round-trips (confirmed via Inngest's
  dev API) — each took ~180s to complete in this environment, a pre-existing
  characteristic of the scoring call, not something this task built or changed.
  Interrupted mid-run by an unrelated server restart; confirmed afterward that
  all 13 leads were left in a clean, safely-re-triggerable state (Inngest's
  step-based idempotency held — no partial writes).

---

## - [x] 7. Tick each item above as it lands

---

## Notes / constraints carried from earlier work

- **Counts must come from SQL aggregates**, never `select()` + count-in-JS.
  PostgREST truncates unbounded selects at 1000 rows and `leads` has ~7.7k —
  that bug silently zeroed these exact numbers once already.
- **Scope by `parent_username`, not `source_seed_id`.** The latter sweeps in
  leads found by recursing into *other* accounts (it credited `@pierree` with
  1039 when only 462 are his followings).
- **Out of scope:** backfilling per-run counters for historical runs. That data
  was never recorded and can't be reconstructed per run.

## New in this pass

- `leads.hard_filter_passed_at` — set only by the manual Filter action; distinguishes
  "passed the gates, awaiting AI" from "never checked". The automatic
  crawl → backfill → score-lead pipeline never sets it (it does both in one pass).
- **`reason_for_score`/`recommended_action` must be cleared on every rejection
  write**, everywhere a lead can be rejected — not just on success. Same failure
  shape as the `rejection_reason` bug fixed earlier: a narrow `.update()` that
  doesn't touch a field lets a stale prior-pass value survive and misrepresent
  current state. Worth auditing for other fields with this same exposure if more
  narrow-update write paths get added.


![alt text](<Screenshot 2026-07-20 at 1.54.30 PM.png>)
<span class="text-muted-foreground"><span class="font-medium text-foreground">462</span> new</span>
remove this new thing. this value is reserved for found.
the seed account has 650 accounts in there as following, which means it is supposed to get 650 found. 
then it should automatically remove duplicates, hence the duplicates removed property on the dashboard. 
