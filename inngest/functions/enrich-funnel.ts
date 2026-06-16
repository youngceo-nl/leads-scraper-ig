import { inngest } from "@/inngest/client";
import { enrichFunnelForLead } from "@/lib/funnel/enrich";
import { createAdminClient } from "@/lib/supabase/admin";
import { getJobStatus, logCrawl, logError } from "@/lib/pipeline/persist";

export const enrichFunnel = inngest.createFunction(
  {
    id: "enrich-funnel",
    name: "Enrich lead with funnel/program info",
    retries: 2,
    concurrency: [
      { limit: 4, key: "event.data.crawl_job_id" },
      { limit: 8 },
    ],
  },
  { event: "lead/funnel.enrich.requested" },
  async ({ event, step }) => {
    const { lead_id, external_link, crawl_job_id } = event.data;

    if (crawl_job_id) {
      const status = await step.run("check-job-status", () => getJobStatus(crawl_job_id));
      if (status === "cancelled" || status === "failed") {
        return { skipped: status };
      }
    }

    const lead = await step.run("load-lead", async () => {
      const { data } = await createAdminClient().from("leads").select("username, crawl_depth, parent_username").eq("id", lead_id).single();
      return data;
    });

    try {
      const result = await step.run("enrich-funnel", () =>
        enrichFunnelForLead({ leadId: lead_id, externalLink: external_link }),
      );
      await logCrawl({
        crawl_job_id: crawl_job_id ?? null,
        profile_username: lead?.username ?? lead_id,
        parent_username: lead?.parent_username ?? null,
        action: result.funnel_program_name ? "funnel_found" : "funnel_not_found",
        depth: lead?.crawl_depth ?? 0,
        detail: result.funnel_program_name
          ? `${result.funnel_program_name}${result.funnel_platform ? ` (${result.funnel_platform})` : ""}`
          : (result.error ?? "no offer found"),
      });
      return { ok: result.ok, platform: result.funnel_platform, program: result.funnel_program_name };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError({
        context: "enrich.funnel",
        error_message: msg,
        payload: { lead_id, external_link },
        crawl_job_id: crawl_job_id ?? null,
      });
      throw err;
    }
  },
);
