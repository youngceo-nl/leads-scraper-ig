import type { AppSettings, ClaudeScore, ScrapedProfile } from "@/lib/types";
import type { ComputedMetrics } from "@/lib/pipeline/metrics";
import type { AiClassification } from "./types";

// Pure code-based scorer. Takes metrics + AI classification and produces the
// full ClaudeScore-shaped result. Deterministic — no AI in here.
//
// Weights (sum to 1.0):
//   traction      0.30
//   activity      0.20
//   monetization  0.30
//   icp_fit       0.20
//
// recommended_action thresholds:
//   overall >= qualified_threshold (default 7.5) -> "qualified"
//   overall >= review_threshold    (default 5.5) -> "review"
//   else                                         -> "reject"

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

// Activity is driven by reels posted in the last 30 days (the engagement metric).
// Thresholds are tuned for reel cadence — lower than total-post cadence.
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
  if (["course", "coaching", "agency", "saas", "ecom"].includes(c.business_model)) s += 2;
  else if (c.business_model === "creator") s += 0.5;
  return CLAMP(s);
}

function icpFitScore(
  c: AiClassification,
  profile: ScrapedProfile,
  settings: AppSettings,
): number {
  const kws = (settings.include_keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (kws.length === 0) {
    // No ICP defined — base on business_model signal.
    if (["course", "coaching", "agency", "saas"].includes(c.business_model)) return 7;
    if (c.business_model === "ecom") return 6;
    if (c.business_model === "creator") return 4.5;
    return 3;
  }
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
  // 0 hits → 3, 1 → 5.5, 2 → 7, 3+ → 9+
  return CLAMP(3 + hits * 2);
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

  const overall = CLAMP(
    traction * 0.3 + activity * 0.2 + monetization * 0.3 + icp_fit * 0.2,
  );

  const qualifiedThreshold = settings.crawl_score_threshold; // reuse
  const reviewThreshold = Math.max(0, qualifiedThreshold - 2);

  const recommended_action: ClaudeScore["recommended_action"] =
    overall >= qualifiedThreshold ? "qualified" :
    overall >= reviewThreshold    ? "review"    : "reject";

  const reason =
    `ER ${metrics.engagement_rate != null ? (metrics.engagement_rate * 100).toFixed(2) + "%" : "—"} → traction ${traction.toFixed(1)}. ` +
    `Reels 30d: ${metrics.reels_last_30_days ?? 0} → activity ${activity.toFixed(1)}. ` +
    `${classification.has_visible_offer ? "Visible offer" : "No clear offer"} (${classification.offer_confidence}), ` +
    `${classification.business_model} → monetization ${monetization.toFixed(1)}. ` +
    `ICP fit ${icp_fit.toFixed(1)}. Overall ${overall.toFixed(1)} → ${recommended_action}.`;

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
