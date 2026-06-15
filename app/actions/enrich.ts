"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { enrichLeadPipeline } from "@/lib/pipeline/enrich-pipeline";
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

  const r = await enrichLeadPipeline({ leadId, force: true });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);

  return {
    ok: r.ok,
    email: r.email,
    email_status: r.email_status,
    linkedin_url: r.linkedin_url,
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
