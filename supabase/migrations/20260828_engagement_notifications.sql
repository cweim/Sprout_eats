-- Per-post like/comment notification cooldown
-- Tracks when the last Telegram notification was sent for a specific
-- activity's likes or comments, to avoid notification spam.
CREATE TABLE IF NOT EXISTS activity_engagement_notifications (
    activity_id         TEXT        NOT NULL,
    notification_type   TEXT        NOT NULL,  -- 'like' | 'comment'
    last_notified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (activity_id, notification_type)
);
