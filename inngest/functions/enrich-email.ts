import { inngest } from "@/inngest/client";
import { enrichLeadPipeline } from "@/lib/pipeline/enrich-pipeline";
import { createAdminClient } from "@/lib/supabase/admin";
import { getJobStatus, logCrawl, logError } from "@/lib/pipeline/persist";

export const enrichEmail = inngest.createFunction(
  {
    id: "enrich-email",
    name: "Enrich lead with public email sources",
    retries: 2,
    concurrency: [
      { limit: 3, key: "event.data.crawl_job_id" },
      { limit: 4 },
    ],
  },
  { event: "lead/email.enrich.requested" },
  async ({ event, step }) => {
    const { lead_id, crawl_job_id } = event.data;

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
      const r = await step.run("enrich", () => enrichLeadPipeline({ leadId: lead_id }));
      await logCrawl({
        crawl_job_id: crawl_job_id ?? null,
        profile_username: lead?.username ?? lead_id,
        parent_username: lead?.parent_username ?? null,
        action: r.email ? "email_found" : "email_not_found",
        depth: lead?.crawl_depth ?? 0,
        detail: r.email ? `${r.email} (${r.source})` : (r.error ?? "no public email found"),
      });
      return { ok: r.ok, source: r.source, email: r.email, linkedin: r.linkedin_url };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError({
        context: "enrich.email",
        error_message: msg,
        payload: { lead_id },
        crawl_job_id: crawl_job_id ?? null,
      });
      throw err;
    }
  },
);
