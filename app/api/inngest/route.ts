import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { crawlSeed } from "@/inngest/functions/crawl-seed";
import { processProfile } from "@/inngest/functions/process-profile";
import { recurseFollowing } from "@/inngest/functions/recurse-following";
import { backfillMetadata } from "@/inngest/functions/backfill-metadata";
import { scoreLead } from "@/inngest/functions/score-lead";
import { retryBlockedLeads } from "@/inngest/functions/retry-blocked-leads";
import { refreshIgCookies } from "@/inngest/functions/refresh-ig-cookies";
import { batchWatchdog } from "@/inngest/functions/batch-watchdog";

// dailyScrape is intentionally NOT registered here, permanently. Accounts are
// scraped once and re-scraping takes the override password (lib/seeds/scraped.ts),
// so scheduled crawling has no role left — every scrape is a deliberate click.
// Do not add it back without revisiting that policy.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [crawlSeed, processProfile, recurseFollowing, backfillMetadata, scoreLead, retryBlockedLeads, refreshIgCookies, batchWatchdog],
});
