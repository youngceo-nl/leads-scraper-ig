import "server-only";
import { z } from "zod";
import type { AiClassification } from "@/lib/scoring/types";
import type { ScrapedProfile } from "@/lib/types";

const SYSTEM = `You are classifying Instagram accounts for a sales outreach team targeting INFOPRENEURS and AD/SALES AGENCIES.

An infopreneur sells KNOWLEDGE or EXPERTISE as a digital product (course, coaching program, mastermind, consulting) to a B2C audience. They close sales via DMs, calls, or webinars — not a checkout button.

An ad/sales agency sells marketing, advertising, or sales services (media buying, funnel building, appointment setting, lead generation, SMMA, sales consulting) to OTHER BUSINESSES (B2B). They typically show client results, case studies, or a "DM to work with us" / "book a call" offer.

DEFAULT RULE: Assume "weak" unless there is explicit evidence of an info/knowledge business OR an ad/sales agency with a visible B2B offer. High engagement, a big following, or a link in bio are NOT enough on their own.

icp_signal:
- "strong": account clearly sells a digital knowledge product — bio/captions mention coaching program, course, mastermind, DM to apply, book a call, webinar, or show client results/revenue proof — OR is an ad/sales agency with visible client results, case studies, testimonials, or a clear "DM/book a call to work with us" offer
- "moderate": account is in the right INDUSTRY (education, coaching, consulting, or a marketing/ad/sales agency) but the offer or proof is unclear — e.g., educates in their niche or runs an agency but no paid product / client results are obvious
- "weak": EVERYTHING ELSE — this includes:
  • Any physical product brand (food, candy, clothing, beauty, supplements, DTC, merch) — even if the founder is an "influencer"
  • Service businesses unrelated to marketing/sales (restaurant, salon, contractor, transport)
  • Agencies with no visible client results, case studies, or B2B offer — just a name/logo
  • B2B SaaS or software
  • Pure content creators, entertainers, meme pages, news accounts
  • Influencers whose only monetisation is affiliate links or brand deals
  • Brands that sell via an online store / checkout button

When in doubt, use "weak". Engagement and follower count do not affect icp_signal.

business_model must be EXACTLY one of: course, coaching, agency, ecom, saas, creator, unknown — never invent other values (e.g. "service"). Use "agency" for any service-based business, including ad/sales/marketing agencies.

Output STRICT JSON only — no prose, no markdown, no code fences.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    niche: { type: "STRING" },
    business_model: { type: "STRING", enum: ["course", "coaching", "agency", "ecom", "saas", "creator", "unknown"] },
    offer_type: { type: "STRING" },
    audience_type: { type: "STRING" },
    has_visible_offer: { type: "BOOLEAN" },
    offer_confidence: { type: "STRING", enum: ["high", "medium", "low", "none"] },
    icp_signal: { type: "STRING", enum: ["strong", "moderate", "weak"] },
  },
  required: ["niche", "business_model", "offer_type", "audience_type", "has_visible_offer", "offer_confidence", "icp_signal"],
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

// Free-tier Gemini caps out around ~15 requests/minute. score-lead's Inngest
// concurrency (8 per batch, 16 global) was tuned for paid providers and would
// blow straight through that — and it can't be made provider-aware because
// Inngest's concurrency key only sees event payload, not the scoring_provider
// DB setting. So pace actual outbound calls in-process instead: queue behind
// a rolling per-minute cap, comfortably under the real limit.
const MAX_CALLS_PER_WINDOW = 12;
const WINDOW_MS = 60_000;
const callTimestamps: number[] = [];

async function waitForRateLimitSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (callTimestamps.length && now - callTimestamps[0] > WINDOW_MS) callTimestamps.shift();
    if (callTimestamps.length < MAX_CALLS_PER_WINDOW) {
      callTimestamps.push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, callTimestamps[0] + WINDOW_MS - now + 50));
  }
}

export async function classifyWithGemini(opts: {
  apiKey: string;
  model: string;
  profile: ScrapedProfile;
}): Promise<{ classification: AiClassification; usage: { inputTokens: number; outputTokens: number } }> {
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
${captions || "(none)"}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${opts.apiKey}`;

  let lastErr: unknown = null;
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await waitForRateLimitSlot();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 400,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
      });
      if (res.status === 429) {
        // Still got rate-limited despite pacing (e.g. quota shared with other
        // usage) — back off long enough to actually clear a per-minute window,
        // honoring Retry-After if Google sends one.
        const retryAfterSec = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : Math.min(60_000, 5000 * 2 ** attempt);
        lastErr = new Error(`Gemini 429: rate limited — ${await res.text()}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      const body = await res.json();
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const classification = Parsed.parse(JSON.parse(text));
      return {
        classification,
        usage: {
          inputTokens: body?.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: body?.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Gemini classification failed after retries");
}
