import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import { createClaude } from "@/lib/claude/client";
import { logLlmUsage } from "@/lib/usage/log-usage";
import type { AppSettings } from "@/lib/types";

type TokenUsage = { inputTokens: number; outputTokens: number };

const SYSTEM = `You analyze a marketing landing/funnel page for a B2B outbound team.
Identify the specific NAMED coaching program, course, mastermind, or workshop being sold.

program_name rules — return null unless ALL of these are true:
- It is a NAMED offer with its own title (e.g. "7-Figure Blueprint", "Optics Academy", "Elite Mastermind")
- It is NOT just a brand name, store name, personal name, or website name
- It is NOT a Discord server, community invite, or social media page
- It is NOT an e-commerce store or generic product listing
- A person named "Mayhem Optics" selling sunglasses → null. A coach selling "The Optics Academy" → ok.

program_name format:
- Use the SHORT brand name of the program: 1–3 words preferred, 4 maximum
- Drop generic filler words: "The", "My", "Our", year suffixes like "2025", tagline phrases
- Examples: "7-Figure Blueprint" not "The Ultimate 7-Figure Funnel Blueprint System"; "Elite Mastermind" not "Join Our Elite Mastermind Community 2025"
- If the real name is genuinely short already (e.g. "FBA Academy"), keep it as-is

Output STRICT JSON. Be decisive.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["program_name", "offer_summary", "price", "confidence"],
  properties: {
    program_name:  { type: ["string", "null"] },
    offer_summary: { type: ["string", "null"] },
    price:         { type: ["string", "null"] },
    confidence:    { type: "string", enum: ["high", "medium", "low", "none"] },
  },
} as const;

const Parsed = z.object({
  program_name: z.string().nullable(),
  offer_summary: z.string().nullable(),
  price: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low", "none"]),
});

export type LlmFunnelExtraction = z.infer<typeof Parsed>;

export async function llmExtractFunnel(opts: {
  settings: AppSettings;
  url: string;
  platform: string;
  hints: { program_name: string | null; offer_summary: string | null; price: string | null };
  pageText: string;
  leadId?: string | null;
}): Promise<{ extraction: LlmFunnelExtraction; provider: "openai" | "claude" }> {
  const userPrompt = buildPrompt(opts);

  if (opts.settings.scoring_provider === "openai") {
    const apiKey = opts.settings.openai_api_key || process.env.OPENAI_API_KEY || "";
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
    const model = opts.settings.openai_model || "gpt-4o-mini";
    const { extraction, usage } = await runOpenAi({ apiKey, model, userPrompt });
    await logLlmUsage({
      provider: "openai",
      model,
      operation: "funnel_extract",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      leadId: opts.leadId ?? null,
    });
    return { extraction, provider: "openai" };
  }

  const apiKey = opts.settings.claude_api_key || process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const { extraction, usage } = await runClaude({
    apiKey,
    model: opts.settings.claude_model,
    userPrompt,
  });
  await logLlmUsage({
    provider: "claude",
    model: opts.settings.claude_model,
    operation: "funnel_extract",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    leadId: opts.leadId ?? null,
  });
  return { extraction, provider: "claude" };
}

function buildPrompt(opts: {
  url: string;
  platform: string;
  hints: { program_name: string | null; offer_summary: string | null; price: string | null };
  pageText: string;
}): string {
  return `Page URL: ${opts.url}
Detected platform: ${opts.platform}

Heuristic hints (may be wrong):
- program_name candidate: ${opts.hints.program_name ?? "(none)"}
- offer_summary candidate: ${opts.hints.offer_summary ?? "(none)"}
- price candidate: ${opts.hints.price ?? "(none)"}

PAGE TEXT (truncated):
${opts.pageText}

Return JSON with:
- program_name: the SHORT name (1–3 words) of the specific named program/course/mastermind/workshop (e.g. "7-Figure Blueprint", "Elite Mastermind", "FBA Academy"). Strip generic filler ("The", year suffixes, tagline phrases). Return null for e-commerce stores, Discord servers, aggregator pages, personal brand pages, and anything without a distinct named offer.
- offer_summary: one sentence describing what's being offered and to whom. Null if unclear.
- price: a price string like "$497", "$997 + $97/mo", "free", or null if no price is visible.
- confidence: high|medium|low|none — your confidence that program_name is a real named offer (not just a brand/store name).`;
}

async function runOpenAi(opts: { apiKey: string; model: string; userPrompt: string }): Promise<{ extraction: LlmFunnelExtraction; usage: TokenUsage }> {
  const openai = new OpenAI({ apiKey: opts.apiKey });
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model: opts.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: opts.userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "funnel_extraction", strict: true, schema: SCHEMA },
        },
        temperature: 0.2,
        max_tokens: 400,
      });
      const text = res.choices[0]?.message?.content ?? "";
      const extraction = Parsed.parse(JSON.parse(text));
      return {
        extraction,
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        },
      };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("OpenAI funnel extraction failed");
}

async function runClaude(opts: { apiKey: string; model: string; userPrompt: string }): Promise<{ extraction: LlmFunnelExtraction; usage: TokenUsage }> {
  const claude = createClaude(opts.apiKey);
  const SCHEMA_HINT = `{
  "program_name": string|null,
  "offer_summary": string|null,
  "price": string|null,
  "confidence": "high"|"medium"|"low"|"none"
}`;
  const fullUser = `${opts.userPrompt}\n\nReturn ONLY a JSON object matching:\n${SCHEMA_HINT}`;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await claude.messages.create({
        model: opts.model,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: fullUser }],
      });
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      const s = stripped.indexOf("{");
      const e = stripped.lastIndexOf("}");
      const slice = s !== -1 && e > s ? stripped.slice(s, e + 1) : stripped;
      const extraction = Parsed.parse(JSON.parse(slice));
      return {
        extraction,
        usage: {
          inputTokens: res.usage?.input_tokens ?? 0,
          outputTokens: res.usage?.output_tokens ?? 0,
        },
      };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Claude funnel extraction failed");
}
