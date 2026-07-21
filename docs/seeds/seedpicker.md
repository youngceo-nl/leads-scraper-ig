## Human language of this scope
we want to have a section on the source accounts page with suggested seed accounts. 

good seed accounts are 
https://www.instagram.com/pierree/
https://www.instagram.com/kishanslings
@Pierree because he's a friend of brezscales and in correlation follows a lot of infopreneurs
@Kishanslings because he's a sales agency in the info space 
Now, I believe that the sales agency one is better recognizable before apify scrape because of the bio. But nonetheless, this is for a recommended section and is thus subject to human curation. 

so we want to have a function in the app that goes through all the accounts we have and decides which it is going to put on the recommended section. 

### Suggested seed accounts section (Source Accounts page) ✅

**Goal:**
Add a "Recommended" section to the Source Accounts page, populated by a 
function that scans existing accounts and surfaces good seed-account 
candidates for human curation (not auto-added — a human picks from the list).

**What makes a good seed account (examples):**

1. **@pierree** — https://www.instagram.com/pierree/
   - Good because: personal/social connection to an existing known-good 
     seed (brezscales), and his following list correlates heavily with 
     infopreneurs
   - Signal type: network correlation (who they follow overlaps with 
     known-good seeds' followings)

2. **@kishanslings** — https://www.instagram.com/kishanslings
   - Good because: runs a sales agency operating in the info-product space
   - Signal type: bio/profile content (agency type detectable from bio text)
   - Note: this signal is recognizable *before* an Apify scrape even runs, 
     since it's visible from the bio alone — cheaper/earlier signal than 
     network correlation

**Desired behavior:**
- New function that evaluates existing accounts in the system against 
  these signal types (network correlation + bio/profile content) and 
  ranks/flags candidates
- Output surfaces in a "Recommended" section on the Source Accounts page
- This is a suggestion layer only — final decision stays with human curation, 
  nothing gets auto-added as a seed

**Shipped:** a "Recommended source accounts" card at the top of /seeds (5 at a time), a "Mark bad" action with an inline are-you-sure confirm, and a "Bad seeds" table at the bottom with Restore. Nothing is auto-added — every candidate needs an explicit "Add as seed" click.

**Important finding on the two signal types:** true network correlation ("who they follow overlaps with known-good seeds' followings", the @pierree signal) turned out to be **uncomputable from existing data** — the app never recorded the full who-follows-whom graph, only a single parent per discovered account (`leads.parent_username`, first-writer-wins), so multi-seed overlap for anything already scraped is unrecoverable. Added a new `following_edges` table that records every edge at scrape time going forward, backfilled with the ~7,248 single edges `parent_username` still had (real overlap only starts accruing from here). The bio/business_model signal (the @kishanslings case) needed no new infrastructure — the AI classifier already tags `business_model='agency'` from bio text alone. Both feed one transparent score in `lib/seeds/recommend.ts`: business-model weight (agency highest) + ICP fit score + overall score + following-list size (capped) + seed-overlap bonus. Verified live: top 5 real candidates all scored ICP=10 with correct provenance (e.g. `@mannyfrometa`, found via `@brezscales`).

**Questions:**
- 👉 Where does "accounts we have" come from — is there an existing table/list 
  of all scraped or known accounts to run this function against, or does 
  Claude need to locate it? 👈 **Answered:** the `leads` table — every account the system has ever scraped, already enriched with `business_model`/`icp_fit_score`/`overall_score` by the AI classifier. No new table needed for the candidate pool itself.
- 👉 Should the two signal types (network correlation vs. bio content) be 
  weighted/scored separately and combined, or should Claude propose a 
  scoring approach? 👈 **Answered:** combined into one score — see the scoring breakdown above and the comment block at the top of `lib/seeds/recommend.ts`.
- 👉 Any known accounts that are explicitly NOT good seeds, to use as 
  negative examples? (optional, but helps calibrate the function) 👈 make a fuction where you can mark an account as shit seed, then with an are you sure? And then on the bottom of the page will be a table with only shit seeds (will be used to train the system later)
- 👉 Roughly how many candidates should the Recommended section show at 
  once — top 5? top 10? no cap? 👈 yeah 5 at a time is good