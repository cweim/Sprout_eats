# Roadmap: Discovery Bot

## Overview

Transform the existing place-extraction bot into a polished, reliable, and delightful experience. Starting with test coverage and reliability, then expanding capabilities (multi-place, metadata, languages), building an interactive Mini App viewer, adding proximity features, and finishing with performance tuning and documentation.

## Milestones

- [x] **v1.1** - Core Features (Phases 1-11)
- [ ] **v1.2** - UX Polish (Phases 12-15)

## Domain Expertise

None

## Design Principles

- **Personality**: Cute, friendly bot voice throughout all user interactions
- **UX**: Minimal friction, delightful feedback, helpful error messages

## Phases

- [x] **Phase 1: Testing Foundation** - pytest infrastructure and initial test coverage
- [x] **Phase 2: Reliability** - Error retry logic and download timeout protection
- [x] **Phase 3: Multi-Place Support** - Save all detected locations, delete individual places
- [x] **Phase 4: Enhanced Metadata** - Hashtags, location tags, categories, photos, ratings, hours
- [x] **Phase 5: Language Support** - Explicit language handling and optional translation
- [x] **Phase 6: Interactive Viewer** - Telegram Mini App with map, list, search, and links
- [x] **Phase 7: Proximity Features** - Nearby alerts and distance-based grouping
- [x] **Phase 8: Performance** - Pre-load Whisper model on startup
- [x] **Phase 9: Documentation** - README with setup instructions
- [x] **Phase 10: Place Reviews** - User reviews with ratings, dishes, photos, and reminders
- [x] **Phase 11: Review History** - Reviews tab with sortable feed and indicators

### Milestone v1.2: UX Polish

- [ ] **Phase 12: Critical UX Fixes** - Bot progress feedback, photo upload progress, accessibility, list card behavior
- [ ] **Phase 13: Quick Wins** - Button states, copy improvements, small polish items
- [ ] **Phase 14: Medium Priority UX** - Map improvements, dark mode, search, loading states
- [ ] **Phase 15: Polish** - Marker clustering, animations, sharing features

## Phase Details

### Phase 1: Testing Foundation
**Goal**: Establish pytest infrastructure with tests for core functionality
**Depends on**: Nothing (first phase)
**Research**: Unlikely (standard pytest patterns)
**Plans**: 4 plans

Plans:
- [x] 01-01: pytest infrastructure (requirements-dev.txt, conftest.py, pytest.ini)
- [x] 01-02: Test downloader service (detect_platform, is_valid_url, cleanup_files)
- [x] 01-03: Test places service (search_place, search_places_from_text with mocked HTTP)
- [x] 01-04: Test database repository (CRUD operations, deduplication)

### Phase 2: Reliability
**Goal**: Add retry logic for transient failures and timeout protection for downloads
**Depends on**: Phase 1
**Research**: Unlikely (standard retry patterns with tenacity or similar)
**Plans**: 2 plans

Plans:
- [x] 02-01: Add tenacity retry to API calls (places.py, maps.py)
- [x] 02-02: Add download timeout and friendly error messages

Features:
- Retry decorator for API calls (Google Places, etc.)
- Download timeout to prevent hanging on large videos
- Graceful error messages (friendly tone!)

### Phase 3: Multi-Place Support
**Goal**: Extract and save multiple places from a single video
**Depends on**: Phase 2
**Research**: Unlikely (extending existing patterns)
**Plans**: 2 plans

Plans:
- [x] 03-01: Backend multi-place support (places service + repository)
- [x] 03-02: Bot handlers update (place selection + delete command)

Features:
- Return all places from `search_places_from_text()` (up to 5)
- Let user select which places to save (inline keyboard)
- Delete individual places (new command)
- Update database schema if needed

### Phase 4: Enhanced Metadata
**Goal**: Capture richer data from videos and places
**Depends on**: Phase 3
**Research**: Likely (yt-dlp metadata fields, Google Places API fields)
**Research topics**: yt-dlp info_dict fields for IG/TikTok, Google Places API types/photos/hours fields
**Plans**: 3 plans

Plans:
- [x] 04-01: Database schema + yt-dlp metadata extraction
- [x] 04-02: Places API enhanced fields + repository
- [x] 04-03: Bot handler display updates

Features:
- Extract: hashtags, location tags, uploader, duration from yt-dlp
- Capture: categories (types), photos, ratings, opening hours from Places API
- Store in database (schema updates)
- Display in place previews

