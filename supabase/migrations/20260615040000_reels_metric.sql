-- Reels in the last 30 days become the primary engagement / activity metric.
-- Total posts are kept for reference; this adds a reels-specific count alongside.
alter table leads add column if not exists reels_last_30_days int;

-- Optional hard-filter floor for reels in the last 30 days (0 = off / no rejection).
-- Kept separate from min_posts_last_30_days so existing setups don't suddenly
-- reject leads whose reels we couldn't fetch.
alter table app_settings add column if not exists min_reels_last_30_days int not null default 0;
