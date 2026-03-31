# Discovery Bot

**One-liner:** Telegram bot that extracts and saves places from Instagram/TikTok travel videos.

## Problem

When browsing social media, you discover interesting places (cafes, restaurants, attractions) in travel videos. By the time you're ready to visit, you've lost track of them. Manually noting down each place is tedious.

## Solution

Send an Instagram or TikTok URL to the bot. It downloads the video, transcribes the audio, searches Google Places for mentioned locations, and saves them to your personal database with location pins.

## Requirements

### Validated

- ✓ Telegram bot interface with command handlers — existing
- ✓ Instagram video download via yt-dlp — existing
- ✓ TikTok video download via yt-dlp — existing
- ✓ Audio extraction from videos — existing
- ✓ Whisper transcription of audio — existing
- ✓ Google Places text search for locations — existing
- ✓ SQLite database for saved places — existing
- ✓ Location pin sending via Telegram — existing
- ✓ Static map image generation — existing
- ✓ Manual place search fallback — existing
- ✓ View all saved places command — existing
- ✓ Clear all places command — existing

### Active

See `.planning/ROADMAP.md` for full phase breakdown (9 phases).

**v1.1 Milestone:**
- [ ] Phase 1: Testing Foundation (pytest)
- [ ] Phase 2: Reliability (retry logic, timeouts)
- [ ] Phase 3: Multi-Place Support (save multiple, delete individual)
- [ ] Phase 4: Enhanced Metadata (hashtags, categories, photos, hours)
- [ ] Phase 5: Language Support (multi-language transcription)
- [ ] Phase 6: Interactive Viewer (Telegram Mini App)
- [ ] Phase 7: Proximity Features (nearby alerts)
- [ ] Phase 8: Performance (Whisper preload)
- [ ] Phase 9: Documentation (README)

### Out of Scope

- Multi-user support — personal use bot only
- YouTube support — focused on short-form video platforms
- Place editing/deletion individually — clear all is sufficient for v1
- Web interface — Telegram-only interaction
- Place sharing between users — single user

## Constraints

**Design:**
- Bot personality: Cute, friendly, encouraging tone in all messages
- Error messages should be helpful, not scary
- Celebrate user actions (place saved, etc.)

**Technical:**
- Python 3.11+ required
- FFmpeg must be installed for audio extraction
- Google API key needed (Places + Maps)
- Telegram Bot token required
- SQLite sufficient for single-user scale

**Operational:**
- Whisper model loads on first use (10-30s cold start)
- Large videos may take time to download/process
- Dependent on external APIs (Google, Telegram)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| SQLite over PostgreSQL | Single-user, no concurrent writes needed | ✓ Simple, works |
| Whisper local vs API | Privacy, no per-request costs | ✓ Works, slow cold start |
| yt-dlp over custom scrapers | Handles platform changes, well-maintained | ✓ Reliable |
| Async architecture | Non-blocking for multiple requests | ✓ Clean design |
| Telegram Mini App for viewer | Interactive maps without Google account linking | Planned |
| Leaflet.js for maps | Free, open source, no API key needed | Planned |
| Cute/friendly bot personality | Better UX, memorable experience | Planned |

## Success Metrics

- Places successfully extracted from URLs
- Transcription accuracy sufficient to find places
- Response time acceptable for user experience

---
*Last updated: 2026-03-31 after initialization*