### Phase 5: Language Support
**Goal**: Better handling of non-English content
**Depends on**: Phase 4
**Research**: Likely (Whisper language options, translation approaches)
**Research topics**: Whisper language parameter, task="translate" option, accuracy tradeoffs
**Plans**: 2 plans

Plans:
- [x] 05-01: Language detection and translation in transcriber + database schema
- [x] 05-02: Handler integration for translated search + language display

Features:
- Detect language from transcription
- Option to translate to English for place search
- Store original language text

### Phase 6: Interactive Viewer
**Goal**: Telegram Mini App for browsing saved places
**Depends on**: Phase 5
**Research**: Likely (Telegram Mini Apps, Leaflet.js)
**Research topics**: Mini App setup, Leaflet integration, GitHub Pages hosting, Telegram WebApp API
**Plans**: 4 plans

Plans:
- [x] 06-01: Mini App infrastructure (FastAPI, HTML skeleton, bot integration)
- [x] 06-02: Map view with Leaflet (markers, popups, controls)
- [x] 06-03: List view and search (cards, filtering, sorting)
- [x] 06-04: Visited and notes features (database, API, UI)

Features:
- Interactive map view (Leaflet.js, free)
- List view grouped by category
- Search and filter places
- "Open original reel" link
- "Open in Google Maps" link
- Mark as visited toggle
- Add personal notes
- Sort by distance (with location permission)
- Cute, friendly UI design

### Phase 7: Proximity Features
**Goal**: Location-aware features for discovering nearby saved places
**Depends on**: Phase 6
**Research**: Unlikely (using Mini App geolocation from Phase 6)
**Plans**: 2 plans

Plans:
- [x] 07-01: Distance calculations and display (Haversine, sort by distance, cards/popups)
- [x] 07-02: Nearby alerts and bot command (Mini App alert, API endpoint, /nearby)

Features:
- "X saved places nearby" alert when opening Mini App
- Distance display on place cards and popups
- Sort by distance option in list view
- `/nearby` command with location sharing
- GET /api/places/nearby endpoint

### Phase 8: Performance
**Goal**: Reduce cold start time by pre-loading Whisper model
**Depends on**: Phase 7
**Research**: Unlikely (straightforward preload on bot startup)
**Plans**: 1 plan

Plans:
- [x] 08-01: Pre-load Whisper model (preload functions, startup integration)

Features:
- Load Whisper model at bot startup
- Logging shows model loading status
- No cold start delay on first video

### Phase 9: Documentation
**Goal**: README with complete setup instructions
**Depends on**: Phase 8
**Research**: Unlikely (documenting what exists)
**Plans**: 1 plan

Plans:
- [x] 09-01: README documentation (overview, requirements, installation, usage, deployment)

Contents:
- Project overview
- Requirements (Python, FFmpeg, API keys)
- Installation steps
- Configuration (.env setup)
- Usage guide with examples
- Mini App deployment instructions

### Phase 10: Place Reviews
**Goal**: Allow users to write and manage reviews for visited places
**Depends on**: Phase 9
**Research**: Unlikely (extending existing patterns)
**Plans**: 5 plans

Plans:
- [x] 10-01: Database & API foundation (schema, repository, endpoints)
- [x] 10-02: Review bottom sheet and rating UI components
- [x] 10-03: Photo upload and display in reviews
- [x] 10-04: Conversational review flow in Telegram bot
- [x] 10-05: Automated review reminder system

Features:
- Review model with overall rating, price rating, remarks
- ReviewDish model for individual dish ratings
- ReviewPhoto model for uploading photos (2 per dish, 3 overall)
- Bottom sheet UI with star ratings and dish sections
- Telegram bot conversation flow for writing reviews
- Photo upload from Telegram
- Automated reminders 1 hour after marking place visited
- "Ask Later" to postpone, "Don't Ask" to opt out
- Background job checks every 5 minutes

### Phase 11: Review History
**Goal**: Add Reviews history page with browsable review feed and review indicators
**Depends on**: Phase 10
**Research**: Unlikely (UI extension of existing review features)
**Plans**: 1 plan

Plans:
- [x] 11-01: Reviews tab with sortable/filterable feed and navigation

