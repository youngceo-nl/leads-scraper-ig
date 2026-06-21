import { inngest } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { sendEmail, gmailReady } from "@/lib/outreach/gmail";
import { textToHtml } from "@/lib/outreach/template";
import { logCrawl } from "@/lib/pipeline/persist";

export const sendOutreachBatch = inngest.createFunction(
  {
    id: "send-outreach-batch",
    name: "Send outreach emails in batch",
    retries: 0, // never auto-retry a send — duplicate emails are worse than a missed one
    concurrency: { limit: 1 }, // one batch at a time
  },
  { event: "outreach/batch.requested" },
  async ({ event, step }) => {
    const { leads: leadPayloads, interval_minutes = 20 } = event.data as {
      leads: { id: string; subject: string; body: string }[];
      interval_minutes?: number;
    };

    if (!leadPayloads?.length) return { sent: 0, failed: 0 };

    const ready = await step.run("check-gmail", () => gmailReady());
    if (!ready) throw new Error("Gmail not connected — connect it in Settings → Outreach.");

    const settings = await step.run("load-settings", () => getSettings());
    const admin = createAdminClient();

    let sent = 0;
    let failed = 0;

    for (let i = 0; i < leadPayloads.length; i++) {
      const { id: lead_id, subject, body: bodyText } = leadPayloads[i];

      const result = await step.run(`send-${i}`, async () => {
        const { data: lead } = await admin
          .from("leads")
          .select("id, username, full_name, email, outreach_count")
          .eq("id", lead_id)
          .single();

        if (!lead?.email) return { ok: false, reason: "no_email" };

        // Guard: skip if already contacted (prevents double-send if queued twice)
        if ((lead.outreach_count ?? 0) > 0) return { ok: false, reason: "already_sent" };

        const bodyHtml = textToHtml(bodyText);

        try {
          const r = await sendEmail({
            to: lead.email,
            subject,
            text: bodyText,
            html: bodyHtml,
            replyTo: settings.outreach_reply_to ?? undefined,
          });

          await admin.from("outreach_messages").insert({
            lead_id,
            to_email: lead.email,
            subject,
            body_text: bodyText,
            body_html: bodyHtml,
            status: "sent",
            message_id: r.messageId,
            gmail_thread_id: r.threadId,
          });

          await admin.from("leads").update({
            outreach_count: (lead.outreach_count ?? 0) + 1,
            last_outreach_at: new Date().toISOString(),
            last_outreach_error: null,
          }).eq("id", lead_id);

          await logCrawl({
            crawl_job_id: null,
            profile_username: lead.username,
            parent_username: null,
            action: "email_sent",
            depth: 0,
            detail: `To: ${lead.email} · Subject: ${subject} (batch ${i + 1}/${leadPayloads.length})`,
          });

          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);

          await admin.from("outreach_messages").insert({
            lead_id,
            to_email: lead.email,
            subject,
            body_text: bodyText,
            body_html: bodyHtml,
            status: "failed",
            error: msg,
          });

          await admin.from("leads").update({ last_outreach_error: msg }).eq("id", lead_id);

          await logCrawl({
            crawl_job_id: null,
            profile_username: lead.username,
            parent_username: null,
            action: "email_failed",
            depth: 0,
            status: "failure",
            detail: msg.slice(0, 200),
          });

          return { ok: false, reason: msg };
        }
      });

      if (result.ok) sent++; else failed++;

      // Sleep between sends — skip after the last one
      if (i < leadPayloads.length - 1) {
        await step.sleep(`wait-${i}`, `${interval_minutes}m`);
      }
    }

    return { sent, failed, total: leadPayloads.length };
  },
);
