export type OutreachVideoProps = {
  firstName: string;
  companyName: string;
  /** Local absolute path or URL to the generated hook MP3. */
  hookAudioPath: string;
  /** Local absolute path or URL to the prospect screenshot/recording. */
  screenAssetPath: string;
  /** Optional — no base pitch has been recorded yet, composition must work without it. */
  basePitchVideoPath?: string;
  ctaText?: string;
  brandColor?: string;
  /**
   * Length of the personalized hook segment, in frames. Computed by the
   * worker from the generated audio's duration (via ffprobe), with an 8s
   * floor — see worker/src/services/renderRemotionVideo.ts.
   */
  hookDurationInFrames: number;
  /** Total composition length, in frames. Drives Composition.calculateMetadata in Root.tsx. */
  durationInFrames: number;
};

/**
 * Img/Video assets are loaded through the headless browser's DOM, which
 * refuses to load `file://` resources even with web security disabled (only
 * <Audio> goes through Remotion's Node-side asset extraction and tolerates
 * local paths). The caller — worker/src/services/renderRemotionVideo.ts —
 * must serve every local asset over a local HTTP server and pass http(s) URLs.
 */
export function toMediaSrc(url: string): string {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`toMediaSrc: expected an http(s) URL (serve local files first), got: ${url}`);
  }
  return url;
}
