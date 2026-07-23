we want that when a batch is uploaded to be able to track what happened to the leads and we also need to get their program name as well, which is a manual process. 

we have chosen to make the program name enrich flow commence from the outreachready page. thus it is so that when you upload a CSV, the enriched leads that are accepted will go to the outreach ready page. They will get a tag of from which seed account they were from and when you hover the tag, you can see how many got accepted and other relevant data. 

make a plan for this in this .md

---

## Plan

**The two asks are one feature.** Program name already gets filled manually
today, on the Outreach Ready page (`outreach-composer.tsx` already has a
`funnel_program_name` field with a "Scraped: …" hint). That page is already
where a Clay-enriched lead lands — checked: `applyEnrichmentAll`'s email-found
branch never touches `status`, so a lead stays `qualified` and satisfies
Outreach Ready's own query the moment Clay finds it an email. That path
doesn't need to change.

What's missing is **visibility**: no way to see which seed account a lead came
from while filling in its program name, or how that account's Clay batch went.
So: a tag per lead showing its source account, hover shows the batch's outcome
stats. The hover *is* the tracking feature — no separate audit page, no new
upload-history table.

### Not changing
- The Clay CSV round-trip / column-mapping dialog — program name isn't part
  of that export/import.
- `applyEnrichmentAll`.
- Outreach Ready's lead-eligibility query — already correct.

### New
1. **`handover_outcomes_by_parent()`** SQL function — its own aggregate rather
   than another revision of `lead_counts_by_parent()` (already serving 3
   different consumers). Per `parent_username`: `accepted` (email_provider =
   'clay' and email is not null), `no_email` (handed back with nothing),
   `marked_bad` (joined against `rejected_leads`).
2. **`lib/handover/outcomes.ts`** — thin wrapper, returns a
   `Map<parentUsername, {accepted, noEmail, markedBad}>`.
3. **Outreach Ready page/types** — add `parent_username` to the leads query
   and `OutreachRow` (was absent), call `getHandoverOutcomesByParent()`
   directly in the page's existing `Promise.all(...)` alongside the other
   queries. No `app/actions/outreach-ready.ts` wrapper — this is a Server
   Component reading its own data, same pattern as `getSettings()` already
   used on that page; server actions are for client-triggered calls.
4. **`components/outreach/outreach-source-badge.tsx`** — mirrors
   `components/leads/source-badge.tsx`'s existing Popover pattern exactly,
   shows the three counts instead of a scrape count. Rendered per-row in
   `OutreachLeadRail`, next to the lead's name (row itself changed from a
   `<button>` to a `div[role=button]` so the badge's own Popover-trigger
   button can nest inside without invalid nested buttons).

### Verification — done
- `npx tsc --noEmit`, `eslint` on changed files, `npm run build` — all clean
  (dev server stopped first, restarted after).
- Migration applied via the Management API; `handover_outcomes_by_parent()`
  hand-verified against live data (`@mannyfrometa`: accepted=7, no_email=3,
  marked_bad=5 — matched three independent manual cross-check queries).
- Confirmed with a script hitting the live DB (mirroring the page's own
  eligibility filter) that real Outreach Ready leads carry `parent_username`
  and resolve to those same numbers, e.g. `@senseiprofe` ← `@mannyfrometa`
  (7/3/5) — the tag and its hover data will be correct once loaded in the
  browser.