import { Mail } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { isPlausible } from "@/lib/leads/email-extract";
import { extractFirstName, extractFirstNameFromUsername } from "@/lib/outreach/template";
import { Card, CardContent } from "@/components/ui/card";
import { OutreachReadyClient, type OutreachRow, type InboxRow } from "@/components/outreach/outreach-ready-client";
import type { CategoryTemplates } from "@/lib/leads/category";
import { getHandoverOutcomesByParent } from "@/lib/handover/outcomes";

export const dynamic = "force-dynamic";

const BAD_EMAIL_STATUS = /^(bounced|invalid)$/i;

export default async function OutreachReadyPage() {
  const sb = createAdminClient();
  const settings = await getSettings();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [{ data: leads }, { count: sentToday }, { data: replies }, handoverOutcomes] = await Promise.all([
    sb
      .from("leads")
      .select(
        "id, username, full_name, niche, business_model, funnel_program_name, funnel_offer_summary, external_link, email, email_provider, email_status, email_v2, email_v2_provider, email_v2_status, overall_score, status, outreach_count, parent_username",
      )
      .in("status", ["qualified", "review"])
      .or("outreach_count.is.null,outreach_count.eq.0")
      .order("overall_score", { ascending: false, nullsFirst: false }),
    sb
      .from("outreach_messages")
      .select("id", { count: "exact", head: true })
      .eq("status", "sent")
      .gte("sent_at", startOfToday.toISOString()),
    // Replies scope to a *different* set of leads than `rows` above — a lead
    // with outreach_count > 0 (i.e. contacted, so possibly replied) is
    // excluded from the ready-to-send query, so business_model has to be
    // joined here independently rather than reused from `rows`.
    sb
      .from("inbox_messages")
      .select("id, from_email, from_name, subject, snippet, body_text, received_at, is_read, lead_id, leads(username, full_name, business_model)")
      .order("received_at", { ascending: false })
      .limit(200),
    getHandoverOutcomesByParent(),
  ]);

  const inboxRows: InboxRow[] = (replies ?? []).map((r) => {
    const lead = (Array.isArray(r.leads) ? r.leads[0] : r.leads) as
      { username?: string; full_name?: string | null; business_model?: string | null } | null;
    return {
      id: r.id,
      from_email: r.from_email,
      from_name: r.from_name,
      subject: r.subject,
      snippet: r.snippet,
      body_text: r.body_text,
      received_at: r.received_at,
      is_read: r.is_read,
      lead_id: r.lead_id,
      lead_username: lead?.username ?? null,
      lead_full_name: lead?.full_name ?? null,
      business_model: lead?.business_model ?? null,
    };
  });

  // Same bucketing the archived batch page used, minus its first-name hard
  // block — this screen exists precisely so a bad name can be fixed inline.
  const rows: OutreachRow[] = [];
  for (const lead of leads ?? []) {
    if (BAD_EMAIL_STATUS.test(lead.email_status ?? "")) continue;

    const resolved = lead.email ?? lead.email_v2;
    if (!resolved || !isPlausible(resolved)) continue;
    // Fell back to v2 — apply v2's own status check.
    if (!lead.email && BAD_EMAIL_STATUS.test(lead.email_v2_status ?? "")) continue;

    const firstName =
      extractFirstName(lead.full_name) ?? extractFirstNameFromUsername(lead.username);

    rows.push({
      id: lead.id,
      username: lead.username,
      full_name: lead.full_name,
      niche: lead.niche,
      business_model: lead.business_model,
      funnel_program_name: lead.funnel_program_name,
      funnel_offer_summary: lead.funnel_offer_summary,
      external_link: lead.external_link,
      email: resolved,
      email_provider: (lead.email ? lead.email_provider : lead.email_v2_provider) ?? null,
      overall_score: lead.overall_score,
      status: lead.status,
      firstName,
      needsFix: !lead.funnel_program_name || firstName === null,
      parent_username: lead.parent_username,
      sourceOutcome: lead.parent_username ? handoverOutcomes.get(lead.parent_username) ?? null : null,
    });
  }

  // Leads whose email is currently broken sort first — they're the ones this
  // screen is for. Score breaks ties.
  rows.sort((a, b) => {
    if (a.needsFix !== b.needsFix) return a.needsFix ? -1 : 1;
    return (b.overall_score ?? 0) - (a.overall_score ?? 0);
  });

  if (rows.length === 0 && inboxRows.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold tracking-tight mb-4">Outreach Ready</h1>
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Mail className="h-8 w-8 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No leads are ready for outreach.</p>
            <p className="text-xs mt-1">
              A lead qualifies here once it has a valid, unbounced email and hasn&apos;t been contacted.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const templates: CategoryTemplates = {
    partnerships: { subject: settings.outreach_subject_partnerships, body: settings.outreach_body_partnerships },
    info: { subject: settings.outreach_subject_info, body: settings.outreach_body_info },
    other: { subject: settings.outreach_subject_other, body: settings.outreach_body_other },
  };

  return (
    <OutreachReadyClient
      rows={rows}
      inboxRows={inboxRows}
      templates={templates}
      senderName={settings.gmail_from_name}
      sentToday={sentToday ?? 0}
      dryRun={process.env.OUTREACH_DRY_RUN === "1"}
    />
  );
}
