# Phase 10: Place Reviews Feature

## Overview

Add a simple food review system that lets users rate dishes and places they've visited. Reviews are personal, editable, and include photos. The flow should feel natural and non-intrusive, with multiple entry points (Mini App and Bot).

---

## Key Decisions

| Decision | Choice |
|----------|--------|
| Dish rating | **Required** (1-5 stars) |
| Dish remarks | Optional |
| Reviews per place | **One**, editable |
| Edit tracking | Show last edited timestamp per dish/comment |
| Photos | Yes, per review (not per dish) |
| Price rating | Yes, overall (1-5, like $-$$$$$) |
| Overall remarks | Optional |

---

## User Journey

### Flow 1: Immediate Review (Mini App)
```
User marks place as visited
    ↓
Toast appears: "Visited! Want to leave a review?"
    ↓
[Review Now] or [Maybe Later] or dismiss
    ↓
If Review Now → Opens review sheet
```

### Flow 2: Delayed Reminder (Bot)
```
User marks place as visited (no review)
    ↓
1 hour later, bot sends message:
"Hey! How was [Place Name]? 🍜"
    ↓
[Write Review] [Ask Later] [Don't Ask]
    ↓
If Write Review → Conversational flow OR link to Mini App
```

### Flow 3: Edit Review (Mini App)
```
User views a visited place with existing review
    ↓
Sees their review with "last edited" timestamps
    ↓
Can edit any part (dishes, ratings, photos, remarks)
```

---

## Review Data Model

```
Review
├── overall_rating: 1-5 ⭐ (required)
├── price_rating: 1-5 💰 (required)
├── overall_remarks: text (optional)
├── overall_photos: [photo, ...] (optional, max 3)  ← Ambiance, exterior, etc.
├── created_at: timestamp
├── updated_at: timestamp
│
└── dishes: [
      {
        name: "Orange Wine" (required)
        rating: 4 ⭐ (required)
        remarks: "Try the natural one" (optional)
        photos: [photo, ...] (optional, max 2 per dish)  ← Food photos
        updated_at: timestamp
      },
      ...
    ]
```

### Photo Tagging
- **Dish photos**: Tagged to specific dish (food shots)
- **Overall photos**: Not tagged to any dish (ambiance, exterior, menu, etc.)
- Max **2 photos per dish**, max **3 overall photos**
- Total max ~10 photos per review (reasonable limit)

---

## UI Design: Review Sheet (Bottom Sheet)

### Full Review Form

```
┌─────────────────────────────────────┐
│ ═══════════ (drag handle)           │
│                                     │
│ 📝 Review: Le Bon Funk              │
│                                     │
│ ═══ DISHES ═══════════════════════  │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ Orange Wine                     │ │
│ │ ⭐⭐⭐⭐☆  (tap to rate)         │ │
│ │                                 │ │
│ │ ┌─────┐ ┌─────┐                │ │
│ │ │ 📷  │ │  +  │  ← dish photos │ │
│ │ └─────┘ └─────┘                │ │
│ │                                 │ │
│ │ ┌─────────────────────────────┐ │ │
│ │ │ Add a note... (optional)    │ │ │
│ │ └─────────────────────────────┘ │ │
│ │ edited 2 days ago        [🗑️]  │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ Cheese Board                    │ │
│ │ ⭐⭐⭐⭐⭐                        │ │
│ │                                 │ │
│ │ ┌─────┐ ┌─────┐                │ │
│ │ │ 📷  │ │ 📷  │  2 photos      │ │
│ │ └─────┘ └─────┘                │ │
│ │                                 │ │
│ │ "Amazing selection!"            │ │
│ │ edited just now          [🗑️]  │ │
│ └─────────────────────────────────┘ │
│                                     │
│      [+ Add another dish]           │
│                                     │
│ ═══ OVERALL ══════════════════════  │
│                                     │
│ Rating      ⭐⭐⭐⭐☆               │
│ Price       💰💰💰 (moderate)       │
│                                     │
│ ── Place Photos (ambiance, etc.) ── │
│ ┌─────┐ ┌─────┐ ┌─────┐            │
│ │ 📷  │ │  +  │ │     │  max 3    │
│ └─────┘ └─────┘ └─────┘            │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ Overall thoughts... (optional)  │ │
│ │ "Great vibe, will come back"    │ │
│ └─────────────────────────────────┘ │
│ edited 2 hours ago                  │
│                                     │
│         [ 💾 Save Review ]          │
│                                     │
└─────────────────────────────────────┘
```

### Price Rating Scale

| Rating | Display | Meaning |
|--------|---------|---------|
| 1 | 💰 | Budget-friendly |
| 2 | 💰💰 | Affordable |
| 3 | 💰💰💰 | Moderate |
| 4 | 💰💰💰💰 | Pricey |
| 5 | 💰💰💰💰💰 | Splurge |

### Compact Review Display (in Place Card/Popup)

