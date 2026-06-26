import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { getMediaDurationSeconds } from "../utils/ffprobe";
import { startStaticAssetServer } from "../utils/staticAssetServer";
import { jobFile } from "../utils/paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REMOTION_ENTRY = path.resolve(__dirname, "../../../remotion/src/index.ts");
const COMPOSITION_ID = "PersonalizedOutreachVideo";
const FPS = 30;
const HOOK_MIN_DURATION_IN_FRAMES = 8 * FPS;

export type RenderRemotionVideoInput = {
  jobId: string;
  firstName: string;
  companyName: string;
  /** Local absolute path to the generated hook MP3. */
  hookAudioPath: string;
  /** Local absolute path to the prospect screenshot/recording. */
  screenAssetPath: string;
  /** Optional — local absolute path; may live outside the job's tmp dir (e.g. a shared asset). */
  basePitchVideoPath?: string;
  ctaText?: string;
  brandColor?: string;
};

// Bundling the Remotion project is slow (webpack); do it once per worker
// process lifetime and reuse the bundle location for every job.
let bundleLocationPromise: Promise<string> | null = null;
function getBundleLocation(): Promise<string> {
  if (!bundleLocationPromise) {
    bundleLocationPromise = bundle({ entryPoint: REMOTION_ENTRY });
  }
  return bundleLocationPromise;
}

export async function renderRemotionVideo(input: RenderRemotionVideoInput): Promise<string> {
  const { jobId, hookAudioPath, screenAssetPath, basePitchVideoPath } = input;

  const hookSeconds = await getMediaDurationSeconds(hookAudioPath);
  const hookDurationInFrames = Math.max(HOOK_MIN_DURATION_IN_FRAMES, Math.ceil(hookSeconds * FPS));

  let pitchDurationInFrames = 0;
  if (basePitchVideoPath) {
    const pitchSeconds = await getMediaDurationSeconds(basePitchVideoPath);
    pitchDurationInFrames = Math.ceil(pitchSeconds * FPS);
  }
  const durationInFrames = hookDurationInFrames + pitchDurationInFrames;

  const assetPaths = [hookAudioPath, screenAssetPath, ...(basePitchVideoPath ? [basePitchVideoPath] : [])].map((p) =>
    path.resolve(p),
  );
  const server = await startStaticAssetServer(assetPaths);
  try {
    const inputProps = {
      firstName: input.firstName,
      companyName: input.companyName,
      hookAudioPath: server.urlFor(path.resolve(hookAudioPath)),
      screenAssetPath: server.urlFor(path.resolve(screenAssetPath)),
      basePitchVideoPath: basePitchVideoPath ? server.urlFor(path.resolve(basePitchVideoPath)) : undefined,
      ctaText: input.ctaText,
      brandColor: input.brandColor,
      hookDurationInFrames,
      durationInFrames,
    };

    const serveUrl = await getBundleLocation();
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });

    const outputLocation = jobFile(jobId, "rendered-video.mp4");
    await renderMedia({ composition, serveUrl, codec: "h264", outputLocation, inputProps });

    return outputLocation;
  } finally {
    await server.close();
  }
}
