import { AbsoluteFill, Audio, interpolate, useCurrentFrame } from "remotion";
import { toMediaSrc } from "../types";
import { ScreenRecording } from "./ScreenRecording";

type Props = {
  firstName: string;
  companyName: string;
  hookAudioPath: string;
  screenAssetPath: string;
  brandColor: string;
  durationInFrames: number;
};

// 0-8s segment: personalized hook audio plays over a slow pan/zoom of the
// prospect's screenshot, with name/company overlaid.
export function HookIntro({ firstName, companyName, hookAudioPath, screenAssetPath, brandColor, durationInFrames }: Props) {
  const frame = useCurrentFrame();
  const labelOpacity = interpolate(frame, [0, 15, durationInFrames - 15, durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Audio src={toMediaSrc(hookAudioPath)} />
      <ScreenRecording screenAssetPath={screenAssetPath} durationInFrames={durationInFrames} />
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          padding: 48,
          background: "linear-gradient(to top, rgba(0,0,0,0.65), transparent 40%)",
        }}
      >
        <div style={{ opacity: labelOpacity, display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ color: "#fff", fontSize: 44, fontWeight: 700, fontFamily: "Arial, sans-serif" }}>{firstName}</span>
          <span
            style={{
              color: brandColor,
              fontSize: 26,
              fontWeight: 600,
              fontFamily: "Arial, sans-serif",
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            {companyName}
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
