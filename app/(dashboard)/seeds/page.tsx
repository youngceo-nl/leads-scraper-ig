import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SeedManager } from "@/components/seeds/seed-manager";
import { CrawlJobsList } from "@/components/seeds/crawl-jobs-list";
import { BioCoverageCard } from "@/components/seeds/bio-coverage";
import { RecommendedSeeds } from "@/components/seeds/recommended-seeds";
import { BadSeedsTable } from "@/components/seeds/bad-seeds-table";
import { getSettings } from "@/lib/config/settings";
import { getBioCoverage } from "@/app/actions/backfill-bios";
import { getScrapedSeedIds } from "@/lib/seeds/scraped";
import { getRecommendedSeeds } from "@/lib/seeds/recommend";

export const dynamic = "force-dynamic";

export default async function SeedsPage() {
  const sb = createAdminClient();
  const [{ data: allSeeds }, { data: jobs }, settings, coverage, scrapedSeedIds, recommended, { data: rejectedSeeds }] = await Promise.all([
    sb.from("seeds").select("*").order("created_at", { ascending: false }),
    sb.from("crawl_jobs").select("*, seeds(username)").order("created_at", { ascending: false }).limit(15),
    getSettings(),
    getBioCoverage(),
    getScrapedSeedIds(),
    getRecommendedSeeds(5),
    sb.from("rejected_seeds").select("username, reason, created_at").order("created_at", { ascending: false }),
  ]);

  const seeds = (allSeeds ?? []).filter((s) => !(s.exhausted_providers as string[])?.includes("cookie"));
  const exhaustedSeeds = (allSeeds ?? []).filter((s) => (s.exhausted_providers as string[])?.includes("cookie"));

  const cookieSet = !!(settings.instagram_session_cookie?.trim() || process.env.INSTAGRAM_SESSION_COOKIE?.trim());

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Source Accounts</h1>
        <p className="text-sm text-muted-foreground">
          These are the Instagram accounts we start from. Each one kicks off a search through the people
          they follow — and, for the best matches, the people <em>those</em> people follow.
        </p>
      </div>

      <RecommendedSeeds candidates={recommended} />

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
            scrapedSeedIds={[...scrapedSeedIds]}
            systemStatus={{
              igStatus: (() => {
                const igConfigured = (settings.instagram_accounts ?? []).length > 0 || (settings.instagram_session_cookies ?? []).length > 0 || !!settings.instagram_session_cookie;
                return !igConfigured ? "missing" as const
                  : settings.ig_cookie_status === "dead" ? "dead" as const
                  : settings.ig_cookie_status === "live" ? "ok" as const
                  : "unknown" as const;
              })(),
            }}
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

      <BadSeedsTable rows={rejectedSeeds ?? []} />
    </div>
  );
}
