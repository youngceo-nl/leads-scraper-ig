"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { sendEmail, gmailReady } from "@/lib/outreach/gmail";
import { renderTemplate, buildLeadContext, textToHtml } from "@/lib/outreach/template";
import { logCrawl } from "@/lib/pipeline/persist";
import { gmailSearch, gmailGetMessage } from "@/lib/google/gmail-api";

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

    await logCrawl({
      crawl_job_id: null,
      profile_username: lead.username,
      parent_username: null,
      action: "email_sent",
      depth: 0,
      detail: `To: ${to} · Subject: ${subject}`,
    });

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

    await logCrawl({
      crawl_job_id: null,
      profile_username: lead.username,
      parent_username: null,
      action: "email_failed",
      depth: 0,
      status: "failure",
      detail: msg.slice(0, 200),
    });
    revalidatePath("/leads");
    revalidatePath(`/leads/${opts.leadId}`);
    return { ok: false, error: msg };
  }
}

export type CheckBouncesResult = {
  ok: boolean;
  bounced: number;
  checked: number;
  error?: string;
};

// Search Gmail for NDR (bounce) messages and mark matching sent emails as bounced.
// Matches NDRs to outreach_messages via the RFC Message-Id stored in the
// NDR's In-Reply-To header.
export async function checkEmailBounces(): Promise<CheckBouncesResult> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, bounced: 0, checked: 0, error: "unauthorized" };

  if (!(await gmailReady())) {
    return { ok: false, bounced: 0, checked: 0, error: "Gmail not connected — connect it in Settings → Outreach." };
  }

  const admin = createAdminClient();

  // Load sent messages that have a stored RFC Message-Id and a username for logging
  const { data: sent } = await admin
    .from("outreach_messages")
    .select("id, lead_id, to_email, message_id, leads(username)")
    .eq("status", "sent")
    .not("message_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(200);

  if (!sent?.length) return { ok: true, bounced: 0, checked: 0 };

  // Index by RFC Message-Id for O(1) lookup.
  // PostgREST returns joined relations as arrays even for to-one FKs.
  type SentRow = { id: string; lead_id: string; to_email: string; message_id: string; leads: { username: string }[] | null };
  const byMessageId = new Map<string, SentRow>(
    (sent as unknown as SentRow[])
      .filter(m => m.message_id)
      .map(m => [m.message_id, m])
  );

  // Search Gmail for NDR/bounce messages (inbox only, last 90 days)
  const ndrIds = await gmailSearch(
    "from:(mailer-daemon OR postmaster) newer_than:90d",
    100
  );

  let bounced = 0;
  const now = new Date().toISOString();

  for (const gmailId of ndrIds) {
    const msg = await gmailGetMessage(gmailId);
    if (!msg?.inReplyTo) continue;

    const match = byMessageId.get(msg.inReplyTo.trim());
    if (!match) continue;

    await Promise.all([
      admin
        .from("outreach_messages")
        .update({ status: "bounced", bounced_at: now })
        .eq("id", match.id),
      admin
        .from("leads")
        .update({ email_status: "bounced" })
        .eq("id", match.lead_id),
    ]);

    await logCrawl({
      crawl_job_id: null,
      profile_username: match.leads?.[0]?.username ?? "",
      parent_username: null,
      action: "email_bounced",
      depth: 0,
      status: "failure",
      detail: `Bounce detected for ${match.to_email}`,
    });

    bounced++;
  }

  revalidatePath("/leads");
  return { ok: true, bounced, checked: ndrIds.length };
}
