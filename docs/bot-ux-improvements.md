# Bot UX Improvements — Design & Implementation Plan

## Overview

The bot's core job should be: **receive link → extract place → confirm save → open Mini App.**
Everything else belongs in the Mini App. This document covers 12 UX issues with detailed improvement specs and a phased implementation plan.

---

## Issue 1 — Review Flow Is Too Long

### Problem
The current bot review is a 6-step conversation: dish name → dish rating → dish remarks → overall rating → price rating → overall remarks. Users drop off mid-conversation. Each step requires a separate message, making the flow feel like a form. The Mini App already has a better review UI.

### Improvement
Kill the bot review conversation entirely. Replace every entry point that launches the review conversation with a single message + Mini App deep link button.

The bot's only job in the review context:
- Send a prompt: *"How was [Place]? Tap below to write your review."*
- Button: **Write Review →** (opens Mini App to the review sheet for that place)

### Implementation
1. **Remove** `review_conversation_handler` from `bot/main.py` dispatcher
2. **Remove** all review conversation states (`REVIEW_DISH_NAME`, `REVIEW_DISH_RATING`, etc.) and their handlers from `bot/handlers.py`
3. **Replace** `handle_review_callback()` with a simple handler that sends a Mini App deep link:
   ```python
   webapp_url = f"{config.WEBAPP_URL}?startapp=review_{place_id}"
   button = InlineKeyboardButton("Write Review →", web_app=WebAppInfo(url=webapp_url))
   ```
4. **Update** review reminder messages to use the same Mini App button instead of launching bot conversation
5. **Add** `startapp` parameter handling in the Mini App JS to auto-open the review sheet for `review_{place_id}`

### Files
- `bot/handlers.py` — remove ~300 lines of review conversation code
- `bot/main.py` — remove `review_conversation_handler` registration
- `webapp/app.js` — handle `startapp` Telegram WebApp launch param

---

## Issue 2 — Duplicate Functionality (Bot vs Mini App)

### Problem
`/places`, `/map`, `/nearby`, `/delete`, `/clear` all duplicate what the Mini App does, but worse. Having two interfaces for the same thing confuses users about where the authoritative UI is.

### Improvement
Deprecate these commands gracefully — don't remove them hard (users may have muscle memory), but redirect to the Mini App with a helpful message.

| Command | New Behavior |
|---------|-------------|
| `/places` | "See all your places in the map →" [Open Mini App] |
| `/map` | "Your interactive map is in the app →" [Open Mini App] |
| `/nearby` | Keep — useful quick Telegram-native experience, but add "See on map →" button at the end |
| `/delete` | "Delete places from the list in the app →" [Open Mini App] |
| `/clear` | Keep confirmation flow but add warning; or redirect to app |

`/nearby` is worth keeping because it works entirely within Telegram (user shares location → bot replies with distances) with no app-switching needed. Enhance it rather than kill it.

### Implementation
1. Replace `/places`, `/map`, `/delete`, `/clear` handlers with one-liner redirect messages + Mini App button
2. Enhance `/nearby` — after showing nearby places, add a row of place-specific buttons: **View on Map** that deep-links to the Mini App with the place highlighted
3. Update bot command menu to remove deprecated commands or mark them clearly

### Files
- `bot/handlers.py` — rewrite `places_command`, `map_command`, `delete_command`, `clear_command`
- `bot/main.py` — update `set_my_commands()` list

---

## Issue 3 — Photo Limit Inconsistency

### Problem
Bot review photo flow caps at 3 photos. Mini App now supports 10. Users who add photos via bot hit the old limit and get confused why they can't add more.

### Improvement
Since we're killing the bot review conversation (Issue 1), the photo upload flow in the bot also goes away. Users add photos via the Mini App which already enforces 10.

If the bot photo flow is kept for any reason: update the limit constant.

### Implementation
1. If Issue 1 is implemented: no action needed — bot photo upload is removed with the review conversation
2. If bot photo upload is kept:
   - Find `max_photos` constant in `bot/handlers.py` and update to `10`
   - Update the "you can add up to X photos" user-facing message

### Files
- `bot/handlers.py` — `handle_review_photo_upload()`, search for `max_photos` or `3`

---

## Issue 4 — State Lost on Bot Restart

### Problem
All pending state (place selections, review flow, correction context) lives in `context.user_data` which is in-memory. Bot restart = all state gone. Users mid-flow see "search expired" with no explanation.

### Improvement
Two-part fix:

**A) Persist critical state to DB or Redis**
Use Supabase to store pending place selections. When user taps a toggle button, the state is read from DB, not memory. Lightweight table: `bot_pending_sessions (user_id, session_type, payload jsonb, expires_at)`.

