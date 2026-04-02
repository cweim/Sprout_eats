---
phase: 07-proximity-features
plan: 02
subsystem: webapp, api, bot
tags: [nearby, geolocation, telegram-bot, fastapi]

requires:
  - phase: 07-01
    provides: Distance calculation utilities, userLocation state
provides:
  - Nearby places alert on Mini App load
  - GET /api/places/nearby endpoint
  - /nearby bot command with location sharing
affects: []

tech-stack:
  added: []
  patterns: [ReplyKeyboardMarkup for location request, server-side Haversine]

key-files:
  created: []
  modified: [webapp/app.js, api/routes.py, bot/handlers.py, bot/main.py]

key-decisions:
  - "1km radius for Mini App nearby alert"
  - "5km default radius for API and bot command"
  - "Limit to 5 places in bot response"

patterns-established:
  - "ReplyKeyboardMarkup with request_location for sharing"
  - "ReplyKeyboardRemove after processing location"

issues-created: []

duration: 5min
completed: 2026-04-03
---

# Phase 7 Plan 02: Nearby Alerts & Bot Command Summary

**Nearby alert on Mini App load and /nearby bot command with location sharing**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-03
- **Completed:** 2026-04-03
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

### Task 1: Mini App Nearby Alert
- Added `nearbyAlertShown` flag to show alert once per session
- Added `checkNearbyPlaces()` to detect places within 1km
- Shows toast with haptic feedback: "📍 3 saved places within 1km!"
- Called automatically after location acquired

### Task 2: API Endpoint
- Added `haversine_distance()` to api/routes.py
- Added `GET /api/places/nearby?lat=X&lng=Y&radius_km=5` endpoint
- Returns places sorted by distance with `distance_km` field
- Placed before `/places/{place_id}` to avoid path conflict

### Task 3: Bot /nearby Command
- Added `haversine_distance()` to handlers.py
- Added `nearby_command()` with ReplyKeyboardMarkup for location sharing
- Added `handle_location()` to process shared location
- Shows up to 5 nearby places with distances
- Friendly messages for no places saved / no nearby places
- Registered in main.py with command menu entry

## Task Commits

1. **Task 1: Mini App nearby alert** - `d7d4268` (feat)
2. **Task 2: API endpoint** - `d84cbc0` (feat)
3. **Task 3: /nearby bot command** - `dacf2e8` (feat)

## Files Modified

- `webapp/app.js` - Added checkNearbyPlaces(), nearbyAlertShown flag
- `api/routes.py` - Added haversine_distance(), /places/nearby endpoint
- `bot/handlers.py` - Added haversine_distance(), nearby_command(), handle_location()
- `bot/main.py` - Registered handlers, added /nearby to commands menu

## Decisions Made

- 1km radius for proactive Mini App alert (non-intrusive)
- 5km default radius for explicit API/bot requests
- Limit bot response to 5 places (more shown in viewer)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## Phase 7 Complete

All plans for Phase 7 (Proximity Features) have been implemented:
- 07-01: Distance calculations and display
- 07-02: Nearby alerts and bot command

---
*Phase: 07-proximity-features*
*Completed: 2026-04-03*
