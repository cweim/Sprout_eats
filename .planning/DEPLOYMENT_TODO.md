# Deployment TODO Plan

This document tracks the work needed before Discovery Bot is safe to deploy for multiple Telegram users.

## 1. Add Multi-User Data Ownership

- Add a `users` table.
- Add `telegram_user_id` as a unique field on `users`.
- Add `user_id` foreign key to `places`.
- Change duplicate logic from global `google_place_id` to `(user_id, google_place_id)`.
- Update all repository methods to require `user_id`.

## 2. Add Telegram User Scoping In The Bot

- In every bot handler, read `update.effective_user.id`.
- Create or fetch the user record before saving places.
- Scope `/places`, `/map`, `/delete`, `/clear`, and `/nearby` to that user only.
- Ensure one user cannot delete or update another user's place.

## 3. Secure The Mini App API

- Send `window.Telegram.WebApp.initData` with every API request.
- Add a FastAPI middleware or dependency to verify Telegram `initData` using `TELEGRAM_BOT_TOKEN`.
- Extract the verified Telegram user ID server-side.
- Scope all API routes by that user ID.
- Reject requests with missing or invalid Telegram init data.

## 4. Move From SQLite To Supabase Postgres

- Create a Supabase project.
- Add `DATABASE_URL` for Supabase Postgres.
- Replace `DATABASE_PATH` config with full `DATABASE_URL` support.
- Add Alembic migrations.
- Create migration for `users` and updated `places`.
- Run migrations on Supabase.
- Decide whether to migrate existing local data or start fresh.

## 5. Add Database Security

- Keep Supabase service-role key or server connection string backend-only.
- Do not expose database credentials in the Mini App.
- Add application-level user filtering first.
- Optionally add Postgres/Supabase Row Level Security later as defense-in-depth.

## 6. Split Deployment Processes

- Deploy FastAPI separately from the Telegram bot worker.
- API process: `uvicorn api.main:app`.
- Bot process: `python run.py`.
- Ensure only one bot polling worker runs.
- Consider Telegram webhook mode later if the deployment platform supports it cleanly.

## 7. Productionize Media Processing

- Enforce max video duration.
- Enforce max download size.
- Enforce max number of carousel images OCR'd.
- Clean up temp video/audio/image files reliably.
- Add timeouts around download, OCR, Whisper, and Google Places calls.
- Consider moving long-running processing to a background queue.

## 8. Add Deployment Environment Config

- `TELEGRAM_BOT_TOKEN`
- `GOOGLE_API_KEY`
- `DATABASE_URL`
- `WEBAPP_URL`
- `WHISPER_MODEL`
- `ENV=production`
- `TEMP_DIR`
- `ALLOWED_ORIGINS`

## 9. Lock Down API And CORS

- Replace `allow_origins=["*"]` with the deployed Mini App URL.
- Add request size limits if the host supports it.
- Add rate limiting for `/api/search`, `/api/places`, and media processing.

## 10. Protect External API Usage

- Restrict the Google API key to the required APIs.
- Monitor Google Places API spend.
- Add per-user daily search and link-processing limits.
- Add clear errors for quota exhaustion.

## 11. Add Observability

- Add structured logs for bot and API.
- Log processing stages: download, caption search, OCR, transcription, and Places lookup.
- Track failures by type.
- Add error reporting if deploying publicly.
- Add a health check endpoint and uptime monitoring.

## 12. Add Backup And Data Retention

- Enable Supabase backups.
- Decide retention policy for transcripts and source URLs.
- Decide whether OCR/transcript text should be stored long-term.
- Add delete-account or clear-data flow.

## 13. Update Mini App For Production Auth

- Add a helper for authenticated fetch with Telegram init data.
- Ensure all API calls use that helper.
- Handle `401 Unauthorized` with a friendly Telegram-only message.
- Test the Mini App inside Telegram, not just in the browser.

## 14. Final Pre-Launch Testing

- Test with two Telegram users and verify data separation.
- Test Instagram Reel link.
- Test TikTok link.
- Test Instagram photo/carousel link with OCR.
- Test manual Discover Places.
- Test delete/update/visited/notes from the Mini App.
- Test `/clear` only clears the current user's places.
- Test `/nearby` only shows the current user's places.
- Test bot restart and ensure there is no duplicate polling conflict.

## Suggested Build Order

1. Multi-user schema and repository scoping.
2. Telegram Mini App auth verification.
3. Supabase Postgres migration.
4. Production deployment split: API plus bot worker.
5. Rate limits, cleanup, and observability.
6. Final multi-user testing.
