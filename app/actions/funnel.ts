"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enrichFunnelForLead } from "@/lib/funnel/enrich";

export type FunnelEnrichResponse = {
  ok: boolean;
  funnel_url?: string | null;
  funnel_platform?: string | null;
  funnel_program_name?: string | null;
  funnel_offer_summary?: string | null;
  funnel_price?: string | null;
  error?: string;
};

export async function saveProgramName(leadId: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const admin = createAdminClient();
  const { error } = await admin
    .from("leads")
    .update({ funnel_program_name: name.trim() || null })
    .eq("id", leadId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/leads");
  return { ok: true };
}

export async function enrichFunnel(leadId: string): Promise<FunnelEnrichResponse> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads")
    .select("id, external_link")
    .eq("id", leadId)
    .single();
  if (!lead) return { ok: false, error: "lead_not_found" };
  if (!lead.external_link) return { ok: false, error: "lead has no external_link" };

  const result = await enrichFunnelForLead({ leadId, externalLink: lead.external_link as string });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);

  return {
    ok: result.ok,
    funnel_url: result.funnel_url,
    funnel_platform: result.funnel_platform,
    funnel_program_name: result.funnel_program_name,
    funnel_offer_summary: result.funnel_offer_summary,
    funnel_price: result.funnel_price,
    error: result.error ?? undefined,
  };
}
