# Codebase Structure

**Analysis Date:** 2026-03-30

## Directory Layout

```
discovery-bot/
├── run.py                 # CLI entry point
├── config.py              # Environment configuration
├── requirements.txt       # Python dependencies
├── .env                   # Environment variables (gitignored)
├── .env.example           # Environment template
├── .gitignore             # Git ignore rules
├── discovery_bot.db       # SQLite database (runtime)
│
├── bot/                   # Presentation layer
│   ├── __init__.py       # Package marker (empty)
│   ├── main.py           # Bot setup and handler registration
│   └── handlers.py       # All command and message handlers
│
├── services/              # Business logic layer
│   ├── __init__.py       # Package marker (empty)
│   ├── downloader.py     # Video download (yt-dlp)
│   ├── transcriber.py    # Audio transcription (Whisper)
│   ├── places.py         # Google Places API
│   └── maps.py           # Google Static Maps API
│
├── database/              # Data access layer
│   ├── __init__.py       # Package marker (empty)
│   ├── models.py         # SQLAlchemy models
│   └── repository.py     # Data access functions
│
├── temp/                  # Temporary files (gitignored)
├── venv/                  # Virtual environment (gitignored)
└── .planning/             # Project planning docs
    └── codebase/          # Codebase analysis
```

## Directory Purposes

**bot/**
- Purpose: Telegram bot logic and user interaction
- Contains: Python modules for bot setup and handlers
- Key files:
  - `main.py` - Application initialization, handler registration (56 lines)
  - `handlers.py` - All command and message handlers (233 lines)
- Subdirectories: None

**services/**
- Purpose: External integrations and business logic
- Contains: Independent service modules (no shared base)
- Key files:
  - `downloader.py` - Instagram/TikTok download via yt-dlp (100 lines)
  - `transcriber.py` - Whisper audio transcription (31 lines)
  - `places.py` - Google Places API search (71 lines)
  - `maps.py` - Google Static Maps generation (67 lines)
- Subdirectories: None

**database/**
- Purpose: SQLAlchemy ORM and data access
- Contains: Model definitions and repository functions
- Key files:
  - `models.py` - Place model and init_db() (33 lines)
  - `repository.py` - CRUD operations (51 lines)
- Subdirectories: None

**temp/**
- Purpose: Temporary storage for downloaded videos/audio
- Contains: Runtime-generated files (deleted after processing)
- Created by: `config.py` on import
- Cleaned by: `cleanup_files()` in `services/downloader.py`

## Key File Locations

**Entry Points:**
- `run.py` - CLI entry, calls `bot.main.main()`
- `bot/main.py` - Bot initialization and polling start

**Configuration:**
- `config.py` - All environment variables and paths
- `.env` - Secrets (gitignored)
- `.env.example` - Template with placeholders

**Core Logic:**
- `bot/handlers.py` - All user interaction handlers
- `services/downloader.py` - Video download orchestration
- `services/places.py` - Location search logic

**Data Access:**
- `database/models.py` - Place SQLAlchemy model
- `database/repository.py` - add_place, get_all_places, etc.

**Testing:**
- None (no test files present)

**Documentation:**
- None (no README or docs)

## Naming Conventions

**Files:**
- snake_case for all Python modules (`handlers.py`, `downloader.py`)
- Lowercase for config files (`config.py`, `requirements.txt`)

**Directories:**
- Lowercase singular/plural as appropriate (`bot/`, `services/`, `database/`)
- Functional naming (`temp/` for temporary files)

**Special Patterns:**
- `__init__.py` for package markers (all empty)
- `.env.example` for environment template

## Where to Add New Code

**New Bot Command:**
- Handler: `bot/handlers.py`
- Registration: `bot/main.py` (add CommandHandler)
- Follow pattern: `async def name_command(update, context)`

**New Service:**
- Implementation: `services/{name}.py`
- Pattern: Module with async functions
- Import in: `bot/handlers.py` as needed

**New Database Model:**
- Model: `database/models.py` (add class)
- Repository: `database/repository.py` (add functions)
- Init: Ensure `init_db()` creates table

**New Utility:**
- If shared: Create `utils/` directory
- If service-specific: Add to relevant service module

## Special Directories

**temp/**
- Purpose: Volatile storage for video/audio files
- Source: Created by yt-dlp during download
- Committed: No (in .gitignore)
- Cleanup: Via `cleanup_files()` after processing

**venv/**
- Purpose: Python virtual environment
- Source: Created via `python -m venv venv`
- Committed: No (in .gitignore)

**.planning/**
- Purpose: GSD planning documents
- Source: Created by /gsd:map-codebase
- Committed: Yes (project documentation)

---

*Structure analysis: 2026-03-30*
*Update when directory structure changes*
