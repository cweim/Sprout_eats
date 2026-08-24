-- Social query indexes — follow-up to 20260824_performance_indexes.sql.
-- Covers user_friendships (get_friend_ids, are_friends) and activity_comments (get_friend_feed).

-- Index for get_friend_ids(): filters by requester_id + status = 'accepted'.
CREATE INDEX IF NOT EXISTS idx_user_friendships_requester_status
    ON public.user_friendships (requester_id, status);

-- Index for get_friend_ids(): filters by addressee_id + status = 'accepted'.
CREATE INDEX IF NOT EXISTS idx_user_friendships_addressee_status
    ON public.user_friendships (addressee_id, status);

-- Index for activity_comments batch fetch in get_friend_feed().
-- Queried with .in_("activity_id", activity_ids).
CREATE INDEX IF NOT EXISTS idx_activity_comments_activity_id
    ON public.activity_comments (activity_id);
