import type { Supabase } from "../supabase";
import type { VideoJob } from "../types";
import { config } from "../config";

// Claims the oldest eligible pending job. Two-step select-then-conditional-
// update so a lost race (another worker claimed it first) is detected via the
// update matching zero rows, rather than two workers processing the same job.
export async function claimJob(sb: Supabase): Promise<VideoJob | null> {
  const { data: candidates, error: selectErr } = await sb
    .from("video_jobs")
    .select("id")
    .eq("status", "pending")
    .lt("attempt_count", config.maxAttempts)
    .order("created_at", { ascending: true })
    .limit(1);
  if (selectErr) throw new Error(`claimJob select failed: ${selectErr.message}`);
  if (!candidates || candidates.length === 0) return null;

  const { data, error } = await sb
    .from("video_jobs")
    .update({ status: "generating_script", locked_at: new Date().toISOString() })
    .eq("id", candidates[0].id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`claimJob update failed: ${error.message}`);
  return (data as VideoJob) ?? null; // null means another worker won the race
}
