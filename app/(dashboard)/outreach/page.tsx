import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { buildLeadContext, renderTemplate, extractFirstName } from "@/lib/outreach/template";
import { Mail } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { OutreachPreviewList } from "@/components/outreach/outreach-preview-list";
import type { Lead } from "@/lib/types";

export const dynamic = "force-dynamic";

const DAILY_TARGET = 25;
const INTERVAL_MINUTES = 20;

export default async function OutreachPreviewPage() {
  const sb = createAdminClient();
  const settings = await getSettings();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count: sentToday } = await sb
    .from("outreach_messages")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent")
    .gte("sent_at", todayStart.toISOString());

  const { data: rows } = await sb
    .from("leads")
    .select("id, username, full_name, email, overall_score, niche, business_model, funnel_program_name, funnel_offer_summary, external_link, status")
    .in("status", ["qualified", "review"])
    .not("email", "is", null)
    .ilike("email", "%@%")
    .neq("email_status", "bounced")
    .eq("outreach_count", 0)
    .order("overall_score", { ascending: false })
    .limit(DAILY_TARGET);

  const leads = (rows ?? []) as Lead[];

  const sendable = [];
  const blocked = [];

  for (const lead of leads) {
    const firstName = extractFirstName(lead.full_name as string | null);
    if (!firstName) {
      blocked.push({
        leadId: lead.id,
        username: lead.username,
        blockReason: `No valid first name in "${lead.full_name ?? "(empty)"}"`,
      });
      continue;
    }
    const ctx = buildLeadContext({ lead, senderName: settings.gmail_from_name ?? null });
    sendable.push({
      leadId: lead.id,
      username: lead.username,
      firstName,
      email: lead.email as string,
      score: lead.overall_score != null ? Number(lead.overall_score) : null,
      status: lead.status as string,
      niche: lead.niche as string | null,
      subject: renderTemplate(settings.outreach_subject_template, ctx),
      body: renderTemplate(settings.outreach_body_template, ctx),
    });
  }

  if (leads.length === 0) {
    return (
      <div className="p-6 max-w-4xl">
        <h1 className="text-2xl font-semibold tracking-tight mb-6">Outreach preview</h1>
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Mail className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">Nothing ready to send</p>
            <p className="text-sm mt-1">Leads need to be qualified, have an email, and not yet contacted.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <OutreachPreviewList
        sendable={sendable}
        blocked={blocked}
        intervalMinutes={INTERVAL_MINUTES}
        sentToday={sentToday ?? 0}
      />
    </div>
  );
}
