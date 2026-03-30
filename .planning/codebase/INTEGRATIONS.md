# External Integrations

**Analysis Date:** 2026-03-30

## APIs & External Services

**Telegram Bot API:**
- Service: Telegram Bot Platform
- SDK/Client: python-telegram-bot>=20.0
- Auth: `TELEGRAM_BOT_TOKEN` env var
- Implementation: `bot/main.py`, `bot/handlers.py`
- Features used:
  - Command handlers (`/start`, `/places`, `/map`, `/clear`)
  - Message handlers (URLs and text)
  - Inline keyboards (confirmation dialogs)
  - Location sharing (`reply_location`)
  - Photo upload (`reply_photo`)

**Google Places API (New):**
- Service: Google Cloud Platform
- Endpoint: `https://places.googleapis.com/v1/places:searchText`
- Auth: `GOOGLE_API_KEY` env var via `X-Goog-Api-Key` header
- Implementation: `services/places.py`
- Features: Text-based place search with location data

**Google Static Maps API:**
- Service: Google Cloud Platform
- Endpoint: `https://maps.googleapis.com/maps/api/staticmap`
- Auth: `GOOGLE_API_KEY` env var via query parameter
- Implementation: `services/maps.py`
- Features: Static map image generation with colored markers

**External APIs:**
- None (video platforms accessed via yt-dlp scraping)

## Data Storage

**Databases:**
- SQLite - Local file database
- Connection: `DATABASE_PATH` env var (default: `discovery_bot.db`)
- Client: SQLAlchemy 2.0+
- Implementation: `database/models.py`, `database/repository.py`
- Schema: Single `places` table

**File Storage:**
- Local filesystem - Temporary video/audio files
- Location: `temp/` directory
- Cleanup: `cleanup_files()` in `services/downloader.py`

**Caching:**
- None (Whisper model cached in memory after first load)

## Authentication & Identity

**Auth Provider:**
- None (no user authentication)
- Bot identifies users via Telegram chat context

**OAuth Integrations:**
- None

## Monitoring & Observability

**Error Tracking:**
- None (logging to stdout only)

**Analytics:**
- None

**Logs:**
- Python logging module
- Format: `%(asctime)s - %(name)s - %(levelname)s - %(message)s`
- Level: INFO
- Implementation: `bot/main.py`

## CI/CD & Deployment

**Hosting:**
- Not configured (runs locally)

**CI Pipeline:**
- None

## Environment Configuration

**Development:**
- Required env vars: `TELEGRAM_BOT_TOKEN`, `GOOGLE_API_KEY`
- Optional: `WHISPER_MODEL`, `DATABASE_PATH`
- Secrets location: `.env` file (gitignored)

**Staging:**
- Not configured

**Production:**
- Not configured

## Webhooks & Callbacks

**Incoming:**
- Telegram Bot API (polling mode, not webhooks)

**Outgoing:**
- None

## Video Platform Integration

**Instagram:**
- Platform detection: `instagram.com`, `instagr.am` URLs
- Download: via yt-dlp
- Data extracted: video, audio (MP3), title, description
- Implementation: `services/downloader.py`

**TikTok:**
- Platform detection: `tiktok.com`, `vm.tiktok.com` URLs
- Download: via yt-dlp
- Data extracted: video, audio (MP3), title, description
- Implementation: `services/downloader.py`

## Third-Party Libraries

**FFmpeg:**
- Used by: yt-dlp for audio extraction
- Format: MP3 at 192kbps
- Must be installed on system

**OpenAI Whisper:**
- Used for: Audio transcription
- Model: Configurable via `WHISPER_MODEL` (default: "base")
- Implementation: `services/transcriber.py`

---

*Integration audit: 2026-03-30*
*Update when adding/removing external services*
