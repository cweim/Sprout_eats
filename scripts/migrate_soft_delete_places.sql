-- Migration: Add soft delete to places table
-- Run this in Supabase Dashboard > SQL Editor
-- Safe to run multiple times (all statements are idempotent).

-- Step 1: Pre-flight — check for any unexpected deleted_at values (should return nothing)
-- SELECT id, deleted_at FROM places WHERE deleted_at IS NOT NULL LIMIT 10;

-- Step 2: Add the column (NULL = active, timestamp = soft-deleted)
ALTER TABLE places
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Step 3: Partial index — only covers active (non-deleted) rows, kept small
CREATE INDEX IF NOT EXISTS idx_places_not_deleted
    ON places(user_id, deleted_at)
    WHERE deleted_at IS NULL;