**B) Better expired-state messages**
When state is missing, don't say "search expired" — say something actionable:
- *"That session timed out — just resend the link and I'll try again."*
- Include the original URL if available in the callback data.

### Implementation
1. Create `bot_pending_sessions` table in Supabase:
   ```sql
   CREATE TABLE bot_pending_sessions (
     user_id BIGINT NOT NULL,
     session_type TEXT NOT NULL,  -- 'place_selection', 'correction', etc.
     payload JSONB NOT NULL,
     created_at TIMESTAMPTZ DEFAULT NOW(),
     expires_at TIMESTAMPTZ NOT NULL,
     PRIMARY KEY (user_id, session_type)
   );
   ```
2. Add `database/supabase_repository.py` functions: `save_bot_session()`, `get_bot_session()`, `delete_bot_session()`
3. Replace `context.user_data` reads/writes for `pending_places` and `selected_indices` with DB calls
4. Update all "expired" fallback messages to be more actionable
5. Add cleanup job: delete sessions older than 24h

### Files
- `database/supabase_repository.py` — new session functions
- `bot/handlers.py` — replace user_data access for place selection state
- Supabase migrations

---

## Issue 5 — Correction Flow Is Clunky

### Problem
Current correction: tap "This is incorrect" → bot deletes place → asks for name → user types → searches → saves. That's 4 round trips. A user who just misidentified a restaurant has to retype the name from scratch.

### Improvement
When a place is auto-saved, store the top 3 candidate matches (not just the winner). The "This is incorrect" button opens an inline selection of the alternatives:

```
❌ That wasn't right. Here are other matches I found:

⬜ Pasta Bar Roma — 123 Main St ⭐4.3
⬜ Pasta House — 456 Side St ⭐4.1
⬜ None of these — search manually
```

User taps the right one — done in 1 tap. Only if they tap "None of these" do they need to type.

### Implementation
1. Store top 3 `candidates` from `PlaceSlotSuggestion` when auto-saving a single place (currently only the winner is stored)
2. Add `place_correction_candidates` to the save response / bot session
3. Replace `incorrect_place_callback` — instead of deleting immediately and asking for name, fetch stored candidates and render as inline buttons
4. New callback pattern: `correction_pick_{place_id}_{candidate_index}`
5. Only delete the wrong place and save the correct one when user picks a candidate

### Files
- `bot/handlers.py` — `incorrect_place_callback()`, new `correction_pick_callback()`
- `database/supabase_repository.py` — store candidates alongside saved place (or in bot session)

---

## Issue 6 — Multi-Place Selection Is Confusing

### Problem
The checkbox UI (☑️/⬜) with pre-selected items and confidence labels is non-obvious. "High confidence" and "Likely match" mean nothing to regular users. Pre-checked items imply the bot already made decisions — but then why show the UI?

### Improvement
Simplify the mental model:

**Before:** "Found 3 places. High-confidence are pre-selected. Toggle to adjust."

**After:** "Found 3 places from this video — save them all?"

```
1. Restaurant A — Orchard Rd ⭐4.5
2. Cafe B — Clarke Quay ⭐4.2
3. Bar C — Marina Bay ⭐4.0

[✅ Save All 3]   [Choose which ones]
```

