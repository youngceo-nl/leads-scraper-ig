import { writeFile, rm, rename } from "node:fs/promises";
import OpenAI from "openai";
import { config } from "../config";
import { withRetry } from "../utils/retry";
import { normalizeAudioToMp3 } from "../utils/normalizeAudio";

export type GenerateVoiceMp3Input = {
  text: string;
  outputPath: string;
  voiceProfileId?: string;
};

/**
 * Swappable TTS adapter (TTS_PROVIDER env var, default "omnivoice").
 *
 * OmniVoice-Studio (https://github.com/debpalash/OmniVoice-Studio) exposes an
 * OpenAI-compatible `/v1/audio/speech` endpoint on its local backend
 * (default http://localhost:3900/v1, see docs/agentic-voice.md in that repo)
 * — same request/response shape as OpenAI's TTS API, contract-tested by their
 * own CI. That lets us reuse the `openai` SDK for both providers and just
 * swap `baseURL`/`apiKey`, rather than writing a bespoke HTTP client.
 *
 * OpenAI TTS remains available as a fallback (TTS_PROVIDER=openai) for use
 * before OmniVoice-Studio is installed/running, or if it's ever down.
 */
export async function generateVoiceMp3(
  input: GenerateVoiceMp3Input,
  opts: { openaiApiKey?: string } = {},
): Promise<string> {
  if (config.ttsProvider === "openai") return generateWithOpenAi(input, opts.openaiApiKey);
  return generateWithOmniVoiceStudio(input);
}

async function generateWithOpenAi(input: GenerateVoiceMp3Input, apiKey?: string): Promise<string> {
  const key = apiKey || config.openaiApiKeyEnv;
  if (!key) throw new Error("generateVoiceMp3(openai): no OpenAI API key configured");
  return speechToNormalizedMp3({
    client: new OpenAI({ apiKey: key }),
    model: "tts-1",
    voice: input.voiceProfileId || "alloy",
    text: input.text,
    outputPath: input.outputPath,
    // OpenAI's real API supports mp3 directly — skip the extra wav hop.
    responseFormat: "mp3",
  });
}

async function generateWithOmniVoiceStudio(input: GenerateVoiceMp3Input): Promise<string> {
  const baseUrl = config.omnivoiceStudioUrl ?? "http://localhost:3900/v1";
  await assertOmniVoiceReachable(baseUrl);
  return speechToNormalizedMp3({
    client: new OpenAI({ baseURL: baseUrl, apiKey: config.omnivoiceApiKey || "not-needed-locally" }),
    model: config.omnivoiceModel,
    voice: input.voiceProfileId || config.omnivoiceVoiceId,
    text: input.text,
    outputPath: input.outputPath,
    // docs/agentic-voice.md documents wav/pcm support explicitly; mp3 isn't
    // listed, so request wav and transcode (we normalize loudness anyway).
    responseFormat: "wav",
  });
}

async function assertOmniVoiceReachable(baseUrl: string): Promise<void> {
  const healthUrl = new URL("/health", baseUrl).toString();
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `generateVoiceMp3(omnivoice): backend not reachable at ${healthUrl} (${reason}). ` +
        "Make sure OmniVoice-Studio is running, or set TTS_PROVIDER=openai.",
    );
  }
}

async function speechToNormalizedMp3(opts: {
  client: OpenAI;
  model: string;
  voice: string;
  text: string;
  outputPath: string;
  responseFormat: "mp3" | "wav";
}): Promise<string> {
  const rawPath = opts.responseFormat === "mp3" ? opts.outputPath : `${opts.outputPath}.raw.wav`;

  await withRetry(async () => {
    const response = await opts.client.audio.speech.create({
      model: opts.model,
      voice: opts.voice,
      input: opts.text,
      response_format: opts.responseFormat,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(rawPath, buffer);
  });

  if (rawPath !== opts.outputPath) {
    await normalizeAudioToMp3(rawPath, opts.outputPath);
    await rm(rawPath, { force: true });
  } else {
    // Still normalize OpenAI's mp3 output in place via a temp file.
    const tmp = `${opts.outputPath}.tmp.mp3`;
    await normalizeAudioToMp3(opts.outputPath, tmp);
    await rm(opts.outputPath, { force: true });
    await rename(tmp, opts.outputPath);
  }

  return opts.outputPath;
}
