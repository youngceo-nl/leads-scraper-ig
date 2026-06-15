// Shared TypeScript types — kept thin and aligned with the SQL schema.

export type LeadStatus = "qualified" | "review" | "rejected" | "pending";
export type ActivityStatus = "very_active" | "active" | "semi_active" | "inactive";
export type CrawlJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type RecentPost = {
  caption: string | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  taken_at: string | null;
  is_reel?: boolean;
  is_pinned?: boolean;
};

export type AppSettings = {
  id: 1;
  apify_api_key: string | null;
  claude_api_key: string | null;
  claude_model: string;
  scrapingbee_api_key: string | null;
  serper_api_key: string | null;
  default_seeds: string[];
  max_crawl_depth: number;
  max_profiles_per_account: number;
  crawl_score_threshold: number;
  min_followers: number;
  max_followers: number;
  min_engagement_rate: number;
  min_posts_last_30_days: number;
  include_keywords: string[];
  exclude_keywords: string[];
  following_scraper_provider: "apify" | "scrapingbee" | "cookie" | "auto";
  instagram_session_cookie: string | null;
  instagram_session_cookies: string[];
  scoring_provider: "openai" | "claude";
  openai_api_key: string | null;
  openai_model: string;
  airscale_api_key: string | null;
  enrich_funnels_auto: boolean;
  enrich_emails_auto: boolean;
  outreach_subject_template: string;
  outreach_body_template: string;
  outreach_reply_to: string | null;
  updated_at: string;
};

export type Seed = {
  id: string;
  username: string;
  profile_url: string;
  notes: string | null;
  max_profiles_to_scrape: number | null;
  exhausted_providers: string[];
  created_at: string;
};

export type Lead = {
  id: string;
  username: string;
  full_name: string | null;
  profile_url: string;
  bio: string | null;
  external_link: string | null;
  is_private: boolean;
  is_verified: boolean;
  followers: number | null;
  following: number | null;
  posts: number | null;
  avg_likes: number | null;
  avg_comments: number | null;
  avg_views: number | null;
  engagement_rate: number | null;
  posts_last_30_days: number | null;
  activity_status: ActivityStatus | null;
  recent_posts: RecentPost[];
  niche: string | null;
  business_model: string | null;
  offer_type: string | null;
  audience_type: string | null;
  icp_fit_score: number | null;
  traction_score: number | null;
  monetization_score: number | null;
  activity_score: number | null;
  overall_score: number | null;
  reason_for_score: string | null;
  recommended_action: string | null;
  status: LeadStatus;
  rejection_reason: string | null;
  crawl_depth: number;
  source_seed_id: string | null;
  parent_username: string | null;
  email: string | null;
  email_status: string | null;
  email_provider: string | null;
  email_verifier: string | null;
  enriched_at: string | null;
  enrichment_error: string | null;
  funnel_url: string | null;
  funnel_platform: string | null;
  funnel_program_name: string | null;
  funnel_offer_summary: string | null;
  funnel_price: string | null;
  funnel_extracted_at: string | null;
  funnel_extraction_error: string | null;
  linkedin_url: string | null;
  linkedin_lookup_error: string | null;
  youtube_url: string | null;
  youtube_lookup_error: string | null;
  outreach_count: number;
  last_outreach_at: string | null;
  last_outreach_error: string | null;
  created_at: string;
  updated_at: string;
};

export type OutreachMessage = {
  id: string;
  lead_id: string;
  to_email: string;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  status: "sent" | "failed";
  message_id: string | null;
  error: string | null;
  sent_by: string | null;
  sent_at: string;
};

export type FunnelPlatform =
  | "linktree"
  | "stan"
  | "beacons"
  | "clickfunnels"
  | "kajabi"
  | "systeme"
  | "gohighlevel"
  | "shopify"
  | "wordpress"
  | "wix"
  | "squarespace"
  | "thrivecart"
  | "podia"
  | "teachable"
  | "thinkific"
  | "custom"
  | "unknown";

// Raw scraped profile shape (post-normalization, pre-scoring)
export type ScrapedProfile = {
  username: string;
  full_name: string | null;
  profile_url: string;
  bio: string | null;
  external_link: string | null;
  followers: number;
  following: number;
  posts: number;
  is_private: boolean;
  is_verified: boolean;
  recent_posts: RecentPost[];
};

// Claude scoring output — strict JSON contract
export type ClaudeScore = {
  icp_fit_score: number;
  traction_score: number;
  monetization_score: number;
  activity_score: number;
  overall_score: number;
  niche: string;
  business_model: string;
  offer_type: string;
  audience_type: string;
  reason_for_score: string;
  recommended_action: "qualified" | "review" | "reject";
};

export type CrawlJob = {
  id: string;
  seed_id: string;
  status: CrawlJobStatus;
  max_depth: number;
  current_depth: number;
  profiles_scraped: number;
  qualified_count: number;
  rejected_count: number;
  expected_profiles: number | null;
  inngest_run_id: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};
