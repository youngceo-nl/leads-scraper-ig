import type { AppSettings, ClaudeScore, ScrapedProfile } from "@/lib/types";
import type { ComputedMetrics } from "@/lib/pipeline/metrics";
import type { AiClassification } from "./types";

// Pure code-based scorer. Takes metrics + AI classification and produces the
// full ClaudeScore-shaped result. Deterministic — no AI in here.
//
// Weights (sum to 1.0):
//   traction      0.25
//   activity      0.15
//   monetization  0.25
//   icp_fit       0.35   ← raised; ICP alignment is the primary gate
//
// Hard cap: icp_signal === "weak" → overall capped at 6.5 (never qualifies)
//
// Qualified threshold: crawl_score_threshold (default 7.5)

const ROUND = (n: number) => Math.round(n * 10) / 10;
const CLAMP = (n: number, lo = 0, hi = 10) => Math.max(lo, Math.min(hi, n));

function tractionScore(m: ComputedMetrics): number {
  if (m.engagement_rate == null) return 0;
  const erPct = m.engagement_rate * 100;
  // Piecewise curve tuned for IG mid-tier creators
  if (erPct >= 6)   return 10;
  if (erPct >= 4)   return 9;
  if (erPct >= 2.5) return 8;
  if (erPct >= 1.5) return 6.5;
  if (erPct >= 0.8) return 5;
  if (erPct >= 0.3) return 3;
  return 1;
}

function activityScore(m: ComputedMetrics): number {
  const reels30 = m.reels_last_30_days ?? 0;
  if (reels30 >= 12) return 10;
  if (reels30 >= 8)  return 8.5;
  if (reels30 >= 4)  return 7;
  if (reels30 >= 2)  return 5;
  if (reels30 >= 1)  return 3;
  return 0;
}

function monetizationScore(c: AiClassification, profile: ScrapedProfile): number {
  let s = 0;
  if (profile.external_link && profile.external_link.trim().length > 0) s += 2;
  if (c.has_visible_offer) s += 3;
  switch (c.offer_confidence) {
    case "high":   s += 3; break;
    case "medium": s += 2; break;
    case "low":    s += 1; break;
    case "none":   break;
  }
  if (["course", "coaching"].includes(c.business_model)) s += 2;
  else if (["agency", "saas", "ecom"].includes(c.business_model)) s += 0.5;
  else if (c.business_model === "creator") s += 0.5;
  return CLAMP(s);
}

function icpFitScore(
  c: AiClassification,
  profile: ScrapedProfile,
  settings: AppSettings,
): number {
  // Physical product ecom brands are wrong-fit regardless of engagement — override AI signal
  const signal = c.business_model === "ecom" ? "weak" : c.icp_signal;

  // Primary signal: AI-assessed ICP alignment (see docs/icp.md)
  let base: number;
  switch (signal) {
    case "strong":   base = 9.0; break;
    case "moderate": base = 5.5; break;
    case "weak":     base = 1.5; break;
    default:         base = 4.0; break;
  }

  // Keyword boosting (when include_keywords is configured)
  const kws = (settings.include_keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (kws.length > 0) {
    const hay = [
      profile.bio ?? "",
      c.niche ?? "",
      c.business_model ?? "",
      c.offer_type ?? "",
      c.audience_type ?? "",
    ]
      .join(" ")
      .toLowerCase();
    const hits = kws.filter((kw) => hay.includes(kw)).length;
    // Each keyword hit nudges the score up (max +2 total)
    base = Math.min(10, base + Math.min(hits, 4) * 0.5);
  }

  // Bio-level ICP signal boosts (language that directly matches the ICP)
  const bio = (profile.bio ?? "").toLowerCase();
  const captions = ((profile as { recent_posts?: Array<{ caption?: string | null }> }).recent_posts ?? [])
    .slice(0, 5)
    .map((p) => (p.caption ?? "").toLowerCase())
    .join(" ");
  const content = bio + " " + captions;

  // High-ticket call-based sales signals (strongest ICP fit indicator)
  if (/\bdm\s+(me|to|for|apply|now)\b|\bbook\s+a\s+call\b|\bapply\s+(below|now|here|to\s+work)\b|\bsales\s+call\b/.test(content)) {
    base = Math.min(10, base + 0.5);
  }
  // Webinar / VSL funnel signals
  if (/\bwebinar\b|\bmasterclass\b|\bvsl\b|\bfree\s+training\b|\bwatch\s+(the|my|free)\b/.test(content)) {
    base = Math.min(10, base + 0.5);
  }
  // Revenue / results proof (authority signal the ICP doc highlights)
  if (/\b\d[\d,.]*[k]?\s*\/\s*(month|mo|year|yr)\b|\b[67]-?figure\b|\b\$[\d,.]+[kKmM]\b/.test(content)) {
    base = Math.min(10, base + 0.3);
  }

  return CLAMP(base);
}

export function computeScores(args: {
  profile: ScrapedProfile;
  metrics: ComputedMetrics;
  classification: AiClassification;
  settings: AppSettings;
}): ClaudeScore {
  const { profile, metrics, classification, settings } = args;

  const traction     = tractionScore(metrics);
  const activity     = activityScore(metrics);
  const monetization = monetizationScore(classification, profile);
  const icp_fit      = icpFitScore(classification, profile, settings);

  // Weights: ICP fit raised to 35% — being the right kind of account matters most.
  const raw = traction * 0.25 + activity * 0.15 + monetization * 0.25 + icp_fit * 0.35;

  // Hard cap: "weak" ICP signal or physical-product ecom means wrong industry —
  // never let high engagement or monetization alone push them through.
  const effectiveIcpSignal =
    classification.business_model === "ecom" ? "weak" : classification.icp_signal;
  const cap = effectiveIcpSignal === "weak" ? 6.5 : 10;
  const overall = CLAMP(raw, 0, cap);

  const qualifiedThreshold = settings.crawl_score_threshold;
  const reviewThreshold = Math.max(0, qualifiedThreshold - 2);

  const recommended_action: ClaudeScore["recommended_action"] =
    overall >= qualifiedThreshold ? "qualified" :
    overall >= reviewThreshold    ? "review"    : "reject";

  const icpSignalLabel =
    classification.business_model === "ecom" && classification.icp_signal !== "weak"
      ? `${classification.icp_signal}→weak(ecom)`
      : effectiveIcpSignal;

  const reason =
    `ICP signal: ${icpSignalLabel} → icp_fit ${icp_fit.toFixed(1)}. ` +
    `ER ${metrics.engagement_rate != null ? (metrics.engagement_rate * 100).toFixed(2) + "%" : "—"} → traction ${traction.toFixed(1)}. ` +
    `Reels 30d: ${metrics.reels_last_30_days ?? 0} → activity ${activity.toFixed(1)}. ` +
    `${classification.has_visible_offer ? "Visible offer" : "No clear offer"} (${classification.offer_confidence}), ` +
    `${classification.business_model} → monetization ${monetization.toFixed(1)}. ` +
    `${effectiveIcpSignal === "weak" ? `Capped at ${cap}. ` : ""}` +
    `Overall ${overall.toFixed(1)} → ${recommended_action}.`;

  return {
    icp_fit_score:      ROUND(icp_fit),
    traction_score:     ROUND(traction),
    monetization_score: ROUND(monetization),
    activity_score:     ROUND(activity),
    overall_score:      ROUND(overall),
    niche:              classification.niche,
    business_model:     classification.business_model,
    offer_type:         classification.offer_type,
    audience_type:      classification.audience_type,
    reason_for_score:   reason,
    recommended_action,
  };
}
