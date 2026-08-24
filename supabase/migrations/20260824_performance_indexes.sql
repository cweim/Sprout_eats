-- Performance indexes for feed and social queries.
-- Addresses missing indexes identified in performance audit (2026-08-24).
-- Note: CONCURRENTLY removed — Supabase SQL editor runs inside a transaction block.
-- These are one-time index builds; brief lock is acceptable at low traffic.

-- Composite index for feed query: filters by user_id IN (...) and orders by created_at DESC.
CREATE INDEX IF NOT EXISTS idx_user_activities_user_created
    ON public.user_activities (user_id, created_at DESC);

-- Index for activity likes lookups by activity_id (TEXT/UUID).
CREATE INDEX IF NOT EXISTS idx_user_activity_likes_activity_id
    ON public.user_activity_likes (activity_id);

-- Index for batch review_dishes fetch in get_friend_reviews_for_place().
CREATE INDEX IF NOT EXISTS idx_review_dishes_review_id
    ON public.review_dishes (review_id);

-- Index for batch review_photos fetch ordered by sort_order.
CREATE INDEX IF NOT EXISTS idx_review_photos_review_sort
    ON public.review_photos (review_id, sort_order);
