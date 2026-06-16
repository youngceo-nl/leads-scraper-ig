"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { sendEmail, gmailReady } from "@/lib/outreach/gmail";
import { renderTemplate, buildLeadContext, textToHtml } from "@/lib/outreach/template";

export type RenderedOutreach = {
  to: string | null;
  subject: string;
  body: string;
  reason?: string;
};

export type SendOutreachResponse = {
  ok: boolean;
  message_id?: string;
  error?: string;
};

async function loadLeadAndSettings(leadId: string) {
  const settings = await getSettings();
  const admin = createAdminClient();
  const { data: lead, error } = await admin
    .from("leads")
    .select("id, username, full_name, niche, business_model, funnel_program_name, funnel_offer_summary, external_link, email")
    .eq("id", leadId)
    .single();
  if (error || !lead) throw new Error(error?.message ?? `Lead ${leadId} not found`);
  return { settings, lead };
}

// Pre-renders the outreach so the UI can show subject/body BEFORE the user
// confirms the send. Read-only — does not call Gmail or write any state.
export async function previewOutreach(leadId: string): Promise<RenderedOutreach> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { to: null, subject: "", body: "", reason: "unauthorized" };

  const { settings, lead } = await loadLeadAndSettings(leadId);
  const ctx = buildLeadContext({ lead, senderName: process.env.GMAIL_FROM_NAME ?? null });
  return {
    to: lead.email ?? null,
    subject: renderTemplate(settings.outreach_subject_template, ctx),
    body: renderTemplate(settings.outreach_body_template, ctx),
    reason: lead.email ? undefined : "lead has no email — run Enrich first",
  };
}

export async function sendOutreach(opts: {
  leadId: string;
  to?: string;       // override (defaults to lead.email)
  subject?: string;  // override pre-rendered subject
  body?: string;     // override pre-rendered body
}): Promise<SendOutreachResponse> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  if (!(await gmailReady())) {
    return { ok: false, error: "Gmail not connected — set up the OAuth app and click “Connect Gmail” in Settings → Outreach." };
  }

  const { settings, lead } = await loadLeadAndSettings(opts.leadId);
  const ctx = buildLeadContext({ lead, senderName: process.env.GMAIL_FROM_NAME ?? null });

  const to = (opts.to?.trim() || lead.email || "").trim();
  if (!to || !to.includes("@")) {
    return { ok: false, error: "No valid recipient email." };
  }
  const subject = opts.subject?.trim() || renderTemplate(settings.outreach_subject_template, ctx);
  const bodyText = opts.body?.trim() || renderTemplate(settings.outreach_body_template, ctx);
  const bodyHtml = textToHtml(bodyText);

  const admin = createAdminClient();
  try {
    const result = await sendEmail({
      to,
      subject,
      text: bodyText,
      html: bodyHtml,
      replyTo: settings.outreach_reply_to ?? undefined,
    });

    await admin.from("outreach_messages").insert({
      lead_id: opts.leadId,
      to_email: to,
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      status: "sent",
      message_id: result.messageId,
      gmail_thread_id: result.threadId,
      sent_by: user.id,
    });

    const { data: row } = await admin
      .from("leads")
      .select("outreach_count")
      .eq("id", opts.leadId)
      .single();
    await admin
      .from("leads")
      .update({
        outreach_count: (row?.outreach_count ?? 0) + 1,
        last_outreach_at: new Date().toISOString(),
        last_outreach_error: null,
      })
      .eq("id", opts.leadId);

    revalidatePath("/leads");
    revalidatePath(`/leads/${opts.leadId}`);
    return { ok: true, message_id: result.messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await admin.from("outreach_messages").insert({
      lead_id: opts.leadId,
      to_email: to,
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      status: "failed",
      error: msg,
      sent_by: user.id,
    });
    await admin
      .from("leads")
      .update({ last_outreach_error: msg })
      .eq("id", opts.leadId);
    revalidatePath("/leads");
    revalidatePath(`/leads/${opts.leadId}`);
    return { ok: false, error: msg };
  }
}
