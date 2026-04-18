---
phase: 16-review-ui
plan: 01
status: complete
started: 2026-04-18
completed: 2026-04-18
---

# Summary: Layout Restructure

**Restructured review sheet with compact header, Overall-first layout, and inline ratings.**

## Completed

### Task 1: Restructure header
- Title group with "Review" heading + place name subtitle
- Removed View Place button (simplified navigation)
- Removed share icon from header (moved to footer)
- Cleaned up unused CSS (.view-place-btn, .sheet-icon-btn)

### Task 2: Flip Overall before Dishes
- Overall section now appears first in sheet body
- Users can rate overall experience without scrolling past dishes

### Task 3: Compact overall ratings
- Rating and Price on same row (saves ~50px)
- Smaller 24px stars (consistent with dish cards)
- New .overall-ratings-row and .rating-group styles

### Task 4: Move share to footer
- Share button in footer: [Delete] [Share] [Save]
- Added .sheet-btn.secondary style
- Shorter button labels

### Task 5: Remove photo section label
- Removed "Place Photos (ambiance, etc.)" label
- Photos are self-explanatory
- Cleaned up unused CSS

## Verification

- [x] Header shows "Review" title with place name subtitle
- [x] Only close button in header
- [x] Overall section appears before Dishes
- [x] Rating and Price on same row
- [x] Stars are 24px (smaller)
- [x] Share button in footer (for existing reviews)
- [x] No "Place Photos" label
- [x] Dark mode works
- [x] No console errors

## Files Modified

- `webapp/index.html` - Review sheet structure, version bumps
- `webapp/styles.css` - New compact styles, removed unused classes
- `webapp/app.js` - Simplified openReviewSheet(), removed View Place logic

## Commits

1. `feat(16-01): restructure review sheet header` - 0ebce61
2. `feat(16-01): flip Overall before Dishes in review sheet` - fa2ced6
3. `feat(16-01): compact overall ratings on same row` - 9271e74
4. `feat(16-01): move share button to footer` - c17677d
5. `feat(16-01): remove photo section label` - bf704c6

## Next

Ready for 16-02-PLAN.md (Collapsible dish cards)
