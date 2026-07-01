"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { sendEmail, gmailReady } from "@/lib/outreach/gmail";
import { renderTemplate, buildLeadContext, textToHtml } from "@/lib/outreach/template";
import { logCrawl } from "@/lib/pipeline/persist";
import { gmailSearch, gmailGetMessage } from "@/lib/google/gmail-api";
import { inngest } from "@/inngest/client";
import { FOLLOWUP_BODY, type FollowupPreview } from "@/lib/types";

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
    .select("id, username, full_name, niche, business_model, funnel_program_name, funnel_offer_summary, external_link, email, email_v2, outreach_count")
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

  // Hard guard: never send twice regardless of how the request was triggered
  if ((lead.outreach_count ?? 0) > 0) {
    return { ok: false, error: "Already sent to this lead." };
  }

  const ctx = buildLeadContext({ lead, senderName: process.env.GMAIL_FROM_NAME ?? null });

  const to = (opts.to?.trim() || lead.email || (lead as Record<string, unknown>).email_v2 as string || "").trim();
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
    revalidatePath("/outreach");
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

// Batch send with pre-rendered content (from the outreach preview page).
export async function sendOutreachBatch(opts: {
  leads: { id: string; subject: string; body: string }[];
  intervalMinutes?: number;
}): Promise<{ ok: boolean; queued: number; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, queued: 0, error: "unauthorized" };

  if (!(await gmailReady())) {
    return { ok: false, queued: 0, error: "Gmail not connected — set up OAuth in Settings → Outreach." };
  }

  const leads = opts.leads.filter((l) => l.id && l.subject && l.body);
  if (leads.length === 0) return { ok: true, queued: 0 };

  await inngest.send({
    name: "outreach/batch.requested",
    data: { leads, interval_minutes: opts.intervalMinutes ?? 20 },
  });

  return { ok: true, queued: leads.length };
}

// Batch send by lead IDs — renders templates server-side.
// Used by bulk-select on the leads table where there's no preview step.
export async function sendOutreachBatchByIds(opts: {
  leadIds: string[];
  intervalMinutes?: number;
}): Promise<{ ok: boolean; queued: number; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, queued: 0, error: "unauthorized" };

  if (!(await gmailReady())) {
    return { ok: false, queued: 0, error: "Gmail not connected — set up OAuth in Settings → Outreach." };
  }

  const ids = Array.from(new Set(opts.leadIds.filter(Boolean)));
  if (ids.length === 0) return { ok: true, queued: 0 };

  const settings = await getSettings();
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("leads")
    .select("id, username, full_name, niche, business_model, funnel_program_name, funnel_offer_summary, external_link")
    .in("id", ids);

  const leads = (rows ?? []).map((lead) => {
    const ctx = buildLeadContext({ lead, senderName: settings.gmail_from_name ?? null });
    return {
      id: lead.id as string,
      subject: renderTemplate(settings.outreach_subject_template, ctx),
      body: renderTemplate(settings.outreach_body_template, ctx),
    };
  });

  if (leads.length === 0) return { ok: true, queued: 0 };

  await inngest.send({
    name: "outreach/batch.requested",
    data: { leads, interval_minutes: opts.intervalMinutes ?? 20 },
  });

  return { ok: true, queued: leads.length };
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

// Loads all leads eligible for a follow-up and pairs them with their original
// outreach thread info for in-thread Gmail replies.
export async function getFollowupQueue(): Promise<FollowupPreview[]> {
  const admin = createAdminClient();

  const { data: leads } = await admin
    .from("leads")
    .select("id, username, email, email_provider, email_v2, email_v2_provider, overall_score, status, niche")
    .gte("outreach_count", 1)
    .eq("followup_count", 0)
    .or("email_status.is.null,email_status.neq.bounced")
    .or("email.ilike.*@*,email_v2.ilike.*@*")
    .order("last_outreach_at", { ascending: true });

  if (!leads?.length) return [];

  const ids = leads.map((l) => l.id as string);

  // Fetch the earliest sent message per lead for threading.
  const { data: msgs } = await admin
    .from("outreach_messages")
    .select("lead_id, subject, message_id, gmail_thread_id")
    .in("lead_id", ids)
    .eq("status", "sent")
    .eq("email_type", "outreach")
    .order("sent_at", { ascending: true });

  const originalByLead = new Map<string, { subject: string; message_id: string | null; gmail_thread_id: string | null }>();
  for (const m of msgs ?? []) {
    if (!originalByLead.has(m.lead_id)) {
      originalByLead.set(m.lead_id, {
        subject: m.subject,
        message_id: m.message_id,
        gmail_thread_id: m.gmail_thread_id,
      });
    }
  }

  return leads.flatMap((lead) => {
    const to = (lead.email ?? (lead as Record<string, unknown>).email_v2) as string | null;
    if (!to?.includes("@")) return [];
    const orig = originalByLead.get(lead.id as string);
    return [{
      leadId: lead.id as string,
      username: lead.username as string,
      email: to,
      emailSource: (lead.email
        ? (lead as Record<string, unknown>).email_provider
        : (lead as Record<string, unknown>).email_v2_provider) as string | null,
      score: lead.overall_score != null ? Number(lead.overall_score) : null,
      status: lead.status as string,
      niche: lead.niche as string | null,
      subject: orig ? `Re: ${orig.subject}` : "Re: Quick follow-up",
      body: FOLLOWUP_BODY,
      inReplyTo: orig?.message_id ?? null,
      threadId: orig?.gmail_thread_id ?? null,
    }];
  });
}

