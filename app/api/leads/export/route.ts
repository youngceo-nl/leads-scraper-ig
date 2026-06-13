import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildKeywordOr } from "@/lib/leads/keyword-filter";

const COLS = [
  "username","full_name","profile_url","bio","external_link",
  "followers","following","posts",
  "avg_likes","avg_comments","avg_views","engagement_rate",
  "posts_last_30_days","activity_status",
  "niche","business_model","offer_type","audience_type",
  "icp_fit_score","traction_score","monetization_score","activity_score","overall_score",
  "reason_for_score","recommended_action",
  "status","crawl_depth","parent_username",
  "email","email_status","email_provider","enriched_at",
  "linkedin_url","youtube_url",
  "funnel_url","funnel_platform","funnel_program_name","funnel_offer_summary","funnel_price","funnel_extracted_at",
  "created_at",
] as const;

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: Request) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const sp = Object.fromEntries(url.searchParams);
  const admin = createAdminClient();

  let q = admin.from("leads").select(COLS.join(","));
  const keywordOr = buildKeywordOr(sp.q);
  if (keywordOr) q = q.or(keywordOr);
  if (sp.status && sp.status !== "all") q = q.eq("status", sp.status);
  if (sp.niche) q = q.ilike("niche", `%${sp.niche}%`);
  if (sp.business_model) q = q.eq("business_model", sp.business_model);
  if (sp.min_followers) q = q.gte("followers", Number(sp.min_followers));
  if (sp.max_followers) q = q.lte("followers", Number(sp.max_followers));
  if (sp.min_engagement) q = q.gte("engagement_rate", Number(sp.min_engagement) / 100);
  if (sp.min_posts_30d) q = q.gte("posts_last_30_days", Number(sp.min_posts_30d));
  if (sp.min_score) q = q.gte("overall_score", Number(sp.min_score));
  if (sp.funnel_platform) q = q.eq("funnel_platform", sp.funnel_platform);
  if (sp.has_funnel === "yes") q = q.not("funnel_program_name", "is", null);
  if (sp.has_funnel === "no") q = q.is("funnel_program_name", null);
  if (sp.has_email === "yes") q = q.not("email", "is", null);
  if (sp.has_email === "no") q = q.is("email", null);
  if (sp.has_linkedin === "yes") q = q.not("linkedin_url", "is", null);
  if (sp.has_linkedin === "no") q = q.is("linkedin_url", null);
  if (sp.has_youtube === "yes") q = q.not("youtube_url", "is", null);
  if (sp.has_youtube === "no") q = q.is("youtube_url", null);
  q = q.order("overall_score", { ascending: false, nullsFirst: false }).limit(10000);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const header = COLS.join(",");
  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).map((row) =>
    COLS.map((c) => csvEscape(row[c])).join(","),
  );
  const csv = [header, ...rows].join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
