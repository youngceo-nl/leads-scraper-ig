import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

type Props = {
  ctaText: string;
  brandColor: string;
  durationInFrames: number;
};

// Final overlay (last ~5s), layered on top of whatever is playing underneath
// (base pitch if present, otherwise the screen recording continues).
export function CTA({ ctaText, brandColor, durationInFrames }: Props) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12, durationInFrames - 12, durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 64 }}>
      <div
        style={{
          opacity,
          background: brandColor,
          color: "#fff",
          fontFamily: "Arial, sans-serif",
          fontSize: 32,
          fontWeight: 700,
          padding: "16px 32px",
          borderRadius: 12,
        }}
      >
        {ctaText}
      </div>
    </AbsoluteFill>
  );
}
