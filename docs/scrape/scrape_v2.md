rejection_reason isn't cleared when a lead later qualifies. Leads show as qualified / no_recent_posts, which corrupts exactly the kind of funnel analysis you'd use to tune the gates. ✅

**Fixed.** `score-lead.ts`'s `persist-scored` wrote ~20 fields but never
`rejection_reason`, so a previously-rejected lead kept its stale reason after
qualifying. `process-profile.ts:121` already cleared it correctly — the two
scoring paths simply disagreed. score-lead now matches it, and the **38** rows
already carrying a stale reason were cleared (`0` remain).

posts_30d_below_min is firing while min_posts_last_30_days is 0. A zero threshold shouldn't reject anything, so either the setting isn't being read or the comparison is off. ✅

**Not a live bug — no code change needed.** `posts_30d_below_min` appears
nowhere in the codebase; the gate that produced it was removed earlier. The
values survived only because of the bug above, which never cleared them. They
went with the 38-row cleanup.

`min_posts_last_30_days` has now been **deleted** (migration
`20260720010000_drop_min_posts_setting.sql`) — no gate read it, and its form
field was parsed by `app/actions/settings.ts` but never rendered anywhere, so it
could not even be changed. The unrelated metric `leads.posts_last_30_days`
stays: it is computed by `computeMetrics()` and shown on the leads table.

we want to have proper logs of when a scrape happens that shows us who the seed account is, what is happening to the accounts. ✅

**Built: live funnel per scrape run, on `/logs` (Activity).**

```
scrape @pierree · running
  649/649 found · 144/649 backfilled · 130/144 filtered · 14/130 AI verified
```

Each stage is measured against the previous one, so drop-off is visible at a
glance. The card polls every 4s **only while a run is active**, so an idle page
doesn't hammer the database.

Why the old logs couldn't answer this: `crawl_logs` has 13 action types but only
4 ever appeared in practice, and `crawl_jobs.profiles_scraped` / `new_leads` are
written once in crawl-seed's final step — so they read 0 for the entire run,
which is exactly the window worth watching.

- Migration `20260720000000_scrape_run_counters.sql`: four counters on
  `crawl_jobs` plus a `bump_crawl_counters()` SQL function.
- Increments are **atomic via RPC**, not read-modify-write: score-lead fans out
  and runs leads concurrently, so JS-side increments would lose counts. Verified
  with 5 concurrent bumps — none lost.
- Wired where each stage already logs: `crawl-seed` (found, per page),
  `backfill-metadata` (backfilled, per batch), `score-lead` (filtered when both
  gates pass, verified after scoring). `crawl_job_id` already propagated across
  all three, so no new plumbing.
- Work done outside a run (manual re-scores) passes a null job id and counts
  toward no run.

Not built, from the thread below: per-account live status strings ("Checking
socials", "Finding email") and the separate logs-reading agent. Ask if you want
the per-account view next.

[7/20/26, 1:24:16 AM] Alex Yefimov: python script met logs
[7/20/26, 1:24:34 AM] Alex Yefimov: dan kan AI zelf ook onafhankelijk testen
[7/20/26, 1:24:43 AM] Alex Yefimov: bedoel je dat?
[7/20/26, 2:05:04 AM] ~ YM: Helemaal opnieuw beginnen en vanaf begin voor logs vragen dan doet de ai het wel goed
[7/20/26, 2:05:15 AM] ~ YM: Nu gaat die cirkeltjes maken
[7/20/26, 6:37:40 AM] ~ Martinus Duineveld: Alsin je wil live de status zien van waar hij mee bezig is?

Dus bijv
“Looking up website”
“Checking socials”
“Finding email”
Etc
[7/20/26, 9:04:26 AM] Arne Wessel: Zoals iedereen al aangeeft moet ie makkelijk bij de logs kunnen zodat ie weet wat ie moet fixen
[7/20/26, 9:05:10 AM] Arne Wessel: Soms helpt het ook om te vragen wat ie nou precies aan het doen is en zelf ff na te gaan welke stappen logischer wijs doorlopen moeten worden en dat m stap voor stap te laten uitwerken
[7/20/26, 9:46:55 AM] Max Van Moorsel: Waarom vibe coden jullie niet een custom agent er voor cc kan dat makkelijk, gebruik gwn open router en bun met typescript en met open router maak je het gwn voor ieder model dus kun je het ook nog goedkoop maken
[7/20/26, 9:47:37 AM] Max Van Moorsel: Flikker er een database bij en nog een losse web app en boem
[7/20/26, 10:45:20 AM] Wisse: een agent voor wat?
[7/20/26, 10:46:13 AM] Max Van Moorsel: Dit
[7/20/26, 10:46:25 AM] Wisse: een aparte app maken die altijd logs pakt
[7/20/26, 10:47:49 AM] Max Van Moorsel: Ja. De pipe line is gwn dan een llm chain maar dan met tools die je hem zelf geeft je kan dan echt alles doen wat je wilt
[7/20/26, 10:48:10 AM] Max Van Moorsel: Dus gwn een custom harnas eigelijk
take this as insipration 

