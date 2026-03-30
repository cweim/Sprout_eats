# Technology Stack

**Analysis Date:** 2026-03-30

## Languages

**Primary:**
- Python 3.11.8 - All application code

**Secondary:**
- None

## Runtime

**Environment:**
- Python 3.11.8 (via pyenv)
- Virtual environment: `venv/`

**Package Manager:**
- pip (implicit via requirements.txt)
- No lockfile (only `requirements.txt` with minimum versions)

## Frameworks

**Core:**
- python-telegram-bot 20.0+ - Async Telegram bot framework

**Testing:**
- None configured

**Build/Dev:**
- None (no build step required for Python)

## Key Dependencies

**Critical:**
- python-telegram-bot>=20.0 - Telegram Bot API client (`bot/main.py`, `bot/handlers.py`)
- yt-dlp>=2024.1.0 - Video/audio download from Instagram/TikTok (`services/downloader.py`)
- openai-whisper>=20231117 - Audio transcription (`services/transcriber.py`)
- sqlalchemy>=2.0.0 - ORM for SQLite database (`database/models.py`)

**Infrastructure:**
- aiohttp>=3.9.0 - Async HTTP for Google APIs (`services/places.py`, `services/maps.py`)
- aiofiles>=23.0.0 - Async file operations
- python-dotenv>=1.0.0 - Environment variable loading (`config.py`)

## Configuration

**Environment:**
- `.env` file for secrets (gitignored)
- `.env.example` as template
- Key variables:
  - `TELEGRAM_BOT_TOKEN` - Bot authentication
  - `GOOGLE_API_KEY` - Google Places/Maps APIs
  - `WHISPER_MODEL` - Transcription model size (default: "base")
  - `DATABASE_PATH` - SQLite file path (default: "discovery_bot.db")

**Build:**
- No build configuration (interpreted Python)

## Platform Requirements

**Development:**
- macOS/Linux/Windows with Python 3.11+
- FFmpeg (required by yt-dlp for audio extraction)

**Production:**
- Python 3.11+ runtime
- FFmpeg installed
- Network access to Telegram, Google APIs, Instagram, TikTok

---

*Stack analysis: 2026-03-30*
*Update after major dependency changes*
