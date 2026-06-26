import { access } from "node:fs/promises";
import type { Supabase } from "./supabase";
import { getAppSettings, resolveAnthropicKey, resolveOpenAiKey } from "./supabase";
import type { VideoJob, VideoLead } from "./types";
import { updateJob } from "./jobs/updateJob";
import { logJobEvent } from "./jobs/logJobEvent";
import { jobDir as ensureJobDir, jobFile } from "./utils/paths";
import { logger } from "./utils/logger";
import { config } from "./config";
import { generateScript, firstNameOf } from "./services/generateScript";
import { generateVoiceMp3 } from "./services/generateVoiceMp3";
import { recordProspectPage } from "./services/recordProspectPage";
import { renderRemotionVideo } from "./services/renderRemotionVideo";
import { uploadToLoom } from "./services/uploadToLoom";
import { uploadFileToBucket, getLongLivedSignedUrl, getBasePitchVideoPath } from "./services/storage";

async function fetchLead(sb: Supabase, leadId: string): Promise<VideoLead> {
  const { data, error } = await sb
    .from("leads")
    .select("id, username, full_name, profile_url, external_link, funnel_url, funnel_program_name, niche, business_model, offer_type")
    .eq("id", leadId)
    .single();
  if (error || !data) throw new Error(`fetchLead(${leadId}) failed: ${error?.message ?? "not found"}`);
  return data as VideoLead;
}

// Best-effort: a debug screenshot left behind by a failed Playwright stage is
// uploaded for diagnosis, but a failure to upload it must never mask the
// real error that's about to be thrown.
async function captureDebugArtifact(sb: Supabase, jobId: string, localPath: string, label: string): Promise<void> {
  try {
    await access(localPath);
    const storagePath = `${jobId}/${label}.png`;
    await uploadFileToBucket(sb, "debug-artifacts", storagePath, localPath);
    await logJobEvent(sb, jobId, `${label}_debug_screenshot`, storagePath);
  } catch (err) {
    logger.warn(`captureDebugArtifact(${label}) failed`, { message: err instanceof Error ? err.message : String(err) });
  }
}

export async function processJob(sb: Supabase, job: VideoJob): Promise<void> {
  logger.info(`processing job ${job.id}`, { leadId: job.lead_id });
  await logJobEvent(sb, job.id, "claimed");

  const lead = await fetchLead(sb, job.lead_id);
  await ensureJobDir(job.id); // creates tmp/<jobId>/ for the per-stage outputs below
  const settings = await getAppSettings(sb);

  // 1. Script
  const scriptApiKey = settings.scoring_provider === "claude" ? resolveAnthropicKey(settings) : resolveOpenAiKey(settings);
  const scriptModel = settings.scoring_provider === "claude" ? settings.claude_model : settings.openai_model;
  const hookScript = await generateScript({ provider: settings.scoring_provider, apiKey: scriptApiKey, model: scriptModel, lead });
  await updateJob(sb, job.id, { hook_script: hookScript });
  await logJobEvent(sb, job.id, "script_generated", hookScript);

  // 2. Voice
  await updateJob(sb, job.id, { status: "generating_audio" });
  const audioPath = jobFile(job.id, "hook.mp3");
  await generateVoiceMp3(
    { text: hookScript, outputPath: audioPath },
    { openaiApiKey: config.ttsProvider === "openai" ? resolveOpenAiKey(settings) : undefined },
  );
  await updateJob(sb, job.id, { audio_path: audioPath });
  await logJobEvent(sb, job.id, "audio_generated");

  // 3. Screen asset
  await updateJob(sb, job.id, { status: "recording_profile" });
  const screenPath = jobFile(job.id, "screen.png");
  const targetUrl = lead.external_link || lead.funnel_url || lead.profile_url;
  try {
    await recordProspectPage({ url: targetUrl, outputPath: screenPath, debugScreenshotPath: jobFile(job.id, "debug-record.png") });
  } catch (err) {
    await captureDebugArtifact(sb, job.id, jobFile(job.id, "debug-record.png"), "recording_profile");
    throw err;
  }
  await updateJob(sb, job.id, { screen_recording_path: screenPath });
  await logJobEvent(sb, job.id, "screen_recorded", targetUrl);

  // 4. Render
  await updateJob(sb, job.id, { status: "rendering_video" });
  const basePitchVideoPath = await getBasePitchVideoPath(sb);
  const renderedPath = await renderRemotionVideo({
    jobId: job.id,
    firstName: firstNameOf(lead),
    companyName: lead.funnel_program_name || lead.niche || lead.username,
    hookAudioPath: audioPath,
    screenAssetPath: screenPath,
    basePitchVideoPath: basePitchVideoPath ?? undefined,
    ctaText: config.defaultCtaText,
    brandColor: config.defaultBrandColor,
  });

  // Best-effort audit backup — the Loom upload below is the actual outreach
  // asset, so a Storage failure (e.g. the project's global upload size limit,
  // which a long render with a base pitch video can exceed) must not block
  // it. See worker/README.md.
  let renderedVideoStorageUrl: string | null = null;
  try {
    const storagePath = `${job.id}/rendered-video.mp4`;
    await uploadFileToBucket(sb, "rendered-videos", storagePath, renderedPath);
    renderedVideoStorageUrl = await getLongLivedSignedUrl(sb, "rendered-videos", storagePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`rendered video Storage backup failed for job ${job.id}`, { message });
    await logJobEvent(sb, job.id, "storage_backup_skipped", message);
  }
  await updateJob(sb, job.id, { rendered_video_path: renderedPath, rendered_video_storage_url: renderedVideoStorageUrl });
  await logJobEvent(sb, job.id, "video_rendered");

  // 5. Loom upload
  await updateJob(sb, job.id, { status: "uploading_to_loom" });
  let loomResult;
  try {
    loomResult = await uploadToLoom(renderedPath, { debugScreenshotPath: jobFile(job.id, "debug-loom.png") });
  } catch (err) {
    await captureDebugArtifact(sb, job.id, jobFile(job.id, "debug-loom.png"), "uploading_to_loom");
    throw err;
  }

  await updateJob(sb, job.id, {
    status: "done",
    loom_url: loomResult.loomUrl,
    loom_embed_code: loomResult.embedCode,
  });
  await logJobEvent(sb, job.id, "done", loomResult.loomUrl);
}
