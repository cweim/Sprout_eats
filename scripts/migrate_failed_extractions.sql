-- Migration: Add failed_extractions table
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS failed_extractions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    platform    TEXT,
    caption_preview TEXT,
    reason      TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_extractions_user_id ON failed_extractions(user_id);
CREATE INDEX IF NOT EXISTS idx_failed_extractions_platform ON failed_extractions(platform);
CREATE INDEX IF NOT EXISTS idx_failed_extractions_created_at ON failed_extractions(created_at DESC);

ALTER TABLE failed_extractions ENABLE ROW LEVEL SECURITY;
