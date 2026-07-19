"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { sendEmail, gmailReady } from "@/lib/outreach/gmail";
import { textToHtml } from "@/lib/outreach/template";
import { logCrawl } from "@/lib/pipeline/persist";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
  return user;
}

// Set OUTREACH_DRY_RUN=1 in .env.local to exercise the whole screen without
// sending a real email or writing any state. Every send is irreversible and
// permanently burns the lead, so this is the switch to develop against.
function dryRunEnabled() {
  return process.env.OUTREACH_DRY_RUN === "1";
}

export type SaveFieldsPatch = {
  full_name?: string | null;
  funnel_program_name?: string | null;
};

// The two fields automation gets wrong: full_name feeds {{first_name}} in the
// greeting, funnel_program_name feeds {{program_name}} in the subject line.
// Only keys actually present in `patch` are written, so saving one can never
// null the other.
export async function saveOutreachFields(
  leadId: string,
  patch: SaveFieldsPatch,
): Promise<{ ok: boolean; error?: string }> {
  await requireUser();

  const clean: Record<string, string | null> = {};
  for (const key of ["full_name", "funnel_program_name"] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    clean[key] = typeof v === "string" ? v.trim() || null : null;
  }
  if (Object.keys(clean).length === 0) return { ok: true };

  const admin = createAdminClient();
  const { error } = await admin.from("leads").update(clean).eq("id", leadId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/outreach-ready");
  revalidatePath("/leads");
  return { ok: true };
}

export type SendOutreachResponse = {
  ok: boolean;
  message_id?: string;
  error?: string;
  dryRun?: boolean;
};

// Sends exactly the subject/body the client rendered and the user approved —
// no server-side re-render, so what was previewed is provably what ships.
export async function sendOutreachEmail(opts: {
  leadId: string;
  to: string;
  subject: string;
  body: string;
}): Promise<SendOutreachResponse> {
  const user = await requireUser();

  const to = opts.to.trim();
  const subject = opts.subject.trim();
  const bodyText = opts.body.trim();

  if (!to.includes("@")) return { ok: false, error: "No valid recipient email." };
  if (!subject) return { ok: false, error: "Subject is empty." };
  if (!bodyText) return { ok: false, error: "Body is empty." };

  const admin = createAdminClient();

  // Re-read from the DB rather than trusting client state — this is the guard
  // that stops a stale tab or a double-click from sending twice.
  const { data: lead, error: leadErr } = await admin
    .from("leads")
    .select("id, username, outreach_count")
    .eq("id", opts.leadId)
    .single();
  if (leadErr || !lead) return { ok: false, error: leadErr?.message ?? "Lead not found" };
  if ((lead.outreach_count ?? 0) > 0) return { ok: false, error: "Already sent to this lead." };

  // Bail before Gmail and before any write.
  if (dryRunEnabled()) return { ok: true, message_id: "dry-run", dryRun: true };

  if (!(await gmailReady())) {
    return { ok: false, error: "Gmail not connected — check the OAuth credentials in Settings." };
  }

  const settings = await getSettings();
  const bodyHtml = textToHtml(bodyText);

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

    await admin
      .from("leads")
      .update({
        outreach_count: (lead.outreach_count ?? 0) + 1,
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

    revalidatePath("/outreach-ready");
    revalidatePath("/leads");
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
    await admin.from("leads").update({ last_outreach_error: msg }).eq("id", opts.leadId);

    await logCrawl({
      crawl_job_id: null,
      profile_username: lead.username,
      parent_username: null,
      action: "email_failed",
      depth: 0,
      status: "failure",
      detail: msg.slice(0, 200),
    });

    revalidatePath("/outreach-ready");
    return { ok: false, error: msg };
  }
}
