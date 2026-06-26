import type { Supabase } from "../supabase";
import type { VideoJob } from "../types";

export async function updateJob(sb: Supabase, jobId: string, patch: Partial<VideoJob>): Promise<void> {
  const { error } = await sb.from("video_jobs").update(patch).eq("id", jobId);
  if (error) throw new Error(`updateJob(${jobId}) failed: ${error.message}`);
}
