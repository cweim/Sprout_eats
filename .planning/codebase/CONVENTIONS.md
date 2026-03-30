# Coding Conventions

**Analysis Date:** 2026-03-30

## Naming Patterns

**Files:**
- snake_case for all modules (`handlers.py`, `downloader.py`, `repository.py`)
- Lowercase for config (`config.py`, `requirements.txt`)
- Empty `__init__.py` for package markers

**Functions:**
- snake_case for all functions (`download_content`, `search_place`, `add_place`)
- Async functions use `async def` without special prefix
- Command handlers: `{name}_command` (`start_command`, `places_command`)
- Callback handlers: `{name}_callback` (`clear_callback`)
- Private functions: underscore prefix (`_download`, `_transcribe`, `_get_model`)

**Variables:**
- snake_case for variables (`url_hash`, `output_template`, `status_msg`)
- UPPER_SNAKE_CASE for constants (`STATIC_MAPS_URL`, `PLACES_TEXT_SEARCH_URL`)

**Types:**
- PascalCase for classes (`Place`, `DownloadResult`, `PlaceResult`)
- Dataclasses for DTOs (`@dataclass`)
- SQLAlchemy models inherit from `Base`

## Code Style

**Formatting:**
- 4-space indentation (Python standard)
- No semicolons
- Double quotes preferred for strings (59 double vs 2 single in handlers.py)
- No configured formatter (no .prettierrc, black config)

**Linting:**
- None configured (no .eslintrc, pyproject.toml linting)
- No type checker (no mypy config)

**Line Length:**
- No explicit limit configured
- Generally under 100 characters

## Import Organization

**Order (observed pattern):**
1. Standard library imports (`logging`, `asyncio`, `pathlib`)
2. Third-party imports (`telegram`, `yt_dlp`, `aiohttp`)
3. Local imports (`config`, `services.*`, `database.*`)

**Grouping:**
- No blank lines between groups (imports consecutive)
- No explicit sorting

**Path Aliases:**
- None (relative imports from project root)

## Error Handling

**Patterns:**
- Try-except at handler level with generic `Exception`
- User-friendly error messages via `update.message.reply_text()`
- Services raise `ValueError` for config errors
- Graceful fallbacks (transcription failure → use title only)

**Error Types:**
- Broad `except Exception as e:` in handlers
- No custom exception classes
- Errors logged via `logger.error()`

## Logging

**Framework:**
- Python `logging` module
- Logger per module: `logger = logging.getLogger(__name__)`

**Patterns:**
- INFO level for normal operations
- WARNING for non-fatal issues (`logger.warning()`)
- ERROR for failures (`logger.error()`)
- Format: `%(asctime)s - %(name)s - %(levelname)s - %(message)s`

## Comments

**When to Comment:**
- Step-by-step workflow comments (`# Step 1: Download`, `# Step 2: Transcribe`)
- Section headers in config (`# Telegram`, `# Google APIs`)
- Complex logic explanation (`# Check for duplicate by google_place_id`)

**JSDoc/TSDoc:**
- Not applicable (Python)

**Docstrings:**
- Minimal usage (only 1-2 functions have docstrings)
- Module docstrings only in `run.py`
- Prefer self-documenting function names

**TODO Comments:**
- None found in codebase

## Function Design

**Size:**
- Most functions under 30 lines
- `handle_url()` is largest at ~80 lines (could be refactored)

**Parameters:**
- Telegram handlers: `(update: Update, context: ContextTypes.DEFAULT_TYPE)`
- Services: Named parameters with type hints
- Optional parameters with `Optional[type]` and defaults

**Return Values:**
- Services return dataclasses or `Optional[type]`
- Handlers return `None` (side effects via Telegram API)
- Repository returns model instances or counts

## Module Design

**Exports:**
- No explicit `__all__` definitions
- Import specific functions/classes as needed

**Barrel Files:**
- Empty `__init__.py` files (no re-exports)
- Import directly from modules (`from services.places import search_place`)

## Async Patterns

**Async Functions:**
- All handlers and services are `async def`
- Blocking operations wrapped in `loop.run_in_executor()`
- aiohttp for HTTP calls (context managers)

**Example:**
```python
async def transcribe_audio(audio_path: Path) -> str:
    loop = asyncio.get_event_loop()
    def _transcribe():
        # blocking code
    text = await loop.run_in_executor(None, _transcribe)
    return text
```

---

*Convention analysis: 2026-03-30*
*Update when patterns change*
