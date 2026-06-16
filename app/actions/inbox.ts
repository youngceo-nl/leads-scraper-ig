"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { gmailOAuthConfigured } from "@/lib/google/oauth";
import { gmailGetThread, gmailGetMessage, gmailSearch, type ThreadMessage } from "@/lib/google/gmail-api";

export type SyncInboxResponse = {
  ok: boolean;
  new_replies?: number;
  scanned?: number;
  error?: string;
};

type Owner = { lead_id: string; outreach_id: string; thread_id: string | null };

// Normalize an RFC Message-Id for comparison: drop angle brackets, lowercase.
const normId = (id: string) => id.replace(/[<>]/g, "").trim().toLowerCase();

// Pull every reply to outreach we sent. Two passes, deduped by message id:
//   1) thread pass  — fetch each Gmail thread we recorded at send time.
//   2) search pass  — query the mailbox for inbound mail FROM the addresses we
//      emailed; this catches replies Gmail re-threaded (new subject, broken
//      threading) or in threads we never recorded. The search is scoped to
//      contacted addresses, so unrelated personal mail is never read.
// Each candidate is matched to its lead by thread → In-Reply-To/References →
// sender address.
export async function syncInbox(): Promise<SyncInboxResponse> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const settings = await getSettings();
  if (!gmailOAuthConfigured(settings)) {
    return { ok: false, error: "Gmail not connected — connect it in Settings → Outreach." };
  }
  const ourEmail = (settings.gmail_oauth_email || "").toLowerCase();

  const admin = createAdminClient();

  // Every outreach we sent — newest first so the most recent send "owns" a
  // repeated address / thread when building the lookup maps.
  const { data: sends } = await admin
    .from("outreach_messages")
    .select("id, lead_id, gmail_thread_id, message_id, to_email, sent_at")
    .eq("status", "sent")
    .order("sent_at", { ascending: false });

  // Owner lookup maps: by thread id, by our sent Message-Id, and by recipient.
  const threadOwner = new Map<string, Owner>();
  const msgidOwner = new Map<string, Owner>();
  const emailOwner = new Map<string, Owner>();
  for (const s of sends ?? []) {
    const owner: Owner = { lead_id: s.lead_id, outreach_id: s.id, thread_id: s.gmail_thread_id ?? null };
    if (s.gmail_thread_id && !threadOwner.has(s.gmail_thread_id)) threadOwner.set(s.gmail_thread_id, owner);
    if (s.message_id && !msgidOwner.has(normId(s.message_id))) msgidOwner.set(normId(s.message_id), owner);
    const to = (s.to_email || "").toLowerCase();
    if (to && !emailOwner.has(to)) emailOwner.set(to, owner);
  }
  if ((sends ?? []).length === 0) return { ok: true, new_replies: 0, scanned: 0 };

  const resolveOwner = (m: ThreadMessage): Owner | null => {
    if (m.threadId && threadOwner.has(m.threadId)) return threadOwner.get(m.threadId)!;
    const refs = `${m.inReplyTo ?? ""} ${m.references ?? ""}`.match(/<[^>]+>/g) ?? [];
    for (const id of refs) {
      const o = msgidOwner.get(normId(id));
      if (o) return o;
    }
    const from = (m.fromEmail || "").toLowerCase();
    if (from && emailOwner.has(from)) return emailOwner.get(from)!;
    return null;
  };

  // ── Collect candidate messages (deduped by Gmail message id). ──
  const candidates = new Map<string, ThreadMessage>();

  // Pass 1: threads we recorded.
  for (const threadId of threadOwner.keys()) {
    try {
      for (const m of await gmailGetThread(threadId)) {
        if (m.gmailMessageId) candidates.set(m.gmailMessageId, m);
      }
    } catch {
      continue; // a single bad thread shouldn't abort the whole sync
    }
  }

  // Pass 2: search the mailbox for inbound mail from the addresses we contacted.
  // Batch addresses into one query each (Gmail caps query length); include spam
  // and archived mail, exclude trash.
  const emails = [...emailOwner.keys()];
  for (let i = 0; i < emails.length; i += 20) {
    const batch = emails.slice(i, i + 20);
    const q = `from:(${batch.join(" OR ")}) in:anywhere -in:trash`;
    let ids: string[] = [];
    try {
      ids = await gmailSearch(q, 300);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (candidates.has(id)) continue;
      try {
        const m = await gmailGetMessage(id);
        if (m?.gmailMessageId) candidates.set(m.gmailMessageId, m);
      } catch {
        /* skip a single unreadable message */
      }
    }
  }

  const affectedLeads = new Set<string>();
  let inserted = 0;
  let scanned = 0;

  for (const m of candidates.values()) {
    scanned++;
    const from = (m.fromEmail || "").toLowerCase();
    // Our own outgoing messages aren't replies.
    if (!from || from === ourEmail) continue;
    const owner = resolveOwner(m);
    if (!owner) continue; // not tied to any outreach we sent

    const snippet = (m.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
    const { data: row, error } = await admin
      .from("inbox_messages")
      .upsert(
        {
          lead_id: owner.lead_id,
          outreach_message_id: owner.outreach_id,
          gmail_message_id: m.rfcMessageId ?? m.gmailMessageId,
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
      affectedLeads.add(owner.lead_id);
      // Backfill the thread id on the owning outreach when we learned it from a
      // re-threaded reply, so future thread-pass syncs find it directly.
      if (!owner.thread_id && m.threadId) {
        owner.thread_id = m.threadId;
        await admin.from("outreach_messages").update({ gmail_thread_id: m.threadId }).eq("id", owner.outreach_id);
      }
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
  return { ok: true, new_replies: inserted, scanned };
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
