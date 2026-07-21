import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { leadCategory } from "@/lib/leads/category";

export type SeedCandidate = {
  username: string;
  full_name: string | null;
  niche: string | null;
  business_model: string | null;
  icp_fit_score: number | null;
  overall_score: number | null;
  followers: number | null;
  following: number | null;
  /** The one seed leads.parent_username actually recorded — free provenance. */
  foundViaSeed: string | null;
  /** Distinct seeds this account has been seen following, per following_edges.
   *  0 or 1 for almost everything today (see the migration's backfill note) —
   *  grows as more seeds get scraped and genuinely overlap. */
  seedOverlap: number;
  score: number;
};

/**
 * Ranks leads-we-already-have as candidates to promote to seed accounts.
 * Nothing here is auto-added — this is a suggestion list for a human to pick
 * from on the Source Accounts page (docs/seeds/seedpicker.md).
 *
 * Scoring combines every signal actually available:
 *  - business_model: 'agency' scores highest — the @kishanslings example in
 *    the spec ("sales agency in the info space"), detectable from bio alone
 *    before any following-list scrape. coaching/course (infopreneurs) score
 *    slightly lower but still qualify; everything else is excluded entirely.
 *  - icp_fit_score: the AI's own "how well does this fit our ICP" score —
 *    this *is* the shared-ICP signal the operator asked for.
 *  - overall_score: general lead quality.
 *  - following: a seed's own following-list size is the ceiling on how much
 *    a scrape of it can yield, so a bigger following is worth more here,
 *    capped so one outlier account can't dominate the ranking.
 *  - seedOverlap: true network correlation (an account followed by multiple
 *    existing seeds). Real edges only exist for scrapes run after
 *    following_edges was added — see that migration for why history can't be
 *    reconstructed — so this is 0 or 1 for almost every candidate today and
 *    strengthens automatically as more seeds get (re-)scraped.
 */
export async function getRecommendedSeeds(limit = 5): Promise<SeedCandidate[]> {
  const sb = createAdminClient();

  const [{ data: seeds }, { data: rejected }, { data: leads }] = await Promise.all([
    sb.from("seeds").select("username"),
    sb.from("rejected_seeds").select("username"),
    sb
      .from("leads")
      .select("username, full_name, niche, business_model, icp_fit_score, overall_score, followers, following, parent_username")
      .in("business_model", ["agency", "coaching", "course"])
      .in("status", ["qualified", "review"]),
  ]);

  const seedUsernames = new Set((seeds ?? []).map((s) => s.username));
  const rejectedUsernames = new Set((rejected ?? []).map((r) => r.username));

  const pool = (leads ?? []).filter(
    (l) => !seedUsernames.has(l.username) && !rejectedUsernames.has(l.username),
  );
  if (!pool.length) return [];

  // Overlap counts — one column, cheap even at thousands of edges; grouping
  // client-side avoids needing an RPC for what's a small aggregate.
  const candidateUsernames = new Set(pool.map((l) => l.username));
  const { data: edges } = await sb
    .from("following_edges")
    .select("seed_username, followed_username")
    .in("followed_username", [...candidateUsernames]);

  const overlapBySeeds = new Map<string, Set<string>>();
  for (const e of edges ?? []) {
    const set = overlapBySeeds.get(e.followed_username) ?? new Set();
    set.add(e.seed_username);
    overlapBySeeds.set(e.followed_username, set);
  }

  const businessModelWeight = (bm: string | null): number => {
    if (leadCategory(bm) === "partnerships") return 2; // agency
    if (leadCategory(bm) === "info") return 1.5;        // coaching / course
    return 0;
  };

  const scored: SeedCandidate[] = pool.map((l) => {
    const seedOverlap = overlapBySeeds.get(l.username)?.size ?? 0;
    const score =
      businessModelWeight(l.business_model) +
      ((l.icp_fit_score ?? 0) / 10) * 3 +          // 0-3 pts — shared-ICP signal
      ((l.overall_score ?? 0) / 10) * 2 +           // 0-2 pts — general quality
      (Math.min(l.following ?? 0, 2000) / 2000) * 2 + // 0-2 pts — harvest size, capped
      Math.min(seedOverlap, 3) * 1.5;                // 0-4.5 pts — network correlation

    return {
      username: l.username,
      full_name: l.full_name,
      niche: l.niche,
      business_model: l.business_model,
      icp_fit_score: l.icp_fit_score,
      overall_score: l.overall_score,
      followers: l.followers,
      following: l.following,
      foundViaSeed: l.parent_username,
      seedOverlap,
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
