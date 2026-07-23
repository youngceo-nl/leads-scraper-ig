// Preset "why is this lead bad" categories — the training signal for
// docs/bottlenecks/bottleneck02.md. Structured categories (rather than free
// text alone) are what make the collection useful later: "stop qualifying
// off_icp leads shaped like X" is answerable; a pile of free-form notes isn't.
// Sibling of lib/leads/category.ts (the AI-derived Partnerships/Info/Other
// split) — this one is human-assigned, not derived.

export const BAD_LEAD_CATEGORIES = [
  "off_icp",
  "physical_product",
  "creator_no_offer",
  "agency_no_offer",
  "wrong_region",
  "other",
] as const;

export type BadLeadCategory = (typeof BAD_LEAD_CATEGORIES)[number];

export const BAD_LEAD_LABELS: Record<BadLeadCategory, string> = {
  off_icp: "Off-ICP / wrong niche",
  physical_product: "Physical product brand",
  creator_no_offer: "Creator, no offer",
  agency_no_offer: "Agency, no offer",
  wrong_region: "Wrong language / region",
  other: "Other",
};

export function isBadLeadCategory(value: string): value is BadLeadCategory {
  return (BAD_LEAD_CATEGORIES as readonly string[]).includes(value);
}
