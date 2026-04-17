---
phase: 14-medium-priority-ux
plan: 01
status: complete
started: 2026-04-17
completed: 2026-04-17
---

# Summary: Map Improvements

**Auto-center map on user location when within 200km of places; filter chips now show counts.**

## Completed

### Task 1: Auto-center map on user location
Modified map initialization to center on user if location granted and nearby:
- Check if user within 200km of any saved place using Haversine calculation
- If nearby, center map on user with zoom 13 and show blue dot marker
- Fall back to fitBounds on all places if location denied or user far from places
- Uses existing `requestUserLocation()` in parallel with place fetch

### Task 2: Add filter chip counts
Added counts to all filter chips across map, list, and reviews views:
- `updateMapFilterCounts()` - Map filter chips: "All (15)" / "To Visit (12)" / "Visited ✓ (3)"
- `updateVisitedChipCounts()` - List view chips with same pattern
- `updateReviewFilterCounts()` - Review chips: "All (X)" / "With Photos (Y)" / "5 ⭐ (Z)" / "4 ⭐ (W)"
- Counts update when places/reviews loaded and when filters change
- `updateAllFilterCounts()` helper for convenience

## Verification

- [x] Map centers on user location if permission granted and within 200km of places
- [x] Map falls back to fitBounds if location denied/unavailable
- [x] All filter chips show counts (map, list, reviews tabs)
- [x] Counts update when filters change

## Files Modified

- `webapp/app.js` - Auto-center logic, filter count functions

## Commits

1. `feat(14-01): auto-center map on user location` - 4d08038

## Next

Ready for 14-02-PLAN.md (Dark mode support)
