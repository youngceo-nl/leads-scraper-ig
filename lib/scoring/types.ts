// Narrow AI output — just the things code can't do (read bio + captions and
// infer what they're selling and to whom).
export type AiClassification = {
  niche: string;                       // e.g. "fitness coaching"
  business_model:                      // bucketed for filtering
    | "course" | "coaching" | "agency" | "ecom" | "saas" | "creator" | "unknown";
  offer_type: string;                  // brief: "$497 course", "1:1 coaching", "unknown"
  audience_type: string;               // e.g. "women 25-45 wanting to lose weight"
  has_visible_offer: boolean;          // bio/captions clearly mention a paid offer
  offer_confidence: "high" | "medium" | "low" | "none";
  // How well this account fits our ICP: high-ticket B2C coaches/consultants/info
  // product operators ($500+ offer, sold via calls/webinars, engaged audience).
  // strong   = clearly fits (coaching, consulting, info products, call-based sales)
  // moderate = partial fit (info content, creator with offer, unclear price point)
  // weak     = wrong industry (physical product, transport/service biz, B2B SaaS,
  //            pure content creator with no monetized offer)
  icp_signal: "strong" | "moderate" | "weak";
};
