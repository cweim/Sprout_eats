---
phase: 15-polish
plan: 02
status: complete
started: 2026-04-17
completed: 2026-04-17
---

# Summary: Review Enhancements

**Added drag-to-reorder for dish cards and share review button with Telegram/clipboard fallback.**

## Completed

### Task 1: Drag-to-reorder dish cards
Added HTML5 drag-and-drop for dish cards:
- Drag handle (⠿) added to dish card header
- `draggable=true` attribute on dish cards
- `setupDishDragAndDrop()` with dragstart/dragend/dragover handlers
- `getDragAfterElement()` for determining drop position
- Visual feedback: opacity 0.5 + scale 0.98 while dragging
- Haptic feedback on drag start

### Task 2: Share review button
Added share button to review sheet header:
- SVG upload icon positioned next to close button
- `shareReview()` formats review text with stars/price symbols
- Primary: `Telegram.WebApp.switchInlineQuery()` opens chat picker
- Fallback: Copy to clipboard with toast notification
- Button only visible when editing existing review

## Verification

- [x] Drag handle visible on dish cards
- [x] Dragging works with visual feedback
- [x] Share button visible in review sheet (for existing reviews)
- [x] Share uses Telegram API or clipboard fallback
- [x] No console errors
- [x] Works in dark mode

## Files Modified

- `webapp/app.js` - Drag handlers, share function
- `webapp/styles.css` - Drag handle, dragging state, sheet-icon-btn
- `webapp/index.html` - Share button in review sheet header

## Commits

1. `feat(15-02): add drag-to-reorder for dish cards` - 0563df6
2. `feat(15-02): add share review button` - 94a4c02

## Next

Ready for 15-03-PLAN.md (Animations and gestures)
