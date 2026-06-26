import { Composition } from "remotion";
import { PersonalizedOutreachVideo } from "./PersonalizedOutreachVideo";
import type { OutreachVideoProps } from "./types";

const FPS = 30;

const defaultProps: OutreachVideoProps = {
  firstName: "Alex",
  companyName: "Growth Academy",
  // Studio preview placeholders only — `npm run render:sample` serves the
  // real sample-assets/ over a throwaway local HTTP server and overrides
  // these (Img/Video require http(s) URLs, see toMediaSrc in types.ts).
  // Regenerate sample assets with:
  // ffmpeg -f lavfi -i "sine=frequency=440:duration=8" sample-assets/sample-hook.mp3
  // ffmpeg -f lavfi -i "color=c=0x286833:s=1920x1080" -frames:v 1 sample-assets/sample-screen.png
  hookAudioPath: "http://localhost:0/sample-hook.mp3",
  screenAssetPath: "http://localhost:0/sample-screen.png",
  ctaText: "I recorded a quick idea for your funnel",
  brandColor: "#286833",
  hookDurationInFrames: 8 * FPS,
  durationInFrames: 8 * FPS,
};

export function Root() {
  return (
    <Composition
      id="PersonalizedOutreachVideo"
      component={PersonalizedOutreachVideo}
      fps={FPS}
      width={1920}
      height={1080}
      durationInFrames={defaultProps.durationInFrames}
      defaultProps={defaultProps}
      calculateMetadata={async ({ props }) => ({
        durationInFrames: props.durationInFrames,
      })}
    />
  );
}
