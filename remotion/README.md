# PersonalizedOutreachVideo (Remotion)

The video composition used by `worker/src/services/renderRemotionVideo.ts` to
render outreach videos. See `../worker/README.md` for the full pipeline this
fits into.

## Composition

`src/PersonalizedOutreachVideo.tsx` — accepts `OutreachVideoProps` (see
`src/types.ts`): a personalized hook (audio + screenshot, 0–8s minimum),
an optional base pitch video segment, and an optional CTA overlay at the end.

Img/Video assets **must** be http(s) URLs, not local file paths — Chrome
refuses to load `file://` resources from a bundled page even with web
security disabled (only `<Audio>` survives this, via Remotion's Node-side
asset extraction). The worker serves per-job assets over a throwaway local
HTTP server before rendering — see `toMediaSrc()` in `src/types.ts`.

## Commands

```bash
npm install
npm run studio          # Remotion Studio — interactive preview
npm run render:sample    # self-contained sanity render -> out/sample.mp4
```

`render:sample` (`scripts/render-sample.mjs`) serves `sample-assets/` over a
local HTTP server and renders with `sample-props.json`. Regenerate the
sample assets with:

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=8" sample-assets/sample-hook.mp3
ffmpeg -f lavfi -i "color=c=0x286833:s=1920x1080" -frames:v 1 sample-assets/sample-screen.png
```
