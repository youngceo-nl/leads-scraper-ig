import { AbsoluteFill, Img, OffthreadVideo, interpolate, useCurrentFrame } from "remotion";
import { toMediaSrc } from "../types";

type Props = {
  screenAssetPath: string;
  durationInFrames: number;
};

const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov"];

// Renders the prospect's site/profile as a slow pan/zoom background. MVP uses
// a screenshot (recommended in the source spec as more reliable than a live
// scroll recording); a real Playwright video recording is also supported if
// recordProspectPage() ever produces one — detected by file extension.
export function ScreenRecording({ screenAssetPath, durationInFrames }: Props) {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, durationInFrames], [1.02, 1.18], { extrapolateRight: "clamp" });
  const isVideo = VIDEO_EXTENSIONS.some((ext) => screenAssetPath.toLowerCase().endsWith(ext));

  return (
    <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: "center" }}>
      {isVideo ? (
        <OffthreadVideo src={toMediaSrc(screenAssetPath)} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <Img src={toMediaSrc(screenAssetPath)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      )}
    </AbsoluteFill>
  );
}