// Sends a single follow-up email directly (not via Inngest batch).
export async function sendFollowup(opts: {
  leadId: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  threadId?: string | null;
}): Promise<SendOutreachResponse> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  if (!(await gmailReady())) {
    return { ok: false, error: "Gmail not connected — set up OAuth in Settings → Outreach." };
  }

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads")
    .select("id, username, followup_count")
    .eq("id", opts.leadId)
    .single();

  if (!lead) return { ok: false, error: "Lead not found." };
  if ((lead.followup_count ?? 0) > 0) return { ok: false, error: "Follow-up already sent to this lead." };

  const settings = await getSettings();
  const bodyHtml = textToHtml(opts.body);

  try {
    const result = await sendEmail({
      to: opts.to,
      subject: opts.subject,
      text: opts.body,
      html: bodyHtml,
      replyTo: settings.outreach_reply_to ?? undefined,
      inReplyTo: opts.inReplyTo ?? undefined,
      references: opts.inReplyTo ?? undefined,
      threadId: opts.threadId ?? undefined,
    });

    await admin.from("outreach_messages").insert({
      lead_id: opts.leadId,
      to_email: opts.to,
      subject: opts.subject,
      body_text: opts.body,
      body_html: bodyHtml,
      status: "sent",
      message_id: result.messageId,
      gmail_thread_id: result.threadId,
      email_type: "followup",
      sent_by: user.id,
    });

    await admin.from("leads").update({
      followup_count: 1,
      last_followup_at: new Date().toISOString(),
    }).eq("id", opts.leadId);

    await logCrawl({
      crawl_job_id: null,
      profile_username: lead.username,
      parent_username: null,
      action: "followup_sent",
      depth: 0,
      detail: `To: ${opts.to} · Subject: ${opts.subject}`,
    });

    revalidatePath("/outreach/followup");
    revalidatePath("/leads");
    return { ok: true, message_id: result.messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await admin.from("outreach_messages").insert({
      lead_id: opts.leadId,
      to_email: opts.to,
      subject: opts.subject,
      body_text: opts.body,
      body_html: bodyHtml,
      status: "failed",
      error: msg,
      email_type: "followup",
      sent_by: user.id,
    });
    return { ok: false, error: msg };
  }
}

// Queues a batch of follow-up emails via Inngest.
export async function sendFollowupBatchAction(opts: {
  leads: { id: string; to: string; subject: string; body: string; inReplyTo?: string | null; threadId?: string | null }[];
  intervalMinutes?: number;
}): Promise<{ ok: boolean; queued: number; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, queued: 0, error: "unauthorized" };

  if (!(await gmailReady())) {
    return { ok: false, queued: 0, error: "Gmail not connected — set up OAuth in Settings → Outreach." };
  }

  const leads = opts.leads
    .filter((l) => l.id && l.to && l.subject && l.body)
    .map((l) => ({
      id: l.id,
      to: l.to,
      subject: l.subject,
      body: l.body,
      inReplyTo: l.inReplyTo ?? undefined,
      threadId: l.threadId ?? undefined,
    }));

  if (!leads.length) return { ok: true, queued: 0 };

  await inngest.send({
    name: "outreach/followup-batch.requested",
    data: { leads, interval_minutes: opts.intervalMinutes ?? 20 },
  });

  return { ok: true, queued: leads.length };
}

export type FollowupBatchProgress = {
  sent: number;
  pending: number;
  failed: number;
  isActive: boolean;
  intervalMinutes: number;
  recentLogs: { id: string; profile_username: string; action: string; detail: string | null; created_at: string }[];
};

export async function getFollowupBatchProgress(): Promise<FollowupBatchProgress> {
  const admin = createAdminClient();
  const INTERVAL_MINUTES = 20;

  const [
    { count: sent },
    { count: pending },
    { count: failed },
    { data: recentLogs },
    { data: lastLog },
  ] = await Promise.all([
    admin.from("leads").select("id", { count: "exact", head: true }).gte("followup_count", 1),
    admin.from("leads").select("id", { count: "exact", head: true })
      .gte("outreach_count", 1)
      .eq("followup_count", 0)
      .or("email_status.is.null,email_status.neq.bounced")
      .or("email.ilike.*@*,email_v2.ilike.*@*"),
    admin.from("outreach_messages").select("id", { count: "exact", head: true })
      .eq("email_type", "followup")
      .eq("status", "failed"),
    admin.from("crawl_logs").select("id, profile_username, action, detail, created_at")
      .in("action", ["followup_sent", "followup_failed"])
      .order("created_at", { ascending: false })
      .limit(50),
    admin.from("crawl_logs").select("created_at")
      .in("action", ["followup_sent", "followup_failed"])
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const lastAt = lastLog?.[0]?.created_at ? new Date(lastLog[0].created_at).getTime() : null;
  const isActive = lastAt != null && Date.now() - lastAt < (INTERVAL_MINUTES + 5) * 60 * 1000;

  return {
    sent: sent ?? 0,
    pending: pending ?? 0,
    failed: failed ?? 0,
    isActive,
    intervalMinutes: INTERVAL_MINUTES,
    recentLogs: recentLogs ?? [],
  };
}
