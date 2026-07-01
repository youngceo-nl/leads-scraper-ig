import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/config/settings";
import { buildLeadContext, renderTemplate, extractFirstName, extractFirstNameFromUsername } from "@/lib/outreach/template";
import { Mail } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { OutreachPreviewList } from "@/components/outreach/outreach-preview-list";
import { isPlausible } from "@/lib/leads/email-extract";
import type { Lead } from "@/lib/types";
import Link from "next/link";

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
    .select("id, username, full_name, email, email_provider, email_v2, email_v2_provider, email_v2_status, email_status, overall_score, niche, business_model, funnel_program_name, funnel_offer_summary, external_link, status, outreach_count")
    .in("status", ["qualified", "review"])
    .order("overall_score", { ascending: false })
    .limit(200);

  const leads = (rows ?? []) as Lead[];

  const sendable = [];
  const blocked = [];
  const alreadySent: { leadId: string; username: string; score: number | null; niche: string | null; email: string | null }[] = [];
  const needsEmail: { leadId: string; username: string; score: number | null; niche: string | null }[] = [];

  for (const lead of leads) {
    const outreachCount = (lead as Record<string, unknown>).outreach_count as number ?? 0;

    if (outreachCount > 0) {
      const email = (lead.email as string | null) ?? ((lead as Record<string, unknown>).email_v2 as string | null) ?? null;
      alreadySent.push({ leadId: lead.id, username: lead.username, score: lead.overall_score != null ? Number(lead.overall_score) : null, niche: lead.niche as string | null, email });
      continue;
    }

    const emailStatus = (lead as Record<string, unknown>).email_status as string | null;
    if (emailStatus === "bounced" || emailStatus === "invalid") {
      needsEmail.push({ leadId: lead.id, username: lead.username, score: lead.overall_score != null ? Number(lead.overall_score) : null, niche: lead.niche as string | null });
      continue;
    }

    // Prefer v1 email; fall back to v2 if v1 is missing
    const resolvedEmail = (lead.email as string | null)
      ?? ((lead as Record<string, unknown>).email_v2 as string | null)
      ?? null;
    if (!resolvedEmail || !isPlausible(resolvedEmail)) {
      needsEmail.push({ leadId: lead.id, username: lead.username, score: lead.overall_score != null ? Number(lead.overall_score) : null, niche: lead.niche as string | null });
      continue;
    }
    const resolvedSource = lead.email
      ? ((lead as Record<string, unknown>).email_provider as string | null)
      : ((lead as Record<string, unknown>).email_v2_provider as string | null);

    // Skip if the resolved email has a bounced/invalid v2 status
    const v2Status = (lead as Record<string, unknown>).email_v2_status as string | null;
    if (!lead.email && v2Status && /^(bounced|invalid)$/i.test(v2Status)) {
      needsEmail.push({ leadId: lead.id, username: lead.username, score: lead.overall_score != null ? Number(lead.overall_score) : null, niche: lead.niche as string | null });
      continue;
    }

    const firstName = extractFirstName(lead.full_name as string | null)
      ?? extractFirstNameFromUsername(lead.username as string | null);
    if (!firstName) {
      blocked.push({
        leadId: lead.id,
        username: lead.username,
        blockReason: `No valid first name in "${lead.full_name ?? "(empty)"}" and username "${lead.username}" has no usable first segment`,
      });
      continue;
    }
    const ctx = buildLeadContext({ lead, senderName: settings.gmail_from_name ?? null });
    sendable.push({
      leadId: lead.id,
      username: lead.username,
      firstName,
      email: resolvedEmail,
      emailSource: resolvedSource ?? null,
      score: lead.overall_score != null ? Number(lead.overall_score) : null,
      status: lead.status as string,
      niche: lead.niche as string | null,
      subject: renderTemplate(settings.outreach_subject_template, ctx),
      body: renderTemplate(settings.outreach_body_template, ctx),
    });
  }

  if (sendable.length === 0 && blocked.length === 0 && alreadySent.length === 0 && needsEmail.length === 0) {
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
      <div className="flex justify-end mb-2">
        <Link href="/outreach/followup" className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2">
          Follow-up queue →
        </Link>
      </div>
      <OutreachPreviewList
        sendable={sendable}
        blocked={blocked}
        alreadySent={alreadySent}
        needsEmail={needsEmail}
        intervalMinutes={INTERVAL_MINUTES}
        sentToday={sentToday ?? 0}
      />
    </div>
  );
}
