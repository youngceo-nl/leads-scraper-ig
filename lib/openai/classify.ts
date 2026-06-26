import "server-only";
import OpenAI from "openai";
import { z } from "zod";
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

Output STRICT JSON only — no prose, no markdown.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["niche", "business_model", "offer_type", "audience_type", "has_visible_offer", "offer_confidence", "icp_signal"],
  properties: {
    niche:              { type: "string" },
    business_model:     { type: "string", enum: ["course", "coaching", "agency", "ecom", "saas", "creator", "unknown"] },
    offer_type:         { type: "string" },
    audience_type:      { type: "string" },
    has_visible_offer:  { type: "boolean" },
    offer_confidence:   { type: "string", enum: ["high", "medium", "low", "none"] },
    icp_signal:         { type: "string", enum: ["strong", "moderate", "weak"] },
  },
} as const;

const Parsed = z.object({
  niche: z.string(),
  business_model: z.enum(["course", "coaching", "agency", "ecom", "saas", "creator", "unknown"]),
  offer_type: z.string(),
  audience_type: z.string(),
  has_visible_offer: z.boolean(),
  offer_confidence: z.enum(["high", "medium", "low", "none"]),
  icp_signal: z.enum(["strong", "moderate", "weak"]),
});

export async function classifyWithOpenAi(opts: {
  apiKey: string;
  model: string;
  profile: ScrapedProfile;
}): Promise<{ classification: AiClassification; usage: { inputTokens: number; outputTokens: number } }> {
  const openai = new OpenAI({ apiKey: opts.apiKey });
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

Fields to return:
- niche: short phrase like "fitness coaching", "b2b saas", "beauty ecom"
- business_model: course / coaching / agency / ecom / saas / creator / unknown
    • course = sells an online course or program (even if the TOPIC is ecom, crypto, etc.)
    • coaching = sells 1:1 or group coaching / consulting
    • agency = runs a service agency (SMMA, marketing, etc.)
    • ecom = runs an online STORE selling physical or digital products (NOT someone who teaches ecom)
    • saas = sells software
    • creator = content creator with no clear paid offer
    • unknown = cannot determine
- offer_type: brief e.g. "$497 course", "free lead magnet", "DTC skincare", "1:1 coaching", "unknown"
- audience_type: who they serve, 1 line
- has_visible_offer: true ONLY if bio or captions clearly advertise a paid offer / product / service
- offer_confidence: high | medium | low | none
- icp_signal: strong | moderate | weak  (see system prompt for definitions)`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model: opts.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "classification", strict: true, schema: SCHEMA },
        },
        temperature: 0.2,
        max_tokens: 400,
      });
      const text = res.choices[0]?.message?.content ?? "";
      const classification = Parsed.parse(JSON.parse(text));
      return {
        classification,
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
  throw lastErr instanceof Error ? lastErr : new Error("OpenAI classification failed after retries");
}
