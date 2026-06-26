import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import type { Supabase } from "../supabase";
import { config } from "../config";

const FIVE_YEARS_IN_SECONDS = 60 * 60 * 24 * 365 * 5;

export async function uploadFileToBucket(
  sb: Supabase,
  bucket: string,
  storagePath: string,
  localFilePath: string,
): Promise<void> {
  const body = await readFile(localFilePath);
  const { error } = await sb.storage.from(bucket).upload(storagePath, body, { upsert: true });
  if (error) throw new Error(`uploadFileToBucket(${bucket}/${storagePath}) failed: ${error.message}`);
}

// Buckets are private (see migration) — a long-lived signed URL stands in
// for a permanent one, since the Loom link (not this Supabase copy) is the
// actual outreach asset; this is an audit/debug backup.
export async function getLongLivedSignedUrl(sb: Supabase, bucket: string, storagePath: string): Promise<string> {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(storagePath, FIVE_YEARS_IN_SECONDS);
  if (error || !data) throw new Error(`getLongLivedSignedUrl(${bucket}/${storagePath}) failed: ${error?.message}`);
  return data.signedUrl;
}

// The base pitch video is a single reusable global asset (none recorded yet
// — see project plan), cached locally for the lifetime of the worker process
// rather than re-downloaded per job.
let basePitchVideoPathPromise: Promise<string | null> | null = null;

export function getBasePitchVideoPath(sb: Supabase): Promise<string | null> {
  if (!basePitchVideoPathPromise) basePitchVideoPathPromise = resolveBasePitchVideo(sb);
  return basePitchVideoPathPromise;
}

async function resolveBasePitchVideo(sb: Supabase): Promise<string | null> {
  if (config.basePitchVideoPath) {
    const local = path.resolve(config.basePitchVideoPath);
    try {
      await access(local);
      return local;
    } catch {
      throw new Error(`getBasePitchVideoPath: BASE_PITCH_VIDEO_PATH is set but file not found: ${local}`);
    }
  }
  return downloadBasePitchVideo(sb);
}

async function downloadBasePitchVideo(sb: Supabase): Promise<string | null> {
  const { data, error } = await sb
    .from("video_assets")
    .select("storage_path")
    .eq("type", "base_pitch_video")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getBasePitchVideoPath: ${error.message}`);
  if (!data?.storage_path) return null;

  const { data: file, error: downloadErr } = await sb.storage.from("video-assets").download(data.storage_path);
  if (downloadErr || !file) throw new Error(`getBasePitchVideoPath: download failed: ${downloadErr?.message}`);

  const localDir = path.join(config.tmpDir, "_assets");
  await mkdir(localDir, { recursive: true });
  const localPath = path.join(localDir, "base-pitch-video.mp4");
  await writeFile(localPath, Buffer.from(await file.arrayBuffer()));
  return localPath;
}