```
┌─────────────────────────────────┐
│ Your Review                     │
│ ⭐⭐⭐⭐ · 💰💰💰               │
│                                 │
│ • Orange Wine ⭐⭐⭐⭐           │
│   ┌────┐                       │
│   │ 📷 │                       │
│   └────┘                       │
│ • Cheese Board ⭐⭐⭐⭐⭐         │
│   ┌────┐ ┌────┐                │
│   │ 📷 │ │ 📷 │                │
│   └────┘ └────┘                │
│                                 │
│ "Great vibe, will come back"   │
│ ┌────┐                         │
│ │ 📷 │ ambiance                │
│ └────┘                         │
│                                 │
│ edited 2 hours ago             │
│           [✏️ Edit Review]      │
└─────────────────────────────────┘
```

---

## Photos Implementation

### Storage Options

| Option | Pros | Cons |
|--------|------|------|
| **Telegram File IDs** | Free, native | Only works in Telegram context |
| **Cloud Storage (S3/GCS)** | Universal, CDN | Cost, complexity |
| **Base64 in DB** | Simple | DB bloat, slow |
| **Local filesystem** | Simple | Not scalable |

**Recommendation**: Use **Telegram File IDs** for v1
- When user uploads photo in Mini App, send to bot via Telegram API
- Store the file_id returned by Telegram
- Display using Telegram's getFile API
- Limitation: Photos only viewable within Telegram (fine for Mini App)

### Photo Flow (Mini App)

```
User taps [+ Add Photo] on a dish (or overall section)
    ↓
Native file picker opens (or camera)
    ↓
Photo compressed client-side (max 1MB)
    ↓
Upload to API with dish_id (or null for overall)
    ↓
API sends to Telegram Bot API
    ↓
Telegram returns file_id
    ↓
Store file_id + dish_id in review_photos table
    ↓
Display using Telegram CDN URL
```

### Photo Limits
- **Per dish**: Max 2 photos (food shots)
- **Overall**: Max 3 photos (ambiance, exterior, menu)
- Max 1MB per photo (compress on upload)
- Supported formats: JPEG, PNG, WebP

---

## Database Schema

### Table: `reviews`
```sql
CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    place_id INTEGER NOT NULL UNIQUE,  -- One review per place
    user_id INTEGER NOT NULL,
    overall_rating INTEGER NOT NULL,   -- 1-5
    price_rating INTEGER NOT NULL,     -- 1-5
    overall_remarks TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (place_id) REFERENCES places(id) ON DELETE CASCADE
);
```

### Table: `review_dishes`
```sql
CREATE TABLE review_dishes (
    id INTEGER PRIMARY KEY,
    review_id INTEGER NOT NULL,
    dish_name TEXT NOT NULL,
    rating INTEGER NOT NULL,           -- 1-5 (required)
    remarks TEXT,                      -- optional
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
);
```

### Table: `review_photos`
```sql
CREATE TABLE review_photos (
    id INTEGER PRIMARY KEY,
    review_id INTEGER NOT NULL,
    dish_id INTEGER,                   -- NULL = overall photo, else tagged to dish
    telegram_file_id TEXT NOT NULL,
    file_url TEXT,                     -- Cached CDN URL
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
    FOREIGN KEY (dish_id) REFERENCES review_dishes(id) ON DELETE CASCADE
);
```

### Photo Limits
- **Per dish**: Max 2 photos
- **Overall (no dish tag)**: Max 3 photos
- **Total per review**: ~10-15 photos max

### Table: `review_reminders`
```sql
CREATE TABLE review_reminders (
    id INTEGER PRIMARY KEY,
    place_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    visited_at TIMESTAMP NOT NULL,
    reminder_sent BOOLEAN DEFAULT FALSE,
    dont_ask_again BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (place_id) REFERENCES places(id) ON DELETE CASCADE
);
```

---

## API Endpoints

### Reviews
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/places/{id}/review` | Get review for a place |
| POST | `/api/places/{id}/review` | Create/update review |
| DELETE | `/api/places/{id}/review` | Delete review |
| GET | `/api/reviews` | Get all user's reviews |
| POST | `/api/reviews/{id}/photos` | Upload photo |
| DELETE | `/api/reviews/{id}/photos/{photo_id}` | Delete photo |

### Review Request Schema
```json
{
  "overall_rating": 4,
  "price_rating": 3,
  "overall_remarks": "Great vibe, will come back",
  "dishes": [
    {
      "id": 1,  // null for new dish
      "name": "Orange Wine",
      "rating": 4,
      "remarks": "Try the natural one"
    },
    {
      "name": "Cheese Board",
      "rating": 5,
      "remarks": null
    }
  ]
}
```

### Review Response Schema
```json
{
  "id": 1,
  "place_id": 10,
  "overall_rating": 4,
  "price_rating": 3,
  "overall_remarks": "Great vibe, will come back",
  "updated_at": "2026-04-11T14:30:00Z",
  "dishes": [
    {
      "id": 1,
      "name": "Orange Wine",
      "rating": 4,
      "remarks": "Try the natural one",
      "updated_at": "2026-04-11T14:30:00Z",
      "photos": [
        { "id": 1, "url": "https://..." }
      ]
    },
    {
      "id": 2,
      "name": "Cheese Board",
      "rating": 5,
      "remarks": null,
      "updated_at": "2026-04-11T12:00:00Z",
      "photos": [
        { "id": 2, "url": "https://..." },
        { "id": 3, "url": "https://..." }
      ]
    }
  ],
  "overall_photos": [
    {
      "id": 4,
      "url": "https://...",
      "sort_order": 0
    }
  ]
}
```

---

## Bot Conversation Flow

### Conversational Review (Updated)
```
Bot: Great! Let's review Le Bon Funk 📝

     What did you order? (type dish name, or "done" when finished)

