---
phase: 02-reliability
plan: 02
subsystem: services, bot
tags: [timeout, error-handling, ux, async]

requires:
  - phase: 02-01
    provides: retry logic for API calls
provides:
  - Download timeout protection (120s)
  - DownloadTimeoutError exception class
  - Friendly, personality-driven error messages
  - Context-aware error handling
affects: []

tech-stack:
  added: []
  patterns: [asyncio.timeout for async operations]

key-files:
  created: []
  modified: [services/downloader.py, tests/test_downloader.py, bot/handlers.py]

key-decisions:
  - "120s timeout balances large videos vs user patience"
  - "Context-aware errors (timeout vs network vs generic)"
  - "Keep logging actual errors while showing friendly messages"

patterns-established:
  - "Friendly error message pattern with emojis"
  - "Context-aware exception handling"

issues-created: []

duration: 3min
completed: 2026-04-01
---

# Phase 2 Plan 02: Download Timeout and Friendly Errors Summary

**Timeout protection (120s) and cute, friendly error messages throughout the bot**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-01
- **Completed:** 2026-04-01
- **Tasks:** 2
- **Files created:** 0
- **Files modified:** 3

## Accomplishments

- Added DownloadTimeoutError exception class to services/downloader.py
- Wrapped download execution with asyncio.timeout(120s)
- Added 2 tests for timeout error attributes and constant
- Updated all error messages in bot/handlers.py to friendly tone
- Context-aware error handling (timeout vs network vs generic)
- Maintains error logging for debugging

## Task Commits

Each task was committed atomically:

1. **Task 1: Add download timeout** - `4cf8e4f` (feat)
2. **Task 2: Friendly error messages** - `975e5d5` (feat)

**Plan metadata:** (pending)

## Files Modified

- `services/downloader.py` - DownloadTimeoutError class, DOWNLOAD_TIMEOUT constant, asyncio.timeout wrapper
- `tests/test_downloader.py` - TestDownloadTimeout class with 2 tests
- `bot/handlers.py` - Friendly error messages with emojis, DownloadTimeoutError import

## Error Messages Updated

| Location | Old | New |
|----------|-----|-----|
| handle_url (timeout) | "Error processing video: ..." | "Oh no! This video is taking too long to download. Maybe try a shorter one?" |
| handle_url (network) | "Error processing video: ..." | "Hmm, I'm having trouble connecting right now. Give me a moment and try again!" |
| handle_url (generic) | "Error processing video: ..." | "Oops! Something went wrong while processing that video. Mind trying again?" |
| handle_text | "Error searching: ..." | "I couldn't find that place. Could you try a different name or be more specific?" |
| map_command | "Error generating map: ..." | "I had trouble making the map. Let me know if this keeps happening!" |

## Decisions Made

- 120s timeout provides good balance for large videos
- Separate DownloadTimeoutError exception for specific handling
- Keep technical errors in logs, friendly messages for users

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## Phase 2 Complete

Phase 2 (Reliability) is now complete:
- 02-01: Retry logic with tenacity for API calls
- 02-02: Download timeout and friendly error messages

Ready for Phase 3: Multi-Place Support

---
*Phase: 02-reliability*
*Completed: 2026-04-01*
