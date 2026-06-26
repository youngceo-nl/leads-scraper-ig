import { AbsoluteFill, Sequence } from "remotion";
import type { OutreachVideoProps } from "./types";
import { HookIntro } from "./components/HookIntro";
import { ScreenRecording } from "./components/ScreenRecording";
import { BasePitch } from "./components/BasePitch";
import { CTA } from "./components/CTA";

const CTA_DURATION_IN_FRAMES = 150; // ~5s at 30fps

export function PersonalizedOutreachVideo({
  firstName,
  companyName,
  hookAudioPath,
  screenAssetPath,
  basePitchVideoPath,
  ctaText,
  brandColor = "#286833",
  hookDurationInFrames,
  durationInFrames,
}: OutreachVideoProps) {
  const hasBasePitch = !!basePitchVideoPath;
  const pitchDurationInFrames = Math.max(0, durationInFrames - hookDurationInFrames);
  const ctaStart = Math.max(0, durationInFrames - CTA_DURATION_IN_FRAMES);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Sequence from={0} durationInFrames={hookDurationInFrames} layout="none">
        <HookIntro
          firstName={firstName}
          companyName={companyName}
          hookAudioPath={hookAudioPath}
          screenAssetPath={screenAssetPath}
          brandColor={brandColor}
          durationInFrames={hookDurationInFrames}
        />
      </Sequence>

      {hasBasePitch ? (
        <Sequence from={hookDurationInFrames} durationInFrames={pitchDurationInFrames} layout="none">
          <BasePitch basePitchVideoPath={basePitchVideoPath!} />
        </Sequence>
      ) : (
        // No base pitch recorded yet (see project plan) — keep the screen
        // asset on screen for any leftover duration instead of cutting to black.
        pitchDurationInFrames > 0 && (
          <Sequence from={hookDurationInFrames} durationInFrames={pitchDurationInFrames} layout="none">
            <ScreenRecording screenAssetPath={screenAssetPath} durationInFrames={pitchDurationInFrames} />
          </Sequence>
        )
      )}

      {ctaText && (
        <Sequence from={ctaStart} durationInFrames={Math.min(CTA_DURATION_IN_FRAMES, durationInFrames)} layout="none">
          <CTA ctaText={ctaText} brandColor={brandColor} durationInFrames={Math.min(CTA_DURATION_IN_FRAMES, durationInFrames)} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
}
