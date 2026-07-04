import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { crawlSeed } from "@/inngest/functions/crawl-seed";
import { processProfile } from "@/inngest/functions/process-profile";
import { recurseFollowing } from "@/inngest/functions/recurse-following";
import { enrichFunnel } from "@/inngest/functions/enrich-funnel";
import { enrichEmail } from "@/inngest/functions/enrich-email";
import { enrichEmailV2 } from "@/inngest/functions/enrich-email-v2";
import { backfillMetadata } from "@/inngest/functions/backfill-metadata";
import { scoreLead } from "@/inngest/functions/score-lead";
import { retryBlockedLeads } from "@/inngest/functions/retry-blocked-leads";
import { refreshYtCookie } from "@/inngest/functions/refresh-yt-cookie";
import { refreshIgCookies } from "@/inngest/functions/refresh-ig-cookies";
import { sendOutreachBatch } from "@/inngest/functions/send-outreach-batch";
import { sendFollowupBatch } from "@/inngest/functions/send-followup-batch";
import { dailyBounceCheck } from "@/inngest/functions/daily-bounce-check";
import { batchWatchdog } from "@/inngest/functions/batch-watchdog";
import { skoolImport } from "@/inngest/functions/skool-import";

// dailyScrape and dailySend are intentionally NOT registered here — their
// triggers were broken for weeks (see git history) and are now fixed, but
// they're paused pending review before being allowed to auto-crawl/auto-send.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [crawlSeed, processProfile, recurseFollowing, enrichFunnel, enrichEmail, enrichEmailV2, backfillMetadata, scoreLead, retryBlockedLeads, refreshYtCookie, refreshIgCookies, sendOutreachBatch, sendFollowupBatch, dailyBounceCheck, batchWatchdog, skoolImport],
});
