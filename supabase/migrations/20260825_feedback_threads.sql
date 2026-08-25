-- Feedback follow-up threads
-- Allows admins to send follow-up messages on a feedback report via Telegram,
-- and captures user replies (via Telegram native Reply gesture).

CREATE TABLE IF NOT EXISTS public.feedback_threads (
    id                  BIGSERIAL PRIMARY KEY,
    report_id           BIGINT NOT NULL REFERENCES public.feedback_reports(id) ON DELETE CASCADE,
    sender              TEXT NOT NULL CHECK (sender IN ('admin', 'user')),
    message             TEXT NOT NULL,
    telegram_message_id BIGINT,   -- ID of the bot message sent to user; used to match replies
    admin_email         TEXT,     -- which admin sent it (NULL for user messages)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_threads_report_id
    ON public.feedback_threads (report_id);

CREATE INDEX IF NOT EXISTS idx_feedback_threads_tg_msg_id
    ON public.feedback_threads (telegram_message_id)
    WHERE telegram_message_id IS NOT NULL;
