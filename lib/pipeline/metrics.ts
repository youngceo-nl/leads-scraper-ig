import type { ActivityStatus, RecentPost, ScrapedProfile } from "@/lib/types";

export type ComputedMetrics = {
  avg_likes: number | null;
  avg_comments: number | null;
  avg_views: number | null;
  engagement_rate: number | null;
  posts_last_30_days: number;
  activity_status: ActivityStatus;
};

export function computeMetrics(profile: ScrapedProfile): ComputedMetrics {
  const posts = profile.recent_posts ?? [];

  // Prefer unpinned reels for engagement rate — more representative of organic reach.
  // Fall back to all posts if no reel data is available.
  const unpinnedReels = posts.filter((p) => p.is_reel && !p.is_pinned);
  const metricsSource = unpinnedReels.length >= 3 ? unpinnedReels.slice(0, 3) : posts;

  const likesArr = metricsSource.map((p) => p.likes).filter((n): n is number => typeof n === "number");
  const commentsArr = posts.map((p) => p.comments).filter((n): n is number => typeof n === "number");
  const viewsArr = posts.map((p) => p.views).filter((n): n is number => typeof n === "number");

  const avg_likes    = avg(likesArr);
  const avg_comments = avg(commentsArr);
  const avg_views    = avg(viewsArr);

  const engagement_rate =
    avg_likes != null && profile.followers > 0 ? avg_likes / profile.followers : null;

  const posts_last_30_days = countWithin(posts, 30);
  const activity_status = activityFrom(posts_last_30_days);

  return { avg_likes, avg_comments, avg_views, engagement_rate, posts_last_30_days, activity_status };
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function countWithin(posts: RecentPost[], days: number): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return posts.reduce((acc, p) => {
    if (!p.taken_at) return acc;
    const t = Date.parse(p.taken_at);
    return Number.isNaN(t) ? acc : t >= cutoff ? acc + 1 : acc;
  }, 0);
}

function activityFrom(postsIn30: number): ActivityStatus {
  if (postsIn30 >= 15) return "very_active";
  if (postsIn30 >= 8)  return "active";
  if (postsIn30 >= 3)  return "semi_active";
  return "inactive";
}
