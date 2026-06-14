import { createAdminClient } from "@/lib/supabase/admin";
import { InboxClient, type InboxReply } from "@/components/inbox/inbox-client";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const sb = createAdminClient();
  const { data } = await sb
    .from("inbox_messages")
    .select("id, from_email, from_name, subject, snippet, body_text, body_html, received_at, is_read, lead_id, leads(username, full_name)")
    .order("received_at", { ascending: false })
    .limit(200);

  const replies: InboxReply[] = (data ?? []).map((r) => {
    const lead = (Array.isArray(r.leads) ? r.leads[0] : r.leads) as { username?: string; full_name?: string | null } | null;
    return {
      id: r.id,
      from_email: r.from_email,
      from_name: r.from_name,
      subject: r.subject,
      snippet: r.snippet,
      body_text: r.body_text,
      body_html: r.body_html,
      received_at: r.received_at,
      is_read: r.is_read,
      lead_username: lead?.username ?? null,
      lead_full_name: lead?.full_name ?? null,
    };
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          Replies from leads you&apos;ve emailed. Only responses to your outreach show up here.
        </p>
      </div>
      <InboxClient initial={replies} />
    </div>
  );
}
