import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getMediaDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    filePath,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe could not determine duration of ${filePath}`);
  return seconds;
}