"Save All" = one tap, done. "Choose which ones" = shows the toggle UI for users who want control. This reduces friction for the happy path (most users trust the bot's picks) while keeping the power-user flow.

### Implementation
1. Add a "Save All" button to the multi-place message as the primary CTA
2. Demote the toggle UI to a secondary action ("Choose which ones")
3. Remove confidence labels from the selection UI (keep them in logs/debug only)
4. Replace "High confidence · Restaurant · ⭐4.5/5" with just "Restaurant · ⭐4.5/5 · Orchard Rd"
5. Rename "💾 Save Chosen (N)" → "✅ Save Selected (N)"

### Files
- `bot/handlers.py` — `build_place_selection_message()` (or equivalent), `save_selected_callback()`

---

## Issue 7 — No "View on Map" After Saving

### Problem
After saving a place, the confirmation message shows the details but no way to jump straight to it on the map. Users have to manually open the Mini App and find it.

### Improvement
Every save confirmation — single save, multi-save, manual save — gets a **View on Map →** button that opens the Mini App with the map centered on that place.

For multi-saves: button opens the Mini App to the map view (shows all new pins).

### Implementation
1. After single save, append button:
   ```python
   url = f"{config.WEBAPP_URL}?startapp=place_{place_id}"
   button = InlineKeyboardButton("🗺️ View on Map →", web_app=WebAppInfo(url=url))
   ```
2. After multi-save, append button:
   ```python
   url = f"{config.WEBAPP_URL}"  # Just open the app, markers will be visible
   button = InlineKeyboardButton("🗺️ Open Map →", web_app=WebAppInfo(url=url))
   ```
3. In Mini App: handle `startapp=place_{id}` param — pan map to that place and open its popup

### Files
- `bot/handlers.py` — all save confirmation sections
- `webapp/app.js` — handle `startapp` Telegram launch param

---

## Issue 8 — Instagram Error Messages Are Too Technical

### Problem
Messages like "Instagram processing is busy right now. I've queued your request and will process it shortly." are confusing. "Queued" is a developer term. Users don't know when to expect a result or what to do next.

### Improvement
Replace all technical error messages with plain-English ones that give a clear next action:

| Current | Improved |
|---------|----------|
| "Instagram processing is busy right now. I've queued your request..." | "Having trouble reading this post right now. If you know the place name, just type it and I'll find it." |
| "Instagram is blocking access to this post right now." | "Can't access this post — Instagram may have it set to private. Type the place name and I'll search for it." |
| "That video's too long! Max 20 minutes allowed." | "This video is too long to process. Try a shorter clip, or just type the place name." |
| "Hit a connection snag! Give it a moment and try again." | "Something went wrong on my end. Try again, or type the place name to search manually." |

### Implementation
1. Audit all `except` blocks in `bot/handlers.py` that send user-facing error messages
2. Replace with plain-English versions following the pattern: *what happened + what to do next*
3. Where a manual fallback is available, always include it as the suggested next step
4. Remove any mention of "queue", "cooldown", "rate limit", "processing"

### Files
- `bot/handlers.py` — all exception handlers that produce user messages

---

## Issue 9 — /start Is Weak for Returning Users

### Problem
Returning users see the same generic welcome as first-time users: "Hey there! 👋 Send me an Instagram Reel or TikTok link..." This wastes the interaction — a user with 20 saved places knows how the bot works.

### Improvement
Personalise /start based on user state:

**New user (0 places):**
```
Hey! 👋 I save food places from Instagram Reels and TikTok.

Send me a video link and I'll extract the restaurant/cafe and
pin it to your personal map. 🗺️

[🗺️ Open My Map]  [How it works]
```

**Returning user:**
```
Hey! 👋 You've saved 14 places.

📍 Last added: Pasta Bar, 3 days ago

[🗺️ Open My Map]  [📍 Find Places Near Me]
```

The "How it works" button for new users triggers a 3-message onboarding sequence (see Issue 10).

### Implementation
1. In `start_command()`, check place count AND fetch the most recently added place
2. Render different message templates based on `place_count == 0`
3. Add "How it works" callback for new users
4. Store `last_added_place` from a lightweight DB query (SELECT name, created_at ORDER BY created_at DESC LIMIT 1)

### Files
- `bot/handlers.py` — `start_command()`
- `database/supabase_repository.py` — `get_most_recent_place(user_id)`

---

## Issue 10 — No Onboarding Tour

### Problem
New users are told to "send a link" but discover nothing about reviews, nearby, or the Mini App unless they stumble across them. This hurts retention and feature adoption.

### Improvement
A 3-message onboarding flow triggered by "How it works" button (or auto-triggered on first /start):

**Message 1:**
```
🔗 Step 1 — Send a link
Paste any Instagram Reel or TikTok video that features a restaurant or cafe.
I'll extract the place and save it to your map automatically.
```

**Message 2:**
```
🗺️ Step 2 — Explore your map
Your saved places show up in an interactive map. Tap any pin to see details,
add notes, or get directions.

[Open My Map →]
```

**Message 3:**
```
⭐ Step 3 — Leave reviews
After visiting a place, write a quick review — rating, dishes, photos.
Find it in the Reviews tab.

Ready! Just send me a video link to get started. 🎬
```

Keep it skippable — don't force users through it if they just want to send a link.

### Implementation
1. Add `onboarding_shown` flag to user record in DB (or check place_count == 0 and first_seen)
2. Add `howto_callback` handler
3. Three sequential messages with `asyncio.sleep(0.5)` between them for pacing
4. "Skip" button on each step to jump to the end

### Files
- `bot/handlers.py` — new `howto_callback()`, update `start_command()`
- `database/supabase_repository.py` — optional `onboarding_shown` flag

---

## Issue 11 — No Cancel During Extraction

### Problem
Once a URL is sent, the user is locked out. A 30-second video download with no cancel option is a bad experience, especially if they sent the wrong link.

### Improvement
The status message (e.g. "Downloading video... 📥") should have a **Cancel** button. Tapping it aborts the extraction and sends a clean cancellation confirmation.

### Implementation
1. When sending the initial status message, attach an inline keyboard:
   ```python
   cancel_btn = InlineKeyboardButton("✕ Cancel", callback_data=f"cancel_extraction_{task_id}")
   ```
2. Use a `task_id` (UUID) stored in user_data to identify the running task
3. The extraction runs in an `asyncio.Task`. On cancel callback, call `task.cancel()`
4. Handle `asyncio.CancelledError` cleanly — delete the status message, send: *"Cancelled. Send another link anytime."*
5. Guard against race condition: if extraction finishes before user cancels, ignore the cancel callback

### Files
- `bot/handlers.py` — `handle_url()` (main URL handler), new `cancel_extraction_callback()`

---

## Issue 12 — Review Reminders Have No Mini App Deep Link

### Problem
Review reminder messages sent by the background job launch a bot conversation to collect the review. Now that the Mini App has a better review UI, this is the wrong destination.

### Improvement
Replace the "📝 Write Review" button (which starts bot conversation) with a Mini App button:

```
Hey! How was Pasta Bar? 🍜
Write your review while it's fresh.

[⭐ Write Review →]   [Ask Later]   [Don't Ask Again]
```

"Write Review →" opens the Mini App directly to that place's review sheet.

### Implementation
1. In the reminder job (`check_review_reminders`), replace `InlineKeyboardButton("📝 Write Review", callback_data=f"review:{place_id}:{place_name}")` with:
   ```python
   InlineKeyboardButton("⭐ Write Review →", web_app=WebAppInfo(url=f"{config.WEBAPP_URL}?startapp=review_{place_id}"))
   ```
2. Keep "Ask Later" and "Don't Ask Again" as regular callback buttons (no change needed)
3. In Mini App: `startapp=review_{place_id}` auto-opens the review sheet for that place (also needed for Issue 1 and 7)

### Files
- `bot/handlers.py` — `check_review_reminders()` or wherever reminder messages are built

---

## Implementation Plan

### Phase 1 — Quick Wins (1–2 days)
Low-risk changes, no new DB tables needed.

| # | Task | Issue |
|---|------|-------|
| 1.1 | Replace Instagram/generic error messages with plain English | #8 |
| 1.2 | Simplify multi-place selection (add "Save All" primary CTA) | #6 |
| 1.3 | Add "View on Map" button to all save confirmations | #7 |
| 1.4 | Redirect `/places`, `/map`, `/delete`, `/clear` to Mini App | #2 |
| 1.5 | Update photo limit in bot to 10 (or prep for removal) | #3 |

---

### Phase 2 — Core UX Fixes (3–5 days)
Bigger changes, some require Mini App coordination.

| # | Task | Issue |
|---|------|-------|
| 2.1 | Remove bot review conversation, replace with Mini App deep link | #1 |
| 2.2 | Update review reminders to use Mini App deep link | #12 |
| 2.3 | Add `startapp` param handling in Mini App JS | #1, #7, #12 |
| 2.4 | Improve /start for returning users (personalised message) | #9 |
| 2.5 | Improve correction flow — show candidate alternatives | #5 |

---

### Phase 3 — Polish & Retention (3–5 days)
Onboarding, cancel, state persistence.

| # | Task | Issue |
|---|------|-------|
| 3.1 | Add cancel button during extraction | #11 |
| 3.2 | Build 3-step onboarding tour for new users | #10 |
| 3.3 | Create `bot_pending_sessions` DB table | #4 |
| 3.4 | Migrate place selection state from user_data → DB | #4 |
| 3.5 | Improve expired-state fallback messages | #4 |

---

### Dependency Map

```
Issue 1 (remove review conv)
  └── requires Issue 12 (reminder deep link) — do together
  └── requires Issue 3 (photo limit) — already resolved by removal

Issue 7 (view on map button)
  └── requires startapp param in Mini App (shared with Issue 1)
  └── do Issues 1, 7, 12 Mini App work in one session

Issue 5 (correction flow)
  └── requires candidates to be stored at save time
  └── independent of other issues

Issue 4 (state persistence)
  └── requires new DB table
  └── do last — other fixes reduce the blast radius of state loss
```

---

### Out of Scope (Intentional)
- `/nearby` — keep as-is, it's genuinely useful Telegram-native
- `/feedback` — keep, it's low-friction and works well
- Complete bot rewrite — incremental improvement is lower risk
