"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchInboxMessages } from "@/lib/inbox/imap";

export type SyncInboxResponse = {
  ok: boolean;
  new_replies?: number;
  scanned?: number;
  error?: string;
};

// Normalise a Message-ID for comparison: strip <>, trim, lowercase.
const normId = (s: string | null | undefined): string =>
  (s || "").trim().replace(/^<+|>+$/g, "").toLowerCase();

// Pull recent INBOX mail and persist ONLY messages that are replies to an
// outreach we actually sent. Matching is, in priority order:
//   1. The reply's In-Reply-To / References headers point at the Message-ID of
//      one of our sent outreach emails (definitive — it's a threaded reply).
//   2. Fallback: the sender address equals an address we sent outreach to.
// Anything that matches neither is ignored and never stored.
export async function syncInbox(): Promise<SyncInboxResponse> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return { ok: false, error: "Gmail not configured (GMAIL_USER / GMAIL_APP_PASSWORD)." };
  }

  const admin = createAdminClient();

  // Build lookup maps from every outreach email we've sent.
  const { data: sends } = await admin
    .from("outreach_messages")
    .select("id, lead_id, message_id, to_email")
    .eq("status", "sent");

  const byMsgId = new Map<string, { lead_id: string; outreach_id: string }>();
  const byEmail = new Map<string, { lead_id: string; outreach_id: string }>();
  for (const s of sends ?? []) {
    if (s.message_id) byMsgId.set(normId(s.message_id), { lead_id: s.lead_id, outreach_id: s.id });
    if (s.to_email) byEmail.set(s.to_email.toLowerCase(), { lead_id: s.lead_id, outreach_id: s.id });
  }
  // Nothing sent yet → nothing could be a reply. Don't even open the mailbox.
  if (byMsgId.size === 0 && byEmail.size === 0) return { ok: true, new_replies: 0, scanned: 0 };

  // Only scan since the newest reply we already have (with a 1-day overlap),
  // else a 30-day window on first run. Keeps each sync fast.
  const { data: lastRow } = await admin
    .from("inbox_messages")
    .select("received_at")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const since = lastRow?.received_at
    ? new Date(new Date(lastRow.received_at).getTime() - 86_400_000)
    : null;

  let fetched;
  try {
    fetched = await fetchInboxMessages({ since, sinceDays: 30, limit: 300 });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const affectedLeads = new Set<string>();
  let inserted = 0;

  for (const m of fetched) {
    // 1. Header match against our sent message-ids.
    let match: { lead_id: string; outreach_id: string | null } | null = null;
    for (const ref of [m.inReplyTo, ...m.references]) {
      const hit = byMsgId.get(normId(ref));
      if (hit) { match = { lead_id: hit.lead_id, outreach_id: hit.outreach_id }; break; }
    }
    // 2. Fallback: sender is someone we emailed.
    if (!match && m.fromEmail) {
      const hit = byEmail.get(m.fromEmail.toLowerCase());
      if (hit) match = { lead_id: hit.lead_id, outreach_id: hit.outreach_id };
    }
    if (!match) continue; // NOT outreach-related → skip entirely.

    const snippet = (m.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
    const { data: row, error } = await admin
      .from("inbox_messages")
      .upsert(
        {
          lead_id: match.lead_id,
          outreach_message_id: match.outreach_id,
          gmail_message_id: m.messageId,
          imap_uid: m.uid,
          from_email: m.fromEmail,
          from_name: m.fromName,
          subject: m.subject,
          snippet,
          body_text: m.text,
          body_html: m.html,
          in_reply_to: m.inReplyTo,
          received_at: m.date ?? new Date().toISOString(),
        },
        { onConflict: "gmail_message_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (!error && row) {
      inserted++;
      affectedLeads.add(match.lead_id);
    }
  }

  // Recompute reply counters for each lead that got a new reply.
  for (const leadId of affectedLeads) {
    const { count } = await admin
      .from("inbox_messages")
      .select("*", { count: "exact", head: true })
      .eq("lead_id", leadId);
    const { data: latest } = await admin
      .from("inbox_messages")
      .select("received_at")
      .eq("lead_id", leadId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    await admin
      .from("leads")
      .update({ reply_count: count ?? 0, last_reply_at: latest?.received_at ?? null })
      .eq("id", leadId);
  }

  revalidatePath("/inbox");
  revalidatePath("/leads");
  return { ok: true, new_replies: inserted, scanned: fetched.length };
}

export async function markReplyRead(id: string, read = true): Promise<{ ok: boolean }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false };
  const admin = createAdminClient();
  await admin.from("inbox_messages").update({ is_read: read }).eq("id", id);
  revalidatePath("/inbox");
  return { ok: true };
}
