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
