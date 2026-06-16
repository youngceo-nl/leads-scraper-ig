import "server-only";
import { z } from "zod";
import { createClaude } from "./client";
import type { AiClassification } from "@/lib/scoring/types";
import type { ScrapedProfile } from "@/lib/types";

const SYSTEM = `You are classifying Instagram accounts for a sales outreach team targeting INFOPRENEURS ONLY.

An infopreneur sells KNOWLEDGE or EXPERTISE as a digital product (course, coaching program, mastermind, consulting) to a B2C audience. They close sales via DMs, calls, or webinars — not a checkout button.

DEFAULT RULE: Assume "weak" unless there is explicit evidence of an info/knowledge business. High engagement, a big following, or a link in bio are NOT enough on their own.

icp_signal:
- "strong": account clearly sells a digital knowledge product — bio/captions mention coaching program, course, mastermind, DM to apply, book a call, webinar, or show client results/revenue proof
- "moderate": account is in the right INDUSTRY (education, coaching, consulting) but the offer or price point is unclear — e.g., educates in their niche but no paid product is obvious
- "weak": EVERYTHING ELSE — this includes:
  • Any physical product brand (food, candy, clothing, beauty, supplements, DTC, merch) — even if the founder is an "influencer"
  • Service businesses (restaurant, salon, agency, contractor, transport)
  • B2B SaaS or software
  • Pure content creators, entertainers, meme pages, news accounts
  • Influencers whose only monetisation is affiliate links or brand deals
  • Brands that sell via an online store / checkout button

When in doubt, use "weak". Engagement and follower count do not affect icp_signal.

Output STRICT JSON only — no prose, no markdown, no code fences.`;

const SCHEMA_HINT = `{
  "niche": string,
  "business_model": "course"|"coaching"|"agency"|"ecom"|"saas"|"creator"|"unknown",
  "offer_type": string,
  "audience_type": string,
  "has_visible_offer": boolean,
  "offer_confidence": "high"|"medium"|"low"|"none",
  "icp_signal": "strong"|"moderate"|"weak"
}`;

const Parsed = z.object({
  niche: z.string(),
  business_model: z.enum(["course", "coaching", "agency", "ecom", "saas", "creator", "unknown"]),
  offer_type: z.string(),
  audience_type: z.string(),
  has_visible_offer: z.boolean(),
  offer_confidence: z.enum(["high", "medium", "low", "none"]),
  icp_signal: z.enum(["strong", "moderate", "weak"]),
});

export async function classifyWithClaude(opts: {
  apiKey: string;
  model: string;
  profile: ScrapedProfile;
}): Promise<{ classification: AiClassification; usage: { inputTokens: number; outputTokens: number } }> {
  const claude = createClaude(opts.apiKey);
  const captions = (opts.profile.recent_posts || [])
    .slice(0, 5)
    .map((p, i) => `${i + 1}. ${(p.caption ?? "").slice(0, 240)}`)
    .join("\n");

  const userPrompt = `Classify this Instagram account.

PROFILE
- username: @${opts.profile.username}
- full_name: ${opts.profile.full_name ?? ""}
- bio: ${opts.profile.bio ?? ""}
- external_link: ${opts.profile.external_link ?? "(none)"}

RECENT CAPTIONS
${captions || "(none)"}

Return ONLY a JSON object matching:
${SCHEMA_HINT}`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await claude.messages.create({
        model: opts.model,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: userPrompt }],
      });
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      const s = stripped.indexOf("{");
      const e = stripped.lastIndexOf("}");
      const slice = s !== -1 && e > s ? stripped.slice(s, e + 1) : stripped;
      const classification = Parsed.parse(JSON.parse(slice));
      return {
        classification,
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
  throw lastErr instanceof Error ? lastErr : new Error("Claude classification failed after retries");
}
