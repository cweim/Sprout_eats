# Phase 6 Discovery: Interactive Viewer

**Date:** 2026-04-02
**Depth:** Level 2 (Standard Research)

## Research Questions

1. How to set up a Telegram Mini App?
2. How to integrate Leaflet.js for maps?
3. How to serve place data to the Mini App?
4. How to validate Telegram user authentication?

## Findings

### Telegram Mini Apps

**What they are:**
- Web applications that run inside Telegram
- Hosted externally (GitHub Pages works)
- Accessed via inline button with `web_app` parameter
- Get user context via `window.Telegram.WebApp`

**Setup requirements:**
1. Static HTML/CSS/JS files hosted on HTTPS URL
2. Bot sends `InlineKeyboardButton` with `web_app=WebAppInfo(url=...)`
3. Mini App calls `Telegram.WebApp.ready()` on load
4. User data available in `Telegram.WebApp.initDataUnsafe`

**Key API:**
- `Telegram.WebApp.initData` - Signed data string for validation
- `Telegram.WebApp.initDataUnsafe` - Parsed user data (user.id, user.first_name)
- `Telegram.WebApp.MainButton` - Bottom action button
- `Telegram.WebApp.BackButton` - Navigation back button
- `Telegram.WebApp.themeParams` - Color theme from Telegram

### Leaflet.js Integration

**Setup:**
```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
```

**Basic map:**
```javascript
const map = L.map('map').setView([lat, lng], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
}).addTo(map);
L.marker([lat, lng]).addTo(map).bindPopup('Place name');
```

**Tiles:** OpenStreetMap is free, no API key needed.

### Data Access Architecture

**Decision: Add FastAPI alongside bot**

Options considered:
1. Flask/FastAPI web server alongside bot - **Selected**
2. Serverless function (Vercel) - More complex deployment
3. Static JSON export - Not real-time

**Rationale:**
- FastAPI is lightweight, async-native (matches existing bot)
- Runs on same server as bot
- Simple CORS setup for Mini App access
- Can validate Telegram initData for security

**Implementation:**
- Add FastAPI to requirements.txt
- Create `api/` module with routes
- Run both bot and API (separate process or uvicorn alongside)
- API endpoints: GET /api/places, PATCH /api/places/{id}

### Authentication

**Telegram initData validation:**
- Mini App sends `initData` string to API
- API validates HMAC-SHA256 signature using bot token
- If valid, extract user_id from data
- Use user_id to filter places (future multi-user)

**For single-user MVP:**
- Skip validation, return all places
- Add validation in future if needed

## Architecture Decision

```
┌─────────────────┐     ┌─────────────────┐
│  Telegram Bot   │     │   FastAPI       │
│  (python-tg-bot)│     │   (uvicorn)     │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │                       │
         ▼                       ▼
┌─────────────────────────────────────────┐
│              SQLite Database            │
│              (discovery_bot.db)         │
└─────────────────────────────────────────┘
         ▲
         │ fetch places
         │
┌────────┴────────┐
│   Mini App      │
│   (GitHub Pages)│
│   - Leaflet map │
│   - List view   │
└─────────────────┘
```

## Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Frontend | Vanilla HTML/CSS/JS | Simple, no build step |
| Maps | Leaflet.js + OpenStreetMap | Free, no API key |
| API | FastAPI | Async, lightweight, matches bot |
| Hosting | GitHub Pages | Free HTTPS hosting |
| Styling | Telegram theme vars + custom CSS | Native look |

## Database Changes Needed

New columns for Phase 6:
- `is_visited` (Boolean) - Mark place as visited
- `notes` (String) - Personal notes

## Plan Breakdown

1. **06-01: Infrastructure** - FastAPI setup, bot launch button, Mini App skeleton
2. **06-02: Map View** - Leaflet integration, markers, popups
3. **06-03: List View** - Category grouping, search, filter
4. **06-04: Visited & Notes** - Database schema, API endpoints, UI

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| CORS issues | Configure FastAPI CORS middleware |
| Mobile viewport | Use Telegram viewport CSS vars |
| Slow map load | Lazy load markers, limit initial view |

---
*Discovery completed: 2026-04-02*
