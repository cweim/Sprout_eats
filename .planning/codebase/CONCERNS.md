# Codebase Concerns

**Analysis Date:** 2026-03-30

## Tech Debt

**Large Handler Function:**
- Issue: `handle_url()` in `bot/handlers.py` is 80+ lines handling multiple sequential steps
- Why: Rapid development, all workflow logic in one place
- Impact: Hard to test, difficult to maintain, single point of failure
- Fix approach: Extract steps into separate functions (`download_video()`, `process_transcription()`, `search_and_save_place()`)

**Code Duplication in Handlers:**
- Issue: Near-identical success response patterns in `handle_url()` (lines 159-168) and `handle_text()` (lines 220-229)
- Files: `bot/handlers.py`
- Why: Copy-paste development
- Impact: Bug fixes need to be applied twice
- Fix approach: Extract common `send_place_confirmation()` function

**Missing Docstrings:**
- Issue: Most functions lack docstrings
- Files: `services/downloader.py` (0 docstrings), `bot/handlers.py` (1 docstring)
- Why: Not prioritized during development
- Impact: Harder for new developers to understand intent
- Fix approach: Add docstrings to public functions

## Known Bugs

**None identified** - codebase appears functional but untested.

## Security Considerations

**Missing HTTP Response Validation:**
- Risk: `services/places.py` doesn't check response status before parsing JSON
- Files: `services/places.py` (lines 38-39)
- Current mitigation: None
- Recommendations: Check `response.status == 200` before `response.json()`, handle 4xx/5xx errors

**Unchecked API Errors:**
- Risk: Google Places API errors (rate limit, invalid key) not properly handled
- Files: `services/places.py`, `services/maps.py`
- Current mitigation: Generic exception handling in callers
- Recommendations: Check for `error` key in response, handle specific HTTP status codes

## Performance Bottlenecks

**First Transcription Cold Start:**
- Problem: Whisper model loaded on first transcription request
- Files: `services/transcriber.py` (lines 11-15)
- Measurement: ~10-30 seconds for model loading depending on size
- Cause: Lazy loading of model
- Improvement path: Pre-load model on startup or add loading indicator

**No Download Timeout:**
- Problem: yt-dlp downloads have no timeout
- Files: `services/downloader.py` (lines 57-64)
- Measurement: Large videos could hang indefinitely
- Cause: `run_in_executor()` without timeout
- Improvement path: Add `asyncio.wait_for()` with timeout

## Fragile Areas

**URL Detection:**
- Files: `services/downloader.py` (lines 21-25)
- Why fragile: Simple string matching (`"instagram.com" in url`)
- Common failures: Short URLs, obfuscated links, edge cases
- Safe modification: Replace with regex patterns
- Test coverage: None

**Temp File Cleanup:**
- Files: `bot/handlers.py`, `services/downloader.py`
- Why fragile: Cleanup only called in specific code paths
- Common failures: Exception during processing leaves orphan files
- Safe modification: Use try/finally or context manager
- Test coverage: None

## Scaling Limits

**SQLite Database:**
- Current capacity: Thousands of places (sufficient for personal use)
- Limit: Concurrent writes, file locking on shared storage
- Symptoms at limit: Database locked errors
- Scaling path: Migrate to PostgreSQL for multi-user

**In-Memory Whisper Model:**
- Current capacity: Single model instance (~1-4GB RAM depending on size)
- Limit: Memory exhaustion with large models
- Symptoms at limit: Out of memory errors
- Scaling path: Use API-based transcription service

## Dependencies at Risk

**openai-whisper>=20231117:**
- Risk: From November 2023, may have compatibility issues with newer Python
- Impact: Transcription would fail
- Migration plan: Consider faster-whisper or whisper.cpp for production

## Missing Critical Features

**No Test Suite:**
- Problem: Zero automated tests
- Current workaround: Manual testing
- Blocks: CI/CD, confident refactoring, regression prevention
- Implementation complexity: Low (add pytest and basic unit tests)

**No README:**
- Problem: No setup instructions or documentation
- Current workaround: Read code to understand usage
- Blocks: Onboarding new developers
- Implementation complexity: Low (document existing functionality)

**No Error Recovery:**
- Problem: Failed downloads/transcriptions don't retry
- Current workaround: User must resend URL
- Blocks: Handling transient failures
- Implementation complexity: Medium (add retry logic with backoff)

## Test Coverage Gaps

**All Core Services Untested:**
- What's not tested: `services/downloader.py`, `services/places.py`, `services/transcriber.py`, `services/maps.py`
- Risk: Bugs in URL parsing, API integration, file handling
- Priority: High
- Difficulty to test: Medium (need to mock external APIs)

**Database Operations Untested:**
- What's not tested: `database/repository.py` CRUD operations
- Risk: Data corruption, duplicate handling bugs
- Priority: High
- Difficulty to test: Low (use test database)

**Handler Logic Untested:**
- What's not tested: `bot/handlers.py` workflow orchestration
- Risk: Incorrect state management, response formatting
- Priority: Medium
- Difficulty to test: Medium (need Telegram mocking)

---

*Concerns audit: 2026-03-30*
*Update as issues are fixed or new ones discovered*
