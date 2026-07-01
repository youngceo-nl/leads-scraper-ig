import { inngest } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { sendEmail, gmailReady } from "@/lib/outreach/gmail";
import { textToHtml } from "@/lib/outreach/template";
import { logCrawl } from "@/lib/pipeline/persist";

export const sendFollowupBatch = inngest.createFunction(
  {
    id: "send-followup-batch",
    name: "Send follow-up emails in batch",
    retries: 0,
    concurrency: { limit: 1 },
  },
  { event: "outreach/followup-batch.requested" },
  async ({ event, step }) => {
    const { leads: leadPayloads, interval_minutes = 20 } = event.data as {
      leads: { id: string; to: string; subject: string; body: string; inReplyTo?: string; threadId?: string }[];
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
      const { id: lead_id, to, subject, body: bodyText, inReplyTo, threadId } = leadPayloads[i];

      const result = await step.run(`followup-${i}`, async () => {
        const { data: lead } = await admin
          .from("leads")
          .select("id, username, followup_count")
          .eq("id", lead_id)
          .single();

        if (!lead) return { ok: false, reason: "lead_not_found" };
        if ((lead.followup_count ?? 0) > 0) return { ok: false, reason: "already_followed_up" };

        const bodyHtml = textToHtml(bodyText);

        try {
          const r = await sendEmail({
            to,
            subject,
            text: bodyText,
            html: bodyHtml,
            replyTo: settings.outreach_reply_to ?? undefined,
            inReplyTo,
            references: inReplyTo,
            threadId,
          });

          await admin.from("outreach_messages").insert({
            lead_id,
            to_email: to,
            subject,
            body_text: bodyText,
            body_html: bodyHtml,
            status: "sent",
            message_id: r.messageId,
            gmail_thread_id: r.threadId,
            email_type: "followup",
          });

          await admin.from("leads").update({
            followup_count: 1,
            last_followup_at: new Date().toISOString(),
          }).eq("id", lead_id);

          await logCrawl({
            crawl_job_id: null,
            profile_username: lead.username,
            parent_username: null,
            action: "followup_sent",
            depth: 0,
            detail: `To: ${to} · Subject: ${subject} (followup ${i + 1}/${leadPayloads.length})`,
          });

          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);

          await admin.from("outreach_messages").insert({
            lead_id,
            to_email: to,
            subject,
            body_text: bodyText,
            body_html: bodyHtml,
            status: "failed",
            error: msg,
            email_type: "followup",
          });

          await logCrawl({
            crawl_job_id: null,
            profile_username: lead.username,
            parent_username: null,
            action: "followup_failed",
            depth: 0,
            status: "failure",
            detail: msg.slice(0, 200),
          });

          return { ok: false, reason: msg };
        }
      });

      if (result.ok) sent++; else failed++;

      if (i < leadPayloads.length - 1) {
        await step.sleep(`wait-${i}`, `${interval_minutes}m`);
      }
    }

    return { sent, failed, total: leadPayloads.length };
  },
);
