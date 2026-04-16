---
phase: 12-critical-ux-fixes
plan: 03
status: complete
started: 2026-04-16T17:23:07Z
completed: 2026-04-16T17:25:17Z
---

# Summary: List Card Behavior + Review Edit UX

## Completed

### Task 1: Add visual transition feedback for list card tap
Added toast feedback when user taps a place card in list view:
- Shows "📍 Showing on map..." before switching to map view
- Provides clear indication that tapping does something intentional

### Task 2: Update review button text based on edit mode
Updated save button text to distinguish between new and edit modes:
- New review: "Save Review"
- Editing existing: "Update Review"
- Applied in openReviewSheet() for both success and error paths

### Task 3: Verify review indicator badge on list cards
Verified existing implementation works correctly:
- Badge shows ✍️ + stars on place cards with reviews
- Badges update automatically when reviews saved/deleted
- `loadReviews()` → `applyFilters()` → `renderPlacesList()` chain works

## Verification

- [x] List card tap shows feedback toast before map switch
- [x] Save button shows "Update Review" when editing existing review
- [x] Review badges visible on place cards with reviews
- [x] Badges update when reviews saved/deleted
- [x] No console errors

## Commits

1. `feat(12-03): improve list card behavior and review edit UX`
