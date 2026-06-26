import { AbsoluteFill, OffthreadVideo } from "remotion";
import { toMediaSrc } from "../types";

type Props = {
  basePitchVideoPath: string;
};

// 8s onward: the user's own pre-recorded pitch, played back unmodified.
// Only rendered when a base pitch video has actually been provided —
// PersonalizedOutreachVideo skips this segment entirely otherwise.
//
// OffthreadVideo (not Video) — the pitch recording can be 100MB+/several
// minutes; seeking that via the browser's <video> element timed out
// (delayRender exceeded 28s) during rendering. OffthreadVideo extracts
// frames server-side via ffmpeg instead, which is what Remotion recommends
// for exactly this case.
export function BasePitch({ basePitchVideoPath }: Props) {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <OffthreadVideo src={toMediaSrc(basePitchVideoPath)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
    </AbsoluteFill>
  );
}
