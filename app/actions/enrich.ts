"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { enrichLeadPipeline } from "@/lib/pipeline/enrich-pipeline";

export type EnrichLeadResponse = {
  ok: boolean;
  email?: string | null;
  email_status?: string;
  linkedin_url?: string | null;
  youtube_url?: string | null;
  source?: string;
  error?: string;
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
  };
}
