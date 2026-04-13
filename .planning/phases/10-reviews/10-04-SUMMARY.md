---
phase: 10-reviews
plan: 04
subsystem: bot
tags: [reviews, conversation, telegram, state-machine]

requires:
  - phase: 10-01
    provides: Review database models and repository methods
provides:
  - Multi-turn conversation state machine for reviews
  - Dish collection with ratings and remarks
  - Overall and price rating collection
  - Review save via repository
affects: [bot/handlers.py, bot/main.py]

tech-stack:
  added: []
  patterns: [ConversationHandler state machine, user_data context storage]

key-files:
  created: []
  modified: [bot/handlers.py, bot/main.py]

key-decisions:
  - "ConversationHandler with 6 states for review flow"
  - "Entry via CallbackQueryHandler with 'review:' prefix"
  - "Dish input loop: name -> rating -> remarks -> repeat or done"
  - "/cancel fallback to exit conversation"
  - "user_data for temporary review context during conversation"

patterns-established:
  - "Review conversation state machine (REVIEW_DISH_NAME through REVIEW_OVERALL_REMARKS)"
  - "clear_review_context() for cleanup"
  - "build_review_summary() for formatted output"

issues-created: []

duration: 8min
completed: 2026-04-13
---

# Phase 10 Plan 04: Bot Conversation Flow Summary

**Multi-turn conversation handler for writing reviews through Telegram chat**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-13
- **Completed:** 2026-04-13
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments

### Task 1: Review Conversation State Machine

Added conversation states in `bot/handlers.py`:
```python
REVIEW_DISH_NAME = 100
REVIEW_DISH_RATING = 101
REVIEW_DISH_REMARKS = 102
REVIEW_OVERALL_RATING = 103
REVIEW_PRICE_RATING = 104
REVIEW_OVERALL_REMARKS = 105
```

Added context storage documentation:
- `review_place_id` - ID of place being reviewed
- `review_place_name` - Name for display
- `review_dishes` - List of collected dishes
- `review_current_dish` - Current dish being entered
- `review_overall` - Overall rating (1-5)
- `review_price` - Price rating (1-5)
- `review_remarks` - Final thoughts

Added dish collection handlers:
- `review_dish_name()` - Accept dish name or "done"
- `review_dish_rating()` - Accept 1-5 rating, validate
- `review_dish_remarks()` - Accept remarks or "skip"

### Task 2: Overall Ratings and Save Flow

Added rating handlers:
- `review_overall_rating()` - Overall experience rating (1-5)
- `review_price_rating()` - Price level (1-5) with labels
- `review_overall_remarks()` - Final thoughts, then save

Added helper functions:
- `PRICE_LABELS` - ['', 'Budget-friendly', 'Affordable', 'Moderate', 'Pricey', 'Splurge']
- `clear_review_context()` - Clean up user_data after review
- `build_review_summary()` - Format review for display
- `cancel_review()` - Handle /cancel command

Save flow:
- Calls `repository.create_or_update_review()` with collected data
- Displays formatted summary with stars and money bags
- Shows "View & edit anytime in the Mini App!" message

### Task 3: Register Conversation Handler

Created ConversationHandler:
- Entry point: `CallbackQueryHandler` with pattern `r'^review:'`
- 6 states with MessageHandler for text input
- Fallback: `/cancel` command
- Settings: `per_chat=True, per_user=True`

Added callback handler:
- `handle_review_callback()` - Handles "Write Review" button
- Parses callback data format: `review:place_id:place_name`
- Initializes review context and enters conversation

Updated `bot/main.py`:
- Imported `review_conversation_handler`
- Added handler before generic text handler

## Conversation Flow

```
User taps "Write Review" button
    -> Bot: "What did you order? (type dish name, or 'done')"

User: "Chicken Rice"
    -> Bot: "Chicken Rice - Rating? (1-5 stars)"

User: "4"
    -> Bot: "⭐⭐⭐⭐☆ Nice! Any quick note? (or 'skip')"

User: "Really fragrant rice"
    -> Bot: "Got it! Another dish? (or 'done')"

User: "done"
    -> Bot: "How would you rate [Place] overall? (1-5)"

User: "4"
    -> Bot: "⭐⭐⭐⭐ And how's the pricing? (1-5)"

User: "2"
    -> Bot: "💰💰 Affordable. Any final thoughts? (or 'skip')"

User: "Great value for money"
    -> Bot: "Review saved! 🎉 [summary]"
```

## Files Modified

- `bot/handlers.py` - Added ~180 lines for conversation handler
- `bot/main.py` - Added import and handler registration

## Verification

- [x] Conversation states defined (100-105)
- [x] Dish name handler accepts input or "done"
- [x] Dish rating validates 1-5
- [x] Dish remarks accepts or skips
- [x] Can add multiple dishes before "done"
- [x] Overall rating validates 1-5
- [x] Price rating shows labels
- [x] Overall remarks accepts or skips
- [x] Review saved to database via repository
- [x] Summary displayed with formatted output
- [x] /cancel stops conversation
- [x] Context cleared after completion
- [x] Python syntax valid

## Ready for Next Plan

10-05: Reminder System
- Review reminder after marking visited
- 1-hour delay before prompting
- "Don't ask again" option
- Scheduled reminder checks

---
*Phase: 10-reviews*
*Plan: 04 of 5*
*Completed: 2026-04-13*