Features:
- Reviews tab (3rd navigation option: Map/List/Reviews)
- Review cards showing compact summaries
- Sort by: newest, oldest, highest rated, lowest rated
- Filter by: all, with photos, star ratings
- Tap card opens review sheet in edit mode
- "View Place" button to navigate from review to place on map
- Review indicators (✍️ + stars badge) on place cards
- Real-time updates when reviews saved/deleted

---

## Milestone v1.2: UX Polish

Based on comprehensive UX audit (.planning/UX_AUDIT.md).

### Phase 12: Critical UX Fixes
**Goal**: Address high-priority UX issues from audit
**Depends on**: Phase 11
**Research**: Unlikely (implementing known patterns)
**Plans**: 3 plans

Plans:
- [ ] 12-01: Bot progress feedback (status messages during video processing)
- [ ] 12-02: Photo upload progress + ARIA accessibility labels
- [ ] 12-03: List card behavior + review edit from Reviews tab

Features:
- "Downloading video... 📥" → "Transcribing... 🎤" → "Finding places... 🔍" status messages
- Upload progress bar in photo grid
- aria-label on all icon buttons
- List card tap behavior improvement
- Edit button in review sheet from Reviews tab

### Phase 13: Quick Wins
**Goal**: Small polish items under 2h each
**Depends on**: Phase 12
**Research**: Unlikely (small changes)
**Plans**: 2 plans

Plans:
- [ ] 13-01: Copy and feedback improvements (success messages, placeholders, button text)
- [ ] 13-02: Button states and error handling (active states, retry, tooltips)

Features:
- Personalized success messages ("✨ Saved **Café Latte**!")
- :active states on buttons (scale 0.95)
- Improved placeholder text
- Consistent time format
- "Update Review" instead of "Save Review" when editing
- Retry button on errors
- Disable review button when not visited
- Tooltips on icon buttons

### Phase 14: Medium Priority UX
**Goal**: Significant UX improvements
**Depends on**: Phase 13
**Research**: Likely (dark mode theming, skeleton patterns)
**Plans**: 4 plans

Plans:
- [ ] 14-01: Map improvements (auto-center on user, filter counts)
- [ ] 14-02: Dark mode support (Telegram theme detection)
- [ ] 14-03: Search and filter improvements (address/notes search, inline filters)
- [ ] 14-04: Loading states (skeleton screens, bottom sheet gestures)

Features:
- Auto-center map on user location
- Filter chip counts ("All (15)" / "To Visit (12)")
- Dark mode via Telegram.WebApp.colorScheme
- Extended search (address, notes, types)
- Skeleton loading cards
- Bottom sheet swipe-to-close

### Phase 15: Polish
**Goal**: Nice-to-have improvements
**Depends on**: Phase 14
**Research**: Likely (marker clustering, drag-drop libraries)
**Plans**: 3 plans

Plans:
- [ ] 15-01: Map polish (marker clustering)
- [ ] 15-02: Review enhancements (drag-to-reorder dishes, share feature)
- [ ] 15-03: Animations and gestures (success animations, swipe-to-delete)

Features:
- Leaflet marker clustering for 50+ places
- Drag handles to reorder dishes
- Share review via Telegram API
- Success confetti/checkmark animations
- Swipe-to-delete gestures on cards

## Progress

### Milestone v1.1 (Complete)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Testing Foundation | 4/4 | Complete | 2026-03-31 |
| 2. Reliability | 2/2 | Complete | 2026-04-01 |
| 3. Multi-Place Support | 2/2 | Complete | 2026-04-01 |
| 4. Enhanced Metadata | 3/3 | Complete | 2026-04-01 |
| 5. Language Support | 2/2 | Complete | 2026-04-02 |
| 6. Interactive Viewer | 4/4 | Complete | 2026-04-02 |
| 7. Proximity Features | 2/2 | Complete | 2026-04-03 |
| 8. Performance | 1/1 | Complete | 2026-04-03 |
| 9. Documentation | 1/1 | Complete | 2026-04-03 |
| 10. Place Reviews | 5/5 | Complete | 2026-04-14 |
| 11. Review History | 1/1 | Complete | 2026-04-16 |

### Milestone v1.2 (In Progress)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 12. Critical UX Fixes | 0/3 | Not Started | - |
| 13. Quick Wins | 0/2 | Not Started | - |
| 14. Medium Priority UX | 0/4 | Not Started | - |
| 15. Polish | 0/3 | Not Started | - |