User: Orange wine

Bot: Orange wine 🍷 - Rating? (1-5 stars)

User: 4

Bot: ⭐⭐⭐⭐ Nice! Any quick note about it? (or "skip")

User: Try the natural one

Bot: Got it! Another dish? (or "done")

User: Cheese board

Bot: Cheese board 🧀 - Rating?

User: 5

Bot: ⭐⭐⭐⭐⭐ Any note? (or "skip")

User: skip

Bot: Another dish? (or "done")

User: done

Bot: Now for the overall...

     How would you rate Le Bon Funk overall? (1-5)

User: 4

Bot: ⭐⭐⭐⭐ And how's the pricing? (1-5, where 1=budget, 5=splurge)

User: 3

Bot: 💰💰💰 Moderate. Any final thoughts? (or "skip")

User: Great vibe, will come back

Bot: Perfect! Want to add photos? Send them now, or "done" to finish.

User: done

Bot: Review saved! 🎉

     Le Bon Funk
     ⭐⭐⭐⭐ · 💰💰💰

     • Orange Wine ⭐⭐⭐⭐
       "Try the natural one"
     • Cheese Board ⭐⭐⭐⭐⭐

     "Great vibe, will come back"

     View & edit anytime in the Mini App! ✨
```

---

## Implementation Plan

### Plan 10-01: Database & API Foundation
1. Create database tables (reviews, review_dishes, review_photos, review_reminders)
2. Add repository methods for CRUD
3. Add API endpoints for reviews
4. Add photo upload endpoint (Telegram file_id flow)
5. Add migration script for existing DBs

### Plan 10-02: Mini App Review UI
1. Add "My Review" button to visited place cards/popups
2. Create review bottom sheet component
3. Implement dish list with add/remove/edit
4. Add star rating component (tap to rate)
5. Add price rating component (💰 icons)
6. Add photo upload/display grid
7. Show "edited X ago" timestamps
8. Implement save/delete functionality

### Plan 10-03: Bot Review Flow
1. Add review prompt after marking visited
2. Implement multi-turn conversation state machine
3. Handle dish collection with ratings and remarks
4. Handle photo uploads in conversation
5. Connect to review API

### Plan 10-04: Reminder System
1. Track visited_at timestamps
2. Background task to check for pending reminders (1 hour)
3. Send reminder message with inline buttons
4. Handle "remind later" (reschedule) and "don't ask" (flag)
5. Use APScheduler or python-telegram-bot's JobQueue

---

## UI Component Specs

### Star Rating Component
- 5 tappable stars in a row
- Empty (☆) → Filled (⭐) on tap
- Tap a star to set that rating
- Required: must select at least 1 star

### Price Rating Component
- 5 tappable money bags (💰)
- Works like star rating
- Labels below: Budget → Splurge

### Photo Grid (Dish)
- 2 columns (smaller, inline with dish)
- Square thumbnails with rounded corners
- Last slot is [+ Add] if < 2 photos
- Tap photo to view full size / delete

### Photo Grid (Overall)
- 3 columns
- Square thumbnails with rounded corners
- Last slot is [+ Add] if < 3 photos
- Tap photo to view full size / delete
- Long press to reorder (v2)

### Timestamp Display
- "just now" (< 1 min)
- "X minutes ago" (< 1 hour)
- "X hours ago" (< 24 hours)
- "yesterday"
- "X days ago" (< 7 days)
- "Apr 11" (older)

---

## Success Criteria

- [ ] User can create review with dishes, ratings, remarks, photos
- [ ] Dish rating is required, remarks optional
- [ ] Price rating (1-5) captured
- [ ] Photos upload and display correctly (max 5)
- [ ] "Edited X ago" shows for each editable field
- [ ] One review per place, fully editable
- [ ] Review via bot conversation works
- [ ] Bot sends 1-hour reminder if no review
- [ ] User can opt out of reminders
- [ ] UI matches existing warm/playful style

---

## Estimated Effort

| Plan | Scope | Complexity |
|------|-------|------------|
| 10-01 | Database & API | Medium |
| 10-02 | Mini App UI | High |
| 10-03 | Bot Flow | Medium-High |
| 10-04 | Reminders | Medium |

Total: 4 plans for Phase 10

---

## Future Enhancements (v2)

- [ ] Photo reordering (drag & drop)
- [ ] Would recommend toggle
- [ ] Favorite dishes highlight
- [ ] Review history (see past edits)
- [ ] Share review as image
- [ ] Export reviews to PDF
