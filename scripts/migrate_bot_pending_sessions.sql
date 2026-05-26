-- Migration: Add bot_pending_sessions table
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS bot_pending_sessions (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_type TEXT NOT NULL,  -- 'place_selection', 'correction', etc.
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, session_type)
);

CREATE INDEX IF NOT EXISTS idx_bot_pending_sessions_expires ON bot_pending_sessions(expires_at);

ALTER TABLE bot_pending_sessions ENABLE ROW LEVEL SECURITY;
