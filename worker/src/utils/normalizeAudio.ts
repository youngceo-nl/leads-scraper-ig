import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Voice-cloned TTS output can have inconsistent loudness — normalize before
// handing audio to Remotion, per the project spec's explicit instruction.
export async function normalizeAudioToMp3(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", "-i", inputPath, "-af", "loudnorm", outputPath]);
}
