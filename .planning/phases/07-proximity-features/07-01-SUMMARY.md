---
phase: 07-proximity-features
plan: 01
subsystem: webapp
tags: [geolocation, haversine, distance, sort]

requires:
  - phase: 06-04
    provides: Mini App with map/list views, visited/notes features
provides:
  - Haversine distance calculation
  - Sort by distance option
  - Distance display on cards and popups
  - Silent location request on init
affects: [07-02]

tech-stack:
  added: []
  patterns: [Haversine formula for distance, reactive UI on location change]

key-files:
  created: []
  modified: [webapp/app.js, webapp/index.html, webapp/styles.css]

key-decisions:
  - "Silent location request on init (no toast if denied)"
  - "Distance shown in meters if < 1km, otherwise km with 1 decimal"
  - "Sort by distance shows toast if location unavailable"

patterns-established:
  - "userLocation state for distance calculations"
  - "getPlaceDistance() returns null when location unavailable"

issues-created: []

duration: 4min
completed: 2026-04-03
---

# Phase 7 Plan 01: Distance Calculations & Display Summary

**Haversine distance calculation with sort-by-distance and distance display on cards/popups**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-03
- **Completed:** 2026-04-03
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Added `userLocation` state variable for storing user coordinates
- Implemented Haversine formula for accurate distance calculation
- Added `formatDistance()` helper (shows meters if < 1km, else km)
- Added `getPlaceDistance()` function (returns null if no location)
- Added `requestUserLocation()` for silent location request on app init
- Updated `goToMyLocation()` to store location and re-render views
- Added "Nearest" sort option to dropdown
- Updated `sortPlaces()` to handle distance sorting
- Added distance display on place cards ("📍 2.3km away")
- Added distance to popup meta section ("⭐ 4.5/5 · Cafe · 📍 500m")
- Added CSS styling for distance display

## Task Commits

1. **Task 1: Add distance calculation and sort-by-distance** - `c93d0e8` (feat)
2. **Task 2: Display distance on cards and popups** - `1d343f3` (feat)

## Files Modified

- `webapp/app.js` - Added distance utilities, updated card/popup rendering
- `webapp/index.html` - Added "Nearest" sort option
- `webapp/styles.css` - Added .place-card-distance styling

## Decisions Made

- Silent location request on init (no intrusive permission prompt)
- Format: meters if < 1km, otherwise 1 decimal km
- Toast feedback when sorting by distance without location

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## Next Plan Readiness

- Distance utilities available for 07-02 (nearby alerts)
- `userLocation` state can be reused
- Ready for 07-02 (Nearby Alerts & Bot Command)

---
*Phase: 07-proximity-features*
*Completed: 2026-04-03*
