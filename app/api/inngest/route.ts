import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { crawlSeed } from "@/inngest/functions/crawl-seed";
import { processProfile } from "@/inngest/functions/process-profile";
import { recurseFollowing } from "@/inngest/functions/recurse-following";
import { enrichFunnel } from "@/inngest/functions/enrich-funnel";
import { enrichEmail } from "@/inngest/functions/enrich-email";
import { backfillMetadata } from "@/inngest/functions/backfill-metadata";
import { scoreLead } from "@/inngest/functions/score-lead";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [crawlSeed, processProfile, recurseFollowing, enrichFunnel, enrichEmail, backfillMetadata, scoreLead],
});
