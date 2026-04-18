# Review UI Audit

Audit date: 2026-04-18

## Entry Points Analyzed

1. **List View** → Click place card → Opens review sheet
2. **Map View** → Click marker popup → Review button → Opens review sheet
3. **Reviews Tab** → Click review card → Opens review sheet (with "View Place" button)

## Current Structure

```
Review Sheet (Bottom Sheet, 90vh max)
├── Header
│   ├── Drag handle
│   ├── Title "Review: {place name}"
│   ├── Share button (existing reviews only)
│   ├── View Place button (from Reviews tab only)
│   └── Close button
├── Body (scrollable)
│   ├── Dishes Section
│   │   ├── Dish Card(s)
│   │   │   ├── Drag handle + Name input + Remove btn
│   │   │   ├── Rating label + 5 stars
│   │   │   ├── Photo grid (2 photos, 56x56)
│   │   │   └── Remarks textarea
│   │   └── "+ Add another dish" button
│   └── Overall Section
│       ├── Rating row (label + 5 stars)
│       ├── Price row (label + 4 $ icons + price label)
│       ├── Place Photos (label + 3 photos, 72x72)
│       ├── Remarks textarea
│       └── "Edited X ago" timestamp
└── Footer
    ├── Delete Review button (existing only)
    └── Save/Update Review button
```

---

## Issues Identified

### High Priority

#### 1. Header Clutter
- Title "Review: Place Name" is redundant when user just clicked the place
- Share + View Place + Close = 3 buttons in header
- View Place button only appears from Reviews tab (inconsistent)
- Buttons positioned at `top: -8px` (above header baseline)

**Recommendation:** Simplify header. Show place name as small subtitle. Move share to footer or overflow menu.

#### 2. Vertical Space Per Dish Card
Each dish card is ~200px tall:
- Header row (drag + input + remove): ~48px
- Body row (Rating label + stars): ~36px
- Photo grid: ~68px
- Remarks textarea: ~62px
- Margins: ~24px

With 3 dishes = ~600px just for dishes. Leaves little room for Overall section without scrolling.

**Recommendation:** Collapse dish details. Show only name + rating inline. Expand on tap for photos/remarks.

#### 3. "Dishes" Before "Overall" Order
Forces user to scroll past all dishes to rate overall experience. Most users want to give quick overall rating.

**Recommendation:** Flip order: Overall first (collapsed by default if editing), then Dishes.

#### 4. Overall Section Too Spread Out
- Rating row
- Price row
- Photos section with label
- Remarks with meta

Takes ~250px minimum.

**Recommendation:** Compact layout. Rating + Price on same row. Photos inline with remarks.

### Medium Priority

#### 5. Star Rating Takes Too Much Width
5 stars × 32px = 160px + 20px gaps = 180px for overall stars. Label "Rating" adds 50px min-width.

**Recommendation:** Use smaller stars (24px) consistently. Or use numeric rating with single star.

#### 6. Photo Grid Label Redundant
"Place Photos (ambiance, etc.)" takes full line. Photo grid is self-explanatory.

**Recommendation:** Remove label or make it a placeholder inside empty photo slot.

#### 7. Dish Remove Button Always Visible
Red × button on every dish card is distracting. Most users add dishes, don't remove.

**Recommendation:** Hide behind swipe gesture or overflow menu. Or show only on focus/hover.

#### 8. Textarea Placeholders Too Long
- Dish: "Any thoughts on this dish?"
- Overall: "How was the overall experience?"

Verbose for small inputs.

**Recommendation:** Shorter: "Notes on dish" / "Overall notes"

#### 9. No Visual Distinction New vs Edit Mode
Save button says "Save Review" vs "Update Review" but rest of UI is identical. User may not realize they're editing existing review.

**Recommendation:** Show existing review data differently (read-only until tap to edit, or subtle highlight).

### Low Priority

#### 10. Drag Handle Takes Space
`⠿` icon with 4px padding on every dish card. Only useful if 2+ dishes.

**Recommendation:** Hide drag handle for single dish. Or use touch-and-hold gesture instead.

#### 11. Sheet Animation
`slideUp 0.25s` is generic. No custom feel.

**Recommendation:** Spring animation for more playful feel (matches bot personality).

#### 12. Price Rating Labels
Price icons go from 1-4 but labels like "Budget" / "Moderate" / "Expensive" / "Very Expensive" are hidden in code.

**Recommendation:** Show price label immediately on selection, not just in code.

---

## Proposed Redesign (Optional)

### Compact Card Layout
```
┌─────────────────────────────────────┐
│ [Dish Name............] ⭐⭐⭐⭐⭐ × │
│ [photo] [photo] [+]  "Great taste"  │
└─────────────────────────────────────┘
```

- Name and stars on same row
- Photos and remarks on second row (truncated)
- Tap to expand full editor

### Overall Quick Rating
```
┌─────────────────────────────────────┐
│ Overall  ⭐⭐⭐⭐⭐   $$$$          │
│ [photo] [photo] [photo] [+]        │
│ [Notes..........................] │
└─────────────────────────────────────┘
```

- Rating and price on same row
- Photos below
- Notes below

### Compact Header
```
┌─────────────────────────────────────┐
│           Review              [×]   │
│        Coffee Shop Name             │
└─────────────────────────────────────┘
```

- Just close button in header
- Place name as subtitle
- Share in footer or save confirmation

---

## Priority Fixes

If time-constrained, focus on:

1. **Flip order** - Overall section first
2. **Compact dish cards** - Collapsible or single-row summary
3. **Clean header** - Remove redundancy
4. **Same-row layout** - Rating + Price together

## Files to Modify

- `webapp/index.html` - Review sheet structure
- `webapp/styles.css` - Layout, spacing, sizes
- `webapp/app.js` - openReviewSheet, createDishCard, populateReview logic
