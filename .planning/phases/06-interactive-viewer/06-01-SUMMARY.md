---
phase: 06-interactive-viewer
plan: 01
subsystem: api, webapp, bot
tags: [fastapi, mini-app, telegram-webapp, leaflet, infrastructure]

requires:
  - phase: 05-02
    provides: Complete Phase 5 (Language Support)
provides:
  - FastAPI backend with /api/places endpoint
  - Mini App HTML/CSS/JS skeleton with Telegram theming
  - Bot integration with viewer launch button
  - WEBAPP_URL configuration
affects: [06-02, 06-03, 06-04]

tech-stack:
  added: [fastapi, uvicorn, telegram-webapp-sdk, leaflet-js]
  patterns: [Place to dict serialization, Telegram theme CSS variables, View toggle pattern]

key-files:
  created: [api/__init__.py, api/routes.py, api/main.py, webapp/index.html, webapp/styles.css, webapp/app.js]
  modified: [requirements.txt, config.py, bot/handlers.py]

key-decisions:
  - "FastAPI for API backend (async, lightweight)"
  - "Vanilla HTML/CSS/JS for Mini App (no build step)"
  - "CORS allow all origins for development"
  - "Viewer button only shown when WEBAPP_URL configured"

patterns-established:
  - "place_to_dict() for JSON serialization"
  - "Telegram theme CSS variables with fallbacks"
  - "View toggle state management"

issues-created: []

duration: 3min
completed: 2026-04-02
---

# Phase 6 Plan 01: Mini App Infrastructure Summary

**FastAPI backend, Mini App skeleton with Telegram theming, bot viewer integration**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-02
- **Completed:** 2026-04-02
- **Tasks:** 3
- **Files created:** 6
- **Files modified:** 3

## Accomplishments

- Added FastAPI with places API endpoint (GET /api/places, GET /api/health)
- Created Mini App skeleton with Telegram WebApp SDK integration
- Styled with Telegram theme CSS variables and cute, friendly design
- Added view toggle structure (map/list) ready for next plans
- Added "Open Viewer" button to bot menu (when WEBAPP_URL configured)
- Added /viewer command for direct Mini App access
- CORS enabled for Mini App access to API

## Task Commits

Each task was committed atomically:

1. **Task 1: Add FastAPI and create places API endpoint** - `434c4f5` (feat)
2. **Task 2: Create Mini App HTML skeleton** - `40c4af0` (feat)
3. **Task 3: Add Mini App launch button to bot** - `ed2823b` (feat)

## Files Created

- `api/__init__.py` - Empty init for api module
- `api/routes.py` - GET /api/places and /api/health endpoints
- `api/main.py` - FastAPI app with CORS middleware
- `webapp/index.html` - HTML structure with Telegram WebApp SDK
- `webapp/styles.css` - Telegram-themed CSS with cute styling
- `webapp/app.js` - Initialization, state management, API fetch placeholder

## Files Modified

- `requirements.txt` - Added fastapi and uvicorn
- `config.py` - Added WEBAPP_URL setting
- `bot/handlers.py` - Added WebAppInfo import, viewer button, /viewer command

## Decisions Made

- FastAPI chosen for API (async, lightweight, matches existing bot patterns)
- Vanilla HTML/CSS/JS for Mini App (no build step needed)
- CORS allow all origins for development simplicity
- Viewer button conditionally shown only when WEBAPP_URL is set

## Issues Encountered

None

## Next Phase Readiness

- API ready to serve places data
- Mini App skeleton ready for map/list implementation
- Bot can launch Mini App when deployed
- Ready for 06-02 (Map View with Leaflet)

**To test locally:**
1. Run API: `uvicorn api.main:app --reload`
2. Open webapp/index.html in browser
3. Set API_URL in app.js to 'http://localhost:8000'

**For production:**
1. Deploy webapp/ to GitHub Pages
2. Set WEBAPP_URL in .env to the GitHub Pages URL
3. Run bot - "Open Viewer" button will appear

---
*Phase: 06-interactive-viewer*
*Completed: 2026-04-02*
