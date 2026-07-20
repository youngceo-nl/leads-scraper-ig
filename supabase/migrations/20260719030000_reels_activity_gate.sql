-- Activate the reels activity gate.
--
-- metricsGate() has always been able to reject on min_reels_last_30_days, but
-- the threshold sat at 0 so it never fired, and the Apify path never populated
-- is_reel so reels_last_30_days was always 0 anyway. With is_reel now mapped
-- from the profile actor's latestPosts, reels become the activity signal —
-- alongside engagement_rate, which was already enforced.
--
-- 1 = "posted at least one reel in the last 30 days". Accounts we could not
-- sample properly are still never rejected on this: filter.ts requires at
-- least MIN_REEL_SAMPLE_FOR_RECENCY (3) scraped reels before the check applies,
-- so a thin scrape defers to scoring rather than hard-rejecting.
alter table public.app_settings
  alter column min_reels_last_30_days set default 1;

update public.app_settings
   set min_reels_last_30_days = 1
 where id = 1 and min_reels_last_30_days = 0;
