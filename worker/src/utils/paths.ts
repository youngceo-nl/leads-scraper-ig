import { mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";

// All per-job working files live under tmp/<jobId>/ — kept on local disk for
// the duration of the job, then the relevant outputs are uploaded to Supabase
// Storage and the temp dir can be cleaned up.
export async function jobDir(jobId: string): Promise<string> {
  const dir = path.join(config.tmpDir, jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function jobFile(jobId: string, filename: string): string {
  return path.join(config.tmpDir, jobId, filename);
}
