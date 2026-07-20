-- Drop the dead min_posts_last_30_days setting.
--
-- No gate has read it since the posts-recency check was replaced by the reels
-- signal (min_reels_last_30_days). It stayed editable in app_settings while
-- affecting nothing, and stale `posts_30d_below_min` rejection reasons from the
-- removed gate were mistaken for it still firing.
--
-- The metric column leads.posts_last_30_days is unrelated and stays — it is
-- computed by computeMetrics() and shown on the leads table.
alter table public.app_settings
  drop column if exists min_posts_last_30_days;
