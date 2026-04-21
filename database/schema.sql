-- Supabase PostgreSQL Schema for Discovery Bot
-- Run this in Supabase SQL Editor

-- =============================================================================
-- Users Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,  -- Telegram user_id
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    language_code TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Places Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS places (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    address TEXT,
    latitude FLOAT NOT NULL,
    longitude FLOAT NOT NULL,
    google_place_id TEXT,
    source_url TEXT,
    source_platform TEXT,  -- 'instagram', 'tiktok', 'manual'
    source_title TEXT,
    source_uploader TEXT,
    source_duration INT,
    source_hashtags TEXT,
    source_language TEXT,
    source_transcript TEXT,
    source_transcript_en TEXT,
    place_types TEXT,
    place_rating FLOAT,
    place_rating_count INT,
    place_price_level TEXT,
    place_opening_hours TEXT,
    is_visited BOOLEAN DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_places_user_id ON places(user_id);
CREATE INDEX IF NOT EXISTS idx_places_google_place_id ON places(google_place_id);

-- =============================================================================
-- Reviews Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS reviews (
    id SERIAL PRIMARY KEY,
    place_id INT REFERENCES places(id) ON DELETE CASCADE NOT NULL UNIQUE,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    overall_rating INT NOT NULL CHECK (overall_rating >= 1 AND overall_rating <= 5),
    price_rating INT NOT NULL CHECK (price_rating >= 1 AND price_rating <= 5),
    overall_remarks TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_place_id ON reviews(place_id);

-- =============================================================================
-- Review Dishes Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS review_dishes (
    id SERIAL PRIMARY KEY,
    review_id INT REFERENCES reviews(id) ON DELETE CASCADE NOT NULL,
    dish_name TEXT NOT NULL,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    remarks TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_dishes_review_id ON review_dishes(review_id);

-- =============================================================================
-- Review Photos Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS review_photos (
    id SERIAL PRIMARY KEY,
    review_id INT REFERENCES reviews(id) ON DELETE CASCADE NOT NULL,
    dish_id INT REFERENCES review_dishes(id) ON DELETE CASCADE,  -- NULL = overall photo
    file_url TEXT NOT NULL,  -- Supabase Storage URL
    storage_path TEXT,  -- Path in Supabase Storage bucket
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_photos_review_id ON review_photos(review_id);
CREATE INDEX IF NOT EXISTS idx_review_photos_dish_id ON review_photos(dish_id);

-- =============================================================================
-- Review Reminders Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS review_reminders (
    id SERIAL PRIMARY KEY,
    place_id INT REFERENCES places(id) ON DELETE CASCADE NOT NULL,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    visited_at TIMESTAMPTZ NOT NULL,
    reminder_sent BOOLEAN DEFAULT FALSE,
    dont_ask_again BOOLEAN DEFAULT FALSE,
    UNIQUE(place_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_review_reminders_user_id ON review_reminders(user_id);

-- =============================================================================
-- Feedback Reports Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS feedback_reports (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('bug', 'feature_request', 'places_not_found', 'general_feedback')),
    source TEXT NOT NULL CHECK (source IN ('telegram_bot', 'mini_app')),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'in_progress', 'resolved', 'wont_fix')),
    severity TEXT CHECK (severity IN ('low', 'medium', 'high')),
    title TEXT,
    body TEXT,
    source_link TEXT,
    admin_notes TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_reports_user_id ON feedback_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_category ON feedback_reports(category);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_status ON feedback_reports(status);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_created_at ON feedback_reports(created_at DESC);

-- =============================================================================
-- Feedback Attachments Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS feedback_attachments (
    id SERIAL PRIMARY KEY,
    report_id INT REFERENCES feedback_reports(id) ON DELETE CASCADE NOT NULL,
    attachment_type TEXT NOT NULL CHECK (attachment_type IN ('image', 'link', 'text_note')),
    file_url TEXT,
    storage_path TEXT,
    text_content TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_attachments_report_id ON feedback_attachments(report_id);
CREATE INDEX IF NOT EXISTS idx_feedback_attachments_type ON feedback_attachments(attachment_type);

-- =============================================================================
-- Admins Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS admins (
    id UUID PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- App Events Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS app_events (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    event_name TEXT NOT NULL,
    event_source TEXT NOT NULL CHECK (event_source IN ('telegram_bot', 'mini_app', 'admin')),
    entity_type TEXT,
    entity_id TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_events_name ON app_events(event_name);
CREATE INDEX IF NOT EXISTS idx_app_events_source ON app_events(event_source);
CREATE INDEX IF NOT EXISTS idx_app_events_created_at ON app_events(created_at DESC);

-- =============================================================================
-- Row Level Security (RLS)
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE places ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_dishes ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_events ENABLE ROW LEVEL SECURITY;

-- Users: users can only see their own record
CREATE POLICY "Users see own record" ON users
    FOR ALL USING (id = current_setting('app.current_user_id', true)::bigint);

-- Places: users can only access their own places
CREATE POLICY "Users access own places" ON places
    FOR ALL USING (user_id = current_setting('app.current_user_id', true)::bigint);

-- Reviews: users can only access their own reviews
CREATE POLICY "Users access own reviews" ON reviews
    FOR ALL USING (user_id = current_setting('app.current_user_id', true)::bigint);

-- Review dishes: via review's user_id
CREATE POLICY "Users access own review dishes" ON review_dishes
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM reviews r
            WHERE r.id = review_dishes.review_id
            AND r.user_id = current_setting('app.current_user_id', true)::bigint
        )
    );

-- Review photos: via review's user_id
CREATE POLICY "Users access own review photos" ON review_photos
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM reviews r
            WHERE r.id = review_photos.review_id
            AND r.user_id = current_setting('app.current_user_id', true)::bigint
        )
    );

-- Review reminders: users can only access their own reminders
CREATE POLICY "Users access own reminders" ON review_reminders
    FOR ALL USING (user_id = current_setting('app.current_user_id', true)::bigint);

-- Feedback reports: users can only access their own reports
CREATE POLICY "Users access own feedback reports" ON feedback_reports
    FOR ALL USING (user_id = current_setting('app.current_user_id', true)::bigint);

-- Feedback attachments: via report's user_id
CREATE POLICY "Users access own feedback attachments" ON feedback_attachments
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM feedback_reports fr
            WHERE fr.id = feedback_attachments.report_id
            AND fr.user_id = current_setting('app.current_user_id', true)::bigint
        )
    );

-- Admins and app_events are internal-only.
-- No end-user RLS policies are created for these tables.

-- =============================================================================
-- Service Role Bypass
-- Service role key bypasses RLS by default in Supabase
-- =============================================================================

-- =============================================================================
-- Storage Bucket (run in Supabase Dashboard > Storage)
-- =============================================================================
-- 1. Create bucket "review-photos" (public)
-- 2. Set file size limit to 10MB
-- 3. Allowed MIME types: image/jpeg, image/png, image/webp
--
-- 1. Create bucket "feedback-attachments" (public)
-- 2. Set file size limit to 10MB
-- 3. Allowed MIME types: image/jpeg, image/png, image/webp

-- Storage RLS policies (create in Dashboard > Storage > Policies):
-- INSERT: authenticated users can upload to their own folder
-- SELECT: public access (photos are public URLs)
-- DELETE: users can delete their own photos
--
-- For "feedback-attachments":
-- INSERT: internal/admin or authenticated upload flow via backend
-- SELECT: public or signed access depending on future privacy choice
-- DELETE: backend/admin only
