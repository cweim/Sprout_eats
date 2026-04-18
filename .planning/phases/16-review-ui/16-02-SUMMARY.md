---
phase: 16-review-ui
plan: 02
status: complete
started: 2026-04-18
completed: 2026-04-18
---

# Summary: Collapsible Dish Cards

**Made dish cards collapsible for space efficiency.**

## Completed

### Task 1: Update dish card HTML structure
- New collapsible structure with `.dish-card-header` and `.dish-card-details`
- Header row: drag handle + name input + stars + expand btn + remove btn
- Details section: photos + remarks (collapsed by default)
- New cards start expanded, existing cards collapse if no content

### Task 2: Add collapsed/expanded CSS
- `.dish-card-details` uses max-height animation for smooth collapse
- `.dish-expand-btn` styling with hover states
- Smaller 20px stars in compact header (was 24px)
- Hide drag handle for single dish (`:only-child`)

### Task 3: Auto-expand on focus
- Name input focus listener expands card if collapsed
- Seamless UX when user starts typing

### Task 4: Shorter placeholders
- "What did you order?" -> "Dish name"
- "Any thoughts on this dish?" -> "Notes"
- "How was the overall experience?" -> "Overall thoughts"

### Task 5: Update existing card population
- Cards with photos/remarks start expanded
- Cards with only name+rating start collapsed
- Expand button state matches card state

## Verification

- [x] New dish cards start expanded
- [x] Existing dishes with content start expanded
- [x] Existing dishes without photos/remarks start collapsed
- [x] Expand button toggles details visibility
- [x] Smooth animation on expand/collapse
- [x] Stars work in compact header row
- [x] Drag handle hidden for single dish
- [x] Focus on name input expands card
- [x] Shorter placeholder text throughout
- [x] Dark mode works (uses CSS variables)
- [x] No console errors

## Files Modified

- `webapp/app.js` - createDishCard() rewritten with collapsible logic
- `webapp/styles.css` - Expand button, collapsible details, smaller stars
- `webapp/index.html` - Overall placeholder shortened, version bumps

## Commits

1. `feat(16-02): collapsible dish cards` - 37db74a

## Phase 16 Complete

Both plans executed:
- 16-01: Layout restructure (Overall first, compact header)
- 16-02: Collapsible dish cards

Milestone v1.2 complete.
