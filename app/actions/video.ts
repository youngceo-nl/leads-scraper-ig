"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function requestOutreachVideo(leadId: string): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const admin = createAdminClient();
  const { data: lead } = await admin.from("leads").select("username").eq("id", leadId).single();
  if (!lead) return { ok: false, error: "lead_not_found" };

  const { data: job, error } = await admin
    .from("video_jobs")
    .insert({ lead_id: leadId })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/leads");
  revalidatePath(`/leads/${lead.username}`);
  return { ok: true, jobId: job.id };
}

export async function retryVideoJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const admin = createAdminClient();
  const { data: job } = await admin.from("video_jobs").select("lead_id").eq("id", jobId).single();
  if (!job) return { ok: false, error: "job_not_found" };
  const { data: lead } = await admin.from("leads").select("username").eq("id", job.lead_id).single();

  const { error } = await admin
    .from("video_jobs")
    .update({ status: "pending", error_message: null, locked_at: null })
    .eq("id", jobId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/leads");
  if (lead) revalidatePath(`/leads/${lead.username}`);
  return { ok: true };
}
