-- Base pitch / rendered outreach videos can be well over the project's
-- default ~50MB storage upload limit (a single pitch recording was 129MB).
-- Raise the per-bucket limit for the video-carrying buckets only.
update storage.buckets
set file_size_limit = 524288000 -- 500MB
where id in ('video-assets', 'rendered-videos', 'screen-recordings');
