okay, we want a telegram or imessage workflow that pulls link and uses a scraping bee enrichment to get the data to get openai to analyze a lead. the scraping bee needs to have multiple accounts to get enough free credits for the month. The rest of the current flow needs to be left alone.

---

## What this pipeline does

A manual trigger workflow that runs alongside the existing automated pipeline — does not touch it.

1. **Input:** Paste an IG profile link into Telegram or iMessage
2. **Enrichment:** ScrapingBee fetches the profile (`scrapeProfileWithPostsViaScrapingBee`)
3. **Analysis:** OpenAI (`classifyWithOpenAi`) scores the lead — niche, business model, ICP signal
4. **Output:** Result returned back to the chat
5. **Multi-account SB:** Multiple ScrapingBee API keys rotate for more free credits (reuses the `key-pool.ts` pattern from `lib/email/key-pool.ts`)

## What's already in place

- `lib/scrapingbee/instagram.ts` — profile scraping via ScrapingBee
- `lib/openai/classify.ts` — OpenAI lead classification
- `lib/email/key-pool.ts` — rotating API key pool (same pattern applies to SB keys)
- `app/api/enrich/[leadId]/route.ts` — existing webhook-style enrichment endpoint

## What needs to be built

| Piece | Complexity |
|---|---|
| SB multi-key pool (reuse `key-pool.ts` pattern) | Low |
| `POST /api/manual-lead` — accepts a URL, scrapes + classifies, returns JSON | Low–Medium |
| Telegram bot (webhook → endpoint above) | Medium |
| iMessage shortcut (iOS Shortcut → endpoint above) | Low (no code, just config) |

## Recommended order

Build the API endpoint first — it's the common backbone for either channel. Then wire up Telegram or iMessage on top.
