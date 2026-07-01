import { inngest } from "@/inngest/client";
import { enrichPipelineV2 } from "@/lib/pipeline/enrich-pipeline-v2";
import { createAdminClient } from "@/lib/supabase/admin";
import { logCrawl, logError } from "@/lib/pipeline/persist";

// Validation runner for the V2 enrichment pipeline — same fan-out pattern as
// enrich-email.ts, but calls enrichPipelineV2 (writes email_v2/* columns)
// instead of testingEnrichPipeline. Lower concurrency than V1 since this path
// also hits the Instagram mobile "contact email" endpoint, which is more
// rate-limit sensitive than the bio/YouTube-only V1 checks.
export const enrichEmailV2 = inngest.createFunction(
  {
    id: "enrich-email-v2",
    name: "Validate V2 email enrichment pipeline",
    retries: 1,
    concurrency: [{ limit: 2 }],
  },
  { event: "lead/email-v2.enrich.requested" },
  async ({ event }) => {
    const { lead_id } = event.data;

    const { data: lead } = await createAdminClient()
      .from("leads")
      .select("username, crawl_depth, parent_username")
      .eq("id", lead_id)
      .single();

    try {
      const r = await enrichPipelineV2({ leadId: lead_id, force: true });
      await logCrawl({
        crawl_job_id: null,
        profile_username: lead?.username ?? lead_id,
        parent_username: lead?.parent_username ?? null,
        action: r.email ? "email_v2_found" : "email_v2_not_found",
        depth: lead?.crawl_depth ?? 0,
        detail: r.email ? `${r.email} (${r.source})` : (r.error ?? "no public email found"),
      });
      return { ok: r.ok, source: r.source, email: r.email };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError({
        context: "enrich.email_v2",
        error_message: msg,
        payload: { lead_id },
        crawl_job_id: null,
      });
      throw err;
    }
  },
);
