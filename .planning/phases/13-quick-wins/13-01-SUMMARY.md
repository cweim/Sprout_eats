---
phase: 13-quick-wins
plan: 01
status: complete
started: 2026-04-17
completed: 2026-04-17
---

# Summary: Copy and Feedback Improvements

## Completed

### Task 1: Personalize success messages in webapp
Updated success toasts to include place names:
- Visited toggle: "✓ Marked {name} as visited!" / "Unmarked {name}"
- Notes saved: "Notes saved for {name}!"
- Delete place: "Bye bye {name}! 👋"

### Task 2: Improve placeholder and hint text
Updated all placeholder text to be more engaging:
- Notes textarea: "What did you think? Any must-try dishes?"
- Search input: "Search by name..."
- Overall remarks: "How was the overall experience?"
- Dish name: "What did you order?"
- Dish notes: "Any thoughts on this dish?"

### Task 3: Add consistent time formatting
Updated review sheet "Edited" timestamp to use `formatTimeAgo()` for consistency with review card timestamps. Now shows relative format (Today, Yesterday, X days ago) instead of locale date string.

## Verification

- [x] Success messages include place names
- [x] Placeholder text more engaging
- [x] No broken messages or missing interpolations
- [x] Time formatting consistent (uses formatTimeAgo)

## Commits

1. `feat(13-01): personalize success messages with place names`
2. `feat(13-01): improve placeholder text for better UX`
3. `feat(13-01): use consistent relative time formatting`
