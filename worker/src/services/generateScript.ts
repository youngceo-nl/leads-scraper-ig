import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { VideoLead } from "../types";
import { withRetry } from "../utils/retry";

const SYSTEM = `You write the opening line of a personalized outreach video for a sales team targeting infopreneurs (course creators, coaches, consultants).

The line is spoken aloud over 5-10 seconds by an AI voice clone while the prospect's own website/profile is shown on screen. It is NOT the full pitch — a longer pre-recorded pitch plays right after it.

Rules:
- One sentence, 15-30 words, natural spoken English (no markdown, no quotes, no emoji).
- Reference something specific and plausible about their niche/offer — never generic ("Hey [name], I noticed you...").
- Confident, friendly, never salesy or hyperbolic.
- Output ONLY the line itself, nothing else.`;

export type GenerateScriptInput = Pick<
  VideoLead,
  "full_name" | "username" | "niche" | "business_model" | "offer_type" | "funnel_program_name"
>;

export function firstNameOf(lead: Pick<VideoLead, "full_name" | "username">): string {
  return lead.full_name?.trim().split(/\s+/)[0] || lead.username;
}

function buildUserPrompt(lead: GenerateScriptInput): string {
  const firstName = firstNameOf(lead);
  return `Write the opening line for this prospect:
- first name: ${firstName}
- program/company name: ${lead.funnel_program_name ?? "(unknown)"}
- niche: ${lead.niche ?? "(unknown)"}
- business model: ${lead.business_model ?? "(unknown)"}
- offer: ${lead.offer_type ?? "(unknown)"}`;
}

function cleanLine(text: string): string {
  return text.trim().replace(/^["']|["']$/g, "");
}

// Mirrors this repo's scoring_provider pattern (lib/openai/classify.ts,
// lib/claude/classify.ts) — pick whichever provider is actually configured,
// since this user's app_settings currently only has an OpenAI key.
export async function generateScript(opts: {
  provider: "claude" | "openai";
  apiKey: string;
  model: string;
  lead: GenerateScriptInput;
}): Promise<string> {
  const userPrompt = buildUserPrompt(opts.lead);

  if (opts.provider === "claude") {
    const claude = new Anthropic({ apiKey: opts.apiKey });
    return withRetry(async () => {
      const res = await claude.messages.create({
        model: opts.model,
        max_tokens: 120,
        system: SYSTEM,
        messages: [{ role: "user", content: userPrompt }],
      });
      const text = cleanLine(res.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
      if (!text) throw new Error("generateScript: empty response from Claude");
      return text;
    });
  }

  const openai = new OpenAI({ apiKey: opts.apiKey });
  return withRetry(async () => {
    const res = await openai.chat.completions.create({
      model: opts.model,
      max_tokens: 120,
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userPrompt },
      ],
    });
    const text = cleanLine(res.choices[0]?.message?.content ?? "");
    if (!text) throw new Error("generateScript: empty response from OpenAI");
    return text;
  });
}
