# Roadmap: Discovery Bot

## Overview

Transform the existing place-extraction bot into a polished, reliable, and delightful experience. Starting with test coverage and reliability, then expanding capabilities (multi-place, metadata, languages), building an interactive Mini App viewer, adding proximity features, and finishing with performance tuning and documentation.

## Domain Expertise

None

## Design Principles

- **Personality**: Cute, friendly bot voice throughout all user interactions
- **UX**: Minimal friction, delightful feedback, helpful error messages

## Phases

- [x] **Phase 1: Testing Foundation** - pytest infrastructure and initial test coverage
- [ ] **Phase 2: Reliability** - Error retry logic and download timeout protection
- [ ] **Phase 3: Multi-Place Support** - Save all detected locations, delete individual places
- [ ] **Phase 4: Enhanced Metadata** - Hashtags, location tags, categories, photos, ratings, hours
- [ ] **Phase 5: Language Support** - Explicit language handling and optional translation
- [ ] **Phase 6: Interactive Viewer** - Telegram Mini App with map, list, search, and links
- [ ] **Phase 7: Proximity Features** - Nearby alerts and distance-based grouping
- [ ] **Phase 8: Performance** - Pre-load Whisper model on startup
- [ ] **Phase 9: Documentation** - README with setup instructions

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
- [ ] 02-02: Add download timeout and friendly error messages

Features:
- Retry decorator for API calls (Google Places, etc.)
- Download timeout to prevent hanging on large videos
- Graceful error messages (friendly tone!)

### Phase 3: Multi-Place Support
**Goal**: Extract and save multiple places from a single video
**Depends on**: Phase 2
**Research**: Unlikely (extending existing patterns)
**Plans**: TBD

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
**Plans**: TBD

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
**Plans**: TBD

Features:
- Detect language from transcription
- Option to translate to English for place search
- Store original language text

### Phase 6: Interactive Viewer
**Goal**: Telegram Mini App for browsing saved places
**Depends on**: Phase 5
**Research**: Likely (Telegram Mini Apps, Leaflet.js)
**Research topics**: Mini App setup, Leaflet integration, GitHub Pages hosting, Telegram WebApp API
**Plans**: TBD

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
**Plans**: TBD

Features:
- "X saved places nearby" alert when opening Mini App
- Group nearby places ("3 more within 500m")
- `/nearby` command for quick check
- Distance display on place cards

### Phase 8: Performance
**Goal**: Reduce cold start time by pre-loading Whisper model
**Depends on**: Phase 7
**Research**: Unlikely (straightforward preload on bot startup)
**Plans**: TBD

Features:
- Load Whisper model at bot startup
- Show loading status if not ready
- Consider lazy loading for memory constraints

### Phase 9: Documentation
**Goal**: README with complete setup instructions
**Depends on**: Phase 8
**Research**: Unlikely (documenting what exists)
**Plans**: TBD

Contents:
- Project overview
- Requirements (Python, FFmpeg, API keys)
- Installation steps
- Configuration (.env setup)
- Usage guide with examples
- Mini App deployment instructions

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Testing Foundation | 4/4 | Complete | 2026-03-31 |
| 2. Reliability | 1/2 | In progress | - |
| 3. Multi-Place Support | 0/TBD | Not started | - |
| 4. Enhanced Metadata | 0/TBD | Not started | - |
| 5. Language Support | 0/TBD | Not started | - |
| 6. Interactive Viewer | 0/TBD | Not started | - |
| 7. Proximity Features | 0/TBD | Not started | - |
| 8. Performance | 0/TBD | Not started | - |
| 9. Documentation | 0/TBD | Not started | - |
