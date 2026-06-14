"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { updateSettings } from "@/lib/config/settings";
import type { AppSettings } from "@/lib/types";

async function requireUser() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");
}

const num = (v: FormDataEntryValue | null, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const csv = (v: FormDataEntryValue | null): string[] =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export async function saveSettings(prev: AppSettings, formData: FormData) {
  await requireUser();
  const patch: Partial<AppSettings> = {
    apify_api_key: String(formData.get("apify_api_key") ?? "") || null,
    claude_api_key: String(formData.get("claude_api_key") ?? "") || null,
    claude_model: String(formData.get("claude_model") ?? prev.claude_model),
    scrapingbee_api_key: String(formData.get("scrapingbee_api_key") ?? "") || null,
    serper_api_key: String(formData.get("serper_api_key") ?? "") || null,
    max_crawl_depth: num(formData.get("max_crawl_depth"), prev.max_crawl_depth),
    max_profiles_per_account: num(formData.get("max_profiles_per_account"), prev.max_profiles_per_account),
    crawl_score_threshold: num(formData.get("crawl_score_threshold"), prev.crawl_score_threshold),
    min_followers: num(formData.get("min_followers"), prev.min_followers),
    max_followers: num(formData.get("max_followers"), prev.max_followers),
    min_engagement_rate: num(formData.get("min_engagement_rate"), prev.min_engagement_rate),
    min_posts_last_30_days: num(formData.get("min_posts_last_30_days"), prev.min_posts_last_30_days),
    include_keywords: csv(formData.get("include_keywords")),
    exclude_keywords: csv(formData.get("exclude_keywords")),
    following_scraper_provider: (() => {
      const v = String(formData.get("following_scraper_provider") ?? "auto");
      return (["apify", "scrapingbee", "cookie", "auto"] as const).includes(v as never) ? (v as "apify" | "scrapingbee" | "cookie" | "auto") : "auto";
    })(),
    instagram_session_cookie: String(formData.get("instagram_session_cookie") ?? "") || null,
    scoring_provider: (() => {
      const v = String(formData.get("scoring_provider") ?? "openai");
      return v === "claude" ? "claude" : "openai";
    })(),
    openai_api_key: String(formData.get("openai_api_key") ?? "") || null,
    openai_model: String(formData.get("openai_model") ?? prev.openai_model),
    airscale_api_key: String(formData.get("airscale_api_key") ?? "") || null,
    enrich_funnels_auto: formData.get("enrich_funnels_auto") === "on",
    enrich_emails_auto: formData.get("enrich_emails_auto") === "on",
    outreach_subject_template: String(formData.get("outreach_subject_template") ?? prev.outreach_subject_template),
    outreach_body_template: String(formData.get("outreach_body_template") ?? prev.outreach_body_template),
    outreach_reply_to: String(formData.get("outreach_reply_to") ?? "") || null,
  };
  await updateSettings(patch);
  revalidatePath("/settings");
  return { ok: true };
}
