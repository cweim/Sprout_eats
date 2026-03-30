# Architecture

**Analysis Date:** 2026-03-30

## Pattern Overview

**Overall:** Layered (N-tier) Telegram Bot Application

**Key Characteristics:**
- Async-first design using asyncio
- Clear separation between bot handlers and services
- Repository pattern for data access
- Stateless services with functional design

## Layers

**Presentation Layer (bot/):**
- Purpose: Telegram bot interface and user interaction
- Contains: Command handlers, message handlers, inline keyboard callbacks
- Location: `bot/main.py`, `bot/handlers.py`
- Depends on: Services, Database repository
- Used by: Telegram Bot API (polling)

**Service Layer (services/):**
- Purpose: Business logic and external integrations
- Contains: Download, transcription, place search, map generation
- Location: `services/downloader.py`, `services/transcriber.py`, `services/places.py`, `services/maps.py`
- Depends on: Config, external APIs/libraries
- Used by: Bot handlers

**Repository Layer (database/):**
- Purpose: Data access abstraction
- Contains: CRUD operations for Place model
- Location: `database/repository.py`
- Depends on: Database models, SQLAlchemy
- Used by: Bot handlers

**Model Layer (database/):**
- Purpose: Data structures and ORM
- Contains: SQLAlchemy Place model, database initialization
- Location: `database/models.py`
- Depends on: Config (database URL)
- Used by: Repository

**Configuration Layer:**
- Purpose: Environment-based configuration
- Contains: All environment variables and paths
- Location: `config.py`
- Depends on: python-dotenv
- Used by: All layers

## Data Flow

**URL Processing (main workflow):**

1. User sends Instagram/TikTok URL → `bot/handlers.py:handle_text()`
2. URL validated via `is_valid_url()` → `services/downloader.py`
3. Video downloaded with audio extraction → `services/downloader.py:download_content()`
4. Audio transcribed to text → `services/transcriber.py:transcribe_audio()`
5. Combined text (title + description + transcript) searched → `services/places.py:search_place()`
6. Place saved to database → `database/repository.py:add_place()`
7. Location pin and confirmation sent to user
8. Temp files cleaned up → `services/downloader.py:cleanup_files()`

**Manual Place Search (fallback):**

1. User sends text (when `pending_url` exists in context)
2. Text searched directly → `services/places.py:search_place()`
3. Place saved and location sent
4. Pending state cleared

**State Management:**
- User state stored in `context.user_data` (Telegram context)
- Keys: `pending_url`, `pending_platform`
- Database state via SQLAlchemy sessions (no long-lived connections)

## Key Abstractions

**Service Modules (Functional):**
- Purpose: Encapsulate external integrations
- Examples: `services/downloader.py`, `services/places.py`
- Pattern: Module-level async functions, no classes

**Data Transfer Objects:**
- Purpose: Type-safe data passing between layers
- Examples: `DownloadResult` (`services/downloader.py`), `PlaceResult` (`services/places.py`)
- Pattern: Python dataclasses

**Repository:**
- Purpose: Abstract database operations
- Example: `database/repository.py`
- Pattern: Functions with session context managers

## Entry Points

**CLI Entry:**
- Location: `run.py`
- Triggers: `python run.py` command
- Responsibilities: Import and call `bot.main.main()`

**Bot Main:**
- Location: `bot/main.py:main()`
- Triggers: Called by CLI entry
- Responsibilities: Initialize database, create Telegram Application, register handlers, start polling

## Error Handling

**Strategy:** Try-except at handler level with user-friendly messages

**Patterns:**
- Handlers catch generic `Exception` and reply with error message
- Services raise `ValueError` for configuration errors
- Graceful fallbacks (e.g., if transcription fails, use title+description only)

## Cross-Cutting Concerns

**Logging:**
- Python logging module to stdout
- INFO level by default
- Format: timestamp - name - level - message

**Validation:**
- URL validation via string matching in `services/downloader.py`
- API key presence checked before calls

**Async Execution:**
- All handlers are `async def`
- Blocking I/O wrapped in `run_in_executor()` (yt-dlp, Whisper)
- aiohttp for async HTTP calls

---

*Architecture analysis: 2026-03-30*
*Update when major patterns change*
