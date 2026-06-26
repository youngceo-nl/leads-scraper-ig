import type { Supabase } from "../supabase";

export async function logJobEvent(
  sb: Supabase,
  jobId: string,
  eventType: string,
  message?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const { error } = await sb.from("video_job_events").insert({
    job_id: jobId,
    event_type: eventType,
    message: message ?? null,
    metadata: metadata ?? null,
  });
  // Diagnostic logging must never crash the job pipeline.
  if (error) console.error(`logJobEvent(${jobId}, ${eventType}) failed: ${error.message}`);
}
