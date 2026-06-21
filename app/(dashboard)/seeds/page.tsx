import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SeedManager } from "@/components/seeds/seed-manager";
import { CrawlJobsList } from "@/components/seeds/crawl-jobs-list";
import { BioCoverageCard } from "@/components/seeds/bio-coverage";
import { SeedDiscovery } from "@/components/seeds/seed-discovery";
import { SuggestedSeeds } from "@/components/seeds/suggested-seeds";
import { getSettings } from "@/lib/config/settings";
import { getBioCoverage } from "@/app/actions/backfill-bios";

export const dynamic = "force-dynamic";

export default async function SeedsPage() {
  const sb = createAdminClient();
  const [{ data: allSeeds }, { data: jobs }, settings, coverage] = await Promise.all([
    sb.from("seeds").select("*").order("created_at", { ascending: false }),
    sb.from("crawl_jobs").select("*, seeds(username)").order("created_at", { ascending: false }).limit(15),
    getSettings(),
    getBioCoverage(),
  ]);

  const seeds = (allSeeds ?? []).filter((s) => !(s.exhausted_providers as string[])?.includes("cookie"));
  const exhaustedSeeds = (allSeeds ?? []).filter((s) => (s.exhausted_providers as string[])?.includes("cookie"));
  const existingUsernames = (allSeeds ?? []).map((s) => s.username);

  // Suggested seeds: qualified leads not already seeds, diversified by niche.
  // Fetch a broad pool, then pick the top 2 by followers per niche so no single
  // niche (e.g. fitness coaching) dominates the suggestions.
  let candidateQuery = sb
    .from("leads")
    .select("username, profile_url, followers, following, overall_score, niche")
    .eq("status", "qualified")
    .not("followers", "is", null)
    .not("niche", "is", null)
    .order("following", { ascending: false })
    .limit(200);
  if (existingUsernames.length > 0) {
    candidateQuery = candidateQuery.not("username", "in", `(${existingUsernames.join(",")})`);
  }
  const { data: candidatePool } = await candidateQuery;

  // Pick top 2 per niche, up to 15 total
  const byNiche: Record<string, typeof candidatePool> = {};
  for (const c of candidatePool ?? []) {
    const niche = (c.niche as string) || "other";
    if (!byNiche[niche]) byNiche[niche] = [];
    if (byNiche[niche]!.length < 2) byNiche[niche]!.push(c);
  }
  // Interleave niches so the list doesn't block by niche
  const suggestedCandidates: typeof candidatePool = [];
  const nicheQueues = Object.values(byNiche);
  let i = 0;
  while (suggestedCandidates.length < 15 && nicheQueues.some((q) => q && q.length > 0)) {
    const queue = nicheQueues[i % nicheQueues.length];
    if (queue && queue.length > 0) suggestedCandidates.push(queue.shift()!);
    i++;
  }

  const cookieSet = !!(settings.instagram_session_cookie?.trim() || process.env.INSTAGRAM_SESSION_COOKIE?.trim());
  const serperConfigured = !!(settings.serper_api_key?.trim() || process.env.SERPER_API_KEY?.trim());

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Source Accounts</h1>
        <p className="text-sm text-muted-foreground">
          These are the Instagram accounts we start from. Each one kicks off a search through the people
          they follow — and, for the best matches, the people <em>those</em> people follow.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Your source accounts</CardTitle>
            <Link href="/seeds/history" className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-4">
              View all accounts ever used →
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <SeedManager
            seeds={seeds ?? []}
            exhaustedSeeds={exhaustedSeeds}
            jobs={jobs ?? []}
            defaultLimit={settings.max_profiles_per_account}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Suggested seed accounts</CardTitle>
          <CardDescription>
            Your highest-follower qualified leads — already ICP-vetted, so their following lists are likely full of peers.
            This is the main growth loop: good leads become seeds that surface more good leads.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SuggestedSeeds candidates={suggestedCandidates ?? []} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Discover from Google</CardTitle>
          <CardDescription>
            Use this for cold start (no leads yet) or to branch into a new niche.
            Searches Google for Instagram accounts mentioning your keywords — results are unvetted,
            so check each one before adding. Once you have qualified leads above, prefer those instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SeedDiscovery
            existingSeedUsernames={existingUsernames}
            serperConfigured={serperConfigured}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bio coverage</CardTitle>
          <CardDescription>
            Every lead&rsquo;s bio is pulled with your Instagram burner account right after it&rsquo;s found.
            If any are missing — e.g. leads found before your cookie was set up — top them up here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <BioCoverageCard initial={coverage} />
          {!cookieSet && (
            <p className="text-xs text-amber-600">
              No Instagram session cookie is set, so bios fall back to paid Apify lookups (or fail). Add one in{" "}
              <Link href="/settings" className="underline">Settings</Link> to fetch bios free with your burner account.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent searches</CardTitle></CardHeader>
        <CardContent>
          <CrawlJobsList jobs={jobs ?? []} />
        </CardContent>
      </Card>
    </div>
  );
}
