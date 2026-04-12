---
phase: 10-reviews
plan: 01
subsystem: database, api
tags: [reviews, database, api, photos]

requires:
  - phase: 09-01
    provides: Complete Phase 9 (Documentation)
provides:
  - Review, ReviewDish, ReviewPhoto, ReviewReminder models
  - Repository methods for full review CRUD
  - API endpoints for reviews and photos
affects: []

tech-stack:
  added: [python-multipart, httpx]
  patterns: [One-to-many relationships with cascade delete, Photo limits enforcement]

key-files:
  created: []
  modified: [database/models.py, database/repository.py, api/routes.py, requirements.txt]

key-decisions:
  - "One review per place (unique constraint)"
  - "Photo limits: 2 per dish, 3 overall"
  - "Placeholder Telegram file_id for MVP (full integration in later plan)"
  - "user_id hardcoded to 1 for single-user bot"

patterns-established:
  - "Review models with eager loading via joinedload"
  - "Photo count checking before add"

issues-created: []

duration: 8min
completed: 2026-04-13
---

# Phase 10 Plan 01: Database & API Foundation Summary

**Review data layer and REST API established for the reviews feature**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-13
- **Completed:** 2026-04-13
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

### Task 1: Database Models

Created four new SQLAlchemy models in `database/models.py`:

- **Review**: Overall rating (1-5), price rating (1-5), remarks, timestamps
- **ReviewDish**: Dish name, rating (1-5), remarks, timestamps
- **ReviewPhoto**: Telegram file_id, optional dish_id (null = overall photo), sort order
- **ReviewReminder**: Track visited_at, reminder_sent, dont_ask_again flags

Relationships:
- Place has one Review (one-to-one, cascade delete)
- Review has many ReviewDish (one-to-many, cascade delete)
- Review has many ReviewPhoto (one-to-many, cascade delete)
- ReviewDish has many ReviewPhoto (one-to-many, cascade delete)

### Task 2: Repository Methods

Added comprehensive CRUD methods to `database/repository.py`:

**Review operations:**
- `get_review(place_id)` - Eager loads dishes and photos
- `create_or_update_review(...)` - Handles dish add/update/delete
- `delete_review(place_id)` - Cascades to all related data

**Dish operations:**
- `add_dish()`, `update_dish()`, `delete_dish()`

**Photo operations:**
- `add_photo()` - Enforces limits (2 per dish, 3 overall)
- `delete_photo()`, `get_photo_count()`

**User operations:**
- `get_all_reviews(user_id)` - For "My Reviews" list

**Reminder operations:**
- `create_reminder()`, `get_pending_reminders()`
- `mark_reminder_sent()`, `set_dont_ask_again()`

### Task 3: API Endpoints

Added REST endpoints to `api/routes.py`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/places/{id}/review` | Get review with dishes and photos |
| POST | `/api/places/{id}/review` | Create or update review |
| DELETE | `/api/places/{id}/review` | Delete review |
| GET | `/api/reviews` | Get all user's reviews |
| POST | `/api/reviews/{id}/photos` | Upload photo |
| DELETE | `/api/reviews/{id}/photos/{photo_id}` | Delete photo |

Added Pydantic models:
- `ReviewRequest`, `ReviewResponse`
- `DishRequest`, `DishResponse`
- `PhotoResponse`

## Dependencies Added

- `python-multipart>=0.0.6` - For file upload handling
- `httpx>=0.26.0` - For async HTTP requests to Telegram API

## Files Modified

- `database/models.py` - Added Review, ReviewDish, ReviewPhoto, ReviewReminder models
- `database/repository.py` - Added review/dish/photo/reminder CRUD methods
- `api/routes.py` - Added review endpoints and Pydantic models
- `requirements.txt` - Added python-multipart, httpx

## Decisions Made

- One review per place enforced via unique constraint
- Photo limits: 2 per dish, 3 overall (per PLAN.md spec)
- user_id hardcoded to 1 (single-user bot)
- Placeholder Telegram file_id for MVP; full integration deferred

## Deviations from Plan

- Photo upload uses placeholder file_id instead of actual Telegram API call
  (Real integration requires user's chat_id, will be done in bot flow plan)

## Issues Encountered

None

## Verification

- [x] All four models created in database/models.py
- [x] Models have proper relationships and foreign keys
- [x] Repository methods handle all CRUD operations
- [x] API endpoints work for get/create/update/delete reviews
- [x] Photo limits enforced (2 per dish, 3 overall)
- [x] Ratings validated to 1-5 range
- [x] Existing tests still pass (56/57, 1 pre-existing failure)

## Ready for Next Plan

10-02: Mini App Review UI
- Review bottom sheet component
- Star rating and price rating components
- Dish list with add/remove/edit
- Photo upload/display grid

---
*Phase: 10-reviews*
*Plan: 01 of 5*
*Completed: 2026-04-13*
