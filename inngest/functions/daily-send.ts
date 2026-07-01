import { inngest } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { gmailReady } from "@/lib/outreach/gmail";
import { buildLeadContext, renderTemplate, extractFirstName } from "@/lib/outreach/template";

const DAILY_SEND_TARGET = 25;
const INTERVAL_MINUTES = 20;

// Runs at 08:00 UTC (10:00 CEST) daily. Picks the top qualified leads
// with a confirmed email that haven't been contacted yet, ordered by score.
export const dailySend = inngest.createFunction(
  { id: "daily-send", name: "Daily outreach send" },
  { event: "outreach/manual.send.requested" },
  async ({ step }) => {
    const ready = await step.run("check-gmail", () => gmailReady());
    if (!ready) return { skipped: "Gmail not connected" };

    const settings = await step.run("load-settings", () => getSettings());
    const sb = createAdminClient();

    const leads = await step.run("pick-leads", async () => {
      const { data } = await sb
        .from("leads")
        .select("id, username, full_name, niche, business_model, funnel_program_name, funnel_offer_summary, external_link")
        .in("status", ["qualified", "review"])
        .not("email", "is", null)
        .neq("email_status", "bounced")
        .eq("outreach_count", 0)
        .order("overall_score", { ascending: false })
        .limit(DAILY_SEND_TARGET);
      return data ?? [];
    });

    if (!leads.length) return { skipped: "no leads ready to send" };

    // Render templates now so the send function uses consistent content
    // (same as the manual preview flow — skips leads with no valid first name)
    const rendered = leads.flatMap((lead) => {
      if (!extractFirstName(lead.full_name as string | null)) return [];
      const ctx = buildLeadContext({ lead, senderName: settings.gmail_from_name ?? null });
      return [{
        id: lead.id as string,
        subject: renderTemplate(settings.outreach_subject_template, ctx),
        body: renderTemplate(settings.outreach_body_template, ctx),
      }];
    });

    if (!rendered.length) return { skipped: "all leads blocked — no valid first names" };

    await step.sendEvent("queue-batch", {
      name: "outreach/batch.requested",
      data: { leads: rendered, interval_minutes: INTERVAL_MINUTES },
    });

    return { queued: rendered.length, interval_minutes: INTERVAL_MINUTES };
  },
);
