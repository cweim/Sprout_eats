# Deployment TODO Plan

This document tracks the work needed before Discovery Bot is safe to deploy for multiple Telegram users.

## 1. Add Multi-User Data Ownership ✅ DONE

- [x] Add a `users` table.
- [x] Add `telegram_user_id` as a unique field on `users`.
- [x] Add `user_id` foreign key to `places`.
- [x] Change duplicate logic from global `google_place_id` to `(user_id, google_place_id)`.
- [x] Update all repository methods to require `user_id`.

## 2. Add Telegram User Scoping In The Bot ✅ DONE

- [x] In every bot handler, read `update.effective_user.id`.
- [x] Create or fetch the user record before saving places.
- [x] Scope `/places`, `/map`, `/delete`, `/clear`, and `/nearby` to that user only.
- [x] Ensure one user cannot delete or update another user's place.

## 3. Secure The Mini App API ✅ DONE

- [x] Send `window.Telegram.WebApp.initData` with every API request.
- [x] Add a FastAPI middleware or dependency to verify Telegram `initData` using `TELEGRAM_BOT_TOKEN`.
- [x] Extract the verified Telegram user ID server-side.
- [x] Scope all API routes by that user ID.
- [x] Reject requests with missing or invalid Telegram init data.

## 4. Move From SQLite To Supabase Postgres ✅ DONE

- [x] Create a Supabase project.
- [x] Add Supabase config (URL, anon key, service key).
- [x] Create schema with `database/schema.sql`.
- [x] Create `supabase_repository.py` with all CRUD operations.
- [x] Run schema in Supabase SQL Editor.
- [x] Migration script: `scripts/migrate_to_supabase.py`.

## 5. Add Database Security ✅ DONE

- [x] Keep Supabase service-role key backend-only.
- [x] Do not expose database credentials in the Mini App.
- [x] Add application-level user filtering.
- [x] Add Postgres Row Level Security policies.

## 6. Split Deployment Processes ⚠️ MANUAL

- [ ] Deploy FastAPI separately from the Telegram bot worker.
- [ ] API process: `uvicorn api.main:app`.
- [ ] Bot process: `python run.py`.
- [ ] Ensure only one bot polling worker runs.

See: `.planning/MANUAL_DEPLOYMENT_GUIDE.md`

## 7. Productionize Media Processing ✅ DONE

- [x] Enforce max video duration (`MAX_VIDEO_DURATION=300`).
- [x] Enforce max download size (`MAX_DOWNLOAD_SIZE_MB=100`).
- [x] Enforce max number of carousel images OCR'd (`MAX_OCR_IMAGES=10`).
- [x] Clean up temp video/audio/image files reliably.
- [x] Add timeouts around download (`DOWNLOAD_TIMEOUT=120`).
- [ ] Consider moving long-running processing to a background queue (future).

## 8. Add Deployment Environment Config ✅ DONE

All documented in `.env.example`:
- [x] `TELEGRAM_BOT_TOKEN`
- [x] `GOOGLE_API_KEY`
- [x] `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`
- [x] `WEBAPP_URL`
- [x] `WHISPER_MODEL`
- [x] `LOCAL_DEV_AUTH` (false in production)
- [x] `MAX_VIDEO_DURATION`, `MAX_DOWNLOAD_SIZE_MB`, `MAX_OCR_IMAGES`, `DOWNLOAD_TIMEOUT`

## 9. Lock Down API And CORS ✅ PARTIALLY DONE

- [x] Replace `allow_origins=["*"]` with `WEBAPP_URL`.
- [ ] Add request size limits if the host supports it.
- [ ] Add rate limiting for `/api/search`, `/api/places`, and media processing (future).

## 10. Protect External API Usage ⚠️ MANUAL

- [ ] Restrict the Google API key to the required APIs.
- [ ] Monitor Google Places API spend.
- [ ] Add per-user daily search and link-processing limits (future).

See: `.planning/MANUAL_DEPLOYMENT_GUIDE.md`

## 11. Add Observability ✅ PARTIALLY DONE

- [x] Add structured logs for bot and API.
- [x] Log processing stages.
- [x] Add a health check endpoint (`GET /api/health`).
- [ ] Add error reporting if deploying publicly (future).
- [ ] Add uptime monitoring (future).

## 12. Add Backup And Data Retention ⚠️ MANUAL

- [ ] Enable Supabase backups.
- [ ] Decide retention policy for transcripts and source URLs.
- [ ] Add delete-account or clear-data flow (future).

See: `.planning/MANUAL_DEPLOYMENT_GUIDE.md`

## 13. Update Mini App For Production Auth ✅ DONE

- [x] Add a helper for authenticated fetch with Telegram init data (`getAuthHeaders()`).
- [x] Ensure all API calls use that helper.
- [x] Handle `401 Unauthorized` gracefully.
- [ ] Test the Mini App inside Telegram, not just in the browser.

## 14. Final Pre-Launch Testing ⚠️ MANUAL

- [ ] Test with two Telegram users and verify data separation.
- [ ] Test Instagram Reel link.
- [ ] Test TikTok link.
- [ ] Test Instagram photo/carousel link with OCR.
- [ ] Test manual Discover Places.
- [ ] Test delete/update/visited/notes from the Mini App.
- [ ] Test `/clear` only clears the current user's places.
- [ ] Test `/nearby` only shows the current user's places.
- [ ] Test bot restart and ensure there is no duplicate polling conflict.

---

## Summary

| Category | Status |
|----------|--------|
| Multi-user schema | ✅ Done |
| Bot user scoping | ✅ Done |
| Mini App auth | ✅ Done |
| Supabase migration | ✅ Done |
| Database security | ✅ Done |
| Media limits | ✅ Done |
| CORS lockdown | ✅ Done |
| Health check | ✅ Done |
| Deployment split | ⚠️ Manual |
| Google API restrict | ⚠️ Manual |
| Supabase backups | ⚠️ Manual |
| Multi-user testing | ⚠️ Manual |
