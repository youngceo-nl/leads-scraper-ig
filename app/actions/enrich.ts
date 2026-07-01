"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { testingEnrichPipeline } from "@/lib/pipeline/testing-pipeline";
import { logCrawl } from "@/lib/pipeline/persist";
import { inngest } from "@/inngest/client";

export type EnrichLeadResponse = {
  ok: boolean;
  email?: string | null;
  email_status?: string;
  linkedin_url?: string | null;
  youtube_url?: string | null;
  source?: string;
  // Human-readable summary shown to the user when nothing was found.
  error?: string;
  // Full step-by-step trace, shown behind a "details" affordance.
  detail?: string;
};

export async function enrichLead(leadId: string): Promise<EnrichLeadResponse> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const { data: lead } = await createAdminClient()
    .from("leads")
    .select("username, crawl_depth, parent_username")
    .eq("id", leadId)
    .single();

  const r = await testingEnrichPipeline({ leadId, force: true });

  await logCrawl({
    crawl_job_id: null,
    profile_username: lead?.username ?? leadId,
    parent_username: lead?.parent_username ?? null,
    action: r.email ? "email_found" : "email_not_found",
    depth: lead?.crawl_depth ?? 0,
    detail: r.email ? `${r.email} (${r.source})` : (r.error ?? "no public email found"),
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);

  return {
    ok: r.ok,
    email: r.email,
    email_status: r.email_status,
    linkedin_url: null,
    youtube_url: r.youtube_url,
    source: r.source,
    error: r.error ?? undefined,
    detail: r.detail ?? undefined,
  };
}

// Bulk: queue the email finder for many leads at once. We fan out one Inngest
// event per lead rather than enriching inline — the enrich-email function bounds
// concurrency so a batch never stampedes the shared YouTube/Instagram cookies or
// spins up dozens of browsers. Leads that already have a confirmed email are
// cost-skipped inside the pipeline, so re-running over a selection is cheap.
export async function enrichLeadsBulk(
  leadIds: string[],
): Promise<{ ok: boolean; queued: number; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, queued: 0, error: "unauthorized" };

  const ids = Array.from(new Set(leadIds.filter(Boolean)));
  if (ids.length === 0) return { ok: true, queued: 0 };

  await inngest.send(
    ids.map((lead_id) => ({ name: "lead/email.enrich.requested" as const, data: { lead_id } })),
  );

  revalidatePath("/leads");
  return { ok: true, queued: ids.length };
}

// ── V2 pipeline validation ──────────────────────────────────────────────────
// Cohort: qualified leads that haven't been contacted yet, where V1 already
// ran and failed to find an email. This is the population worth re-checking
// with the V2 pipeline (IG bio → YouTube About → IG mobile contact button).
function v2ValidationCohort() {
  return createAdminClient()
    .from("leads")
    .select("id, username, email_v2, email_v2_status, email_v2_provider, email_v2_error, email_v2_enriched_at")
    .eq("status", "qualified")
    .eq("outreach_count", 0)
    .is("email", null)
    .not("enriched_at", "is", null);
}

export type V2ValidationStatus = {
  cohortSize: number;
  queued: number; // not yet run through V2
  ran: number;
  found: number;
  notFound: number;
  hitRate: number; // 0-100
  byProvider: Record<string, number>;
  errorSamples: string[];
};

export async function getV2ValidationStatus(): Promise<V2ValidationStatus> {
  const { data } = await v2ValidationCohort();
  const rows = data ?? [];

  const ran = rows.filter((r) => r.email_v2_enriched_at);
  const found = ran.filter((r) => r.email_v2_status === "found");
  const notFound = ran.filter((r) => r.email_v2_status !== "found");

  const byProvider: Record<string, number> = {};
  for (const r of found) {
    const p = (r.email_v2_provider as string) ?? "unknown";
    byProvider[p] = (byProvider[p] ?? 0) + 1;
  }

  const errorSamples = Array.from(
    new Set(notFound.map((r) => (r.email_v2_error as string | null)?.split(" · ")[0] ?? "").filter(Boolean)),
  ).slice(0, 5);

  return {
    cohortSize: rows.length,
    queued: rows.length - ran.length,
    ran: ran.length,
    found: found.length,
    notFound: notFound.length,
    hitRate: ran.length > 0 ? Math.round((found.length / ran.length) * 1000) / 10 : 0,
    byProvider,
    errorSamples,
  };
}

export async function runV2ValidationBatch(): Promise<{ ok: boolean; queued: number; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, queued: 0, error: "unauthorized" };

  const { data } = await v2ValidationCohort();
  const ids = (data ?? []).filter((r) => !r.email_v2_enriched_at).map((r) => r.id as string);
  if (ids.length === 0) return { ok: true, queued: 0 };

  await inngest.send(
    ids.map((lead_id) => ({ name: "lead/email-v2.enrich.requested" as const, data: { lead_id } })),
  );

  revalidatePath("/email-lab");
  return { ok: true, queued: ids.length };
}
