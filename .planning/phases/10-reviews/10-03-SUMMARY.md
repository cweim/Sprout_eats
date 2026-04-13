---
phase: 10-reviews
plan: 03
subsystem: webapp
tags: [reviews, photos, upload, compression]

requires:
  - phase: 10-02
    provides: Review bottom sheet and rating components
provides:
  - Photo grid component for dishes and overall section
  - Client-side image compression (max 1MB)
  - Photo upload, display, delete, and fullscreen view
affects: [webapp/index.html, webapp/styles.css, webapp/app.js]

tech-stack:
  added: []
  patterns: [Canvas-based image compression, FormData file upload, Photo grid with dynamic add/remove]

key-files:
  created: []
  modified: [webapp/index.html, webapp/styles.css, webapp/app.js]

key-decisions:
  - "Client-side compression before upload (max 1MB, quality reduction loop)"
  - "Photos require saved review first (can't upload to unsaved review)"
  - "Dish photos max 2, overall photos max 3"
  - "Fullscreen view on photo tap"
  - "Small photo grid variant for dish cards (56px thumbnails)"

patterns-established:
  - "compressImage() - Canvas-based JPEG compression with quality loop"
  - "validateImageFile() - Type and size validation"
  - "updatePhotoGrid() - Reusable photo grid with add/delete"

issues-created: []

duration: 10min
completed: 2026-04-13
---

# Phase 10 Plan 03: Photo Upload and Display Summary

**Photo upload and display functionality added to the review UI**

## Performance

- **Duration:** 10 min
- **Started:** 2026-04-13
- **Completed:** 2026-04-13
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

### Task 1: Photo Grid UI

Added to `webapp/index.html`:
- Overall photos section in review sheet (between price rating and remarks)
- `#overall-photos` container with `.photo-grid` class

Added to `webapp/styles.css`:
- `.photo-grid` flex container with 8px gap
- `.photo-grid.small` variant (6px gap, 56px thumbnails)
- `.photo-thumb` - 72px square with rounded corners
- `.photo-delete-btn` - Overlay delete button (appears on hover)
- `.photo-add-btn` - Dashed border add button
- `.photo-fullscreen` - Full screen overlay
- `.section-sublabel` - Label styling for photo section
- `.overall-photos-section` - Container styling

### Task 2: Client-side Image Compression

Added JS functions:
- `compressImage(file, maxSizeKB)` - Canvas-based JPEG compression
  - Scales down to max 1920px on longest side
  - Quality reduction loop (0.9 -> 0.1) until under size limit
  - Returns compressed Blob
- `validateImageFile(file)` - Validates type (JPEG, PNG, WebP) and size (max 10MB raw)

### Task 3: Photo Upload, Display, and Delete

Added JS functions:
- `uploadPhoto(reviewId, file, dishId)` - Uploads compressed photo to API
- `deletePhoto(reviewId, photoId)` - Deletes photo from API
- `updatePhotoGrid(container, photos, maxPhotos, dishId)` - Renders photo grid
- `addPhotoButton(container, maxPhotos, dishId)` - Adds upload button to grid
- `viewPhotoFullscreen(url)` - Shows photo in fullscreen overlay

Updated functions:
- `createDishCard()` - Now includes photo grid (max 2 photos per dish)
- `openReviewSheet()` - Initializes overall photos grid and passes dish photos

## Files Modified

- `webapp/index.html` - Added overall photos section, updated versions
- `webapp/styles.css` - Added ~100 lines of photo grid styles
- `webapp/app.js` - Added ~200 lines of photo functionality

## Photo Limits

| Context | Max Photos |
|---------|------------|
| Per dish | 2 |
| Overall (ambiance/exterior) | 3 |

## API Integration

- `POST /api/reviews/{id}/photos` - Upload photo (FormData with file, optional dish_id)
- `DELETE /api/reviews/{id}/photos/{photo_id}` - Delete photo

## Validation

- Image types: JPEG, PNG, WebP only
- Max raw file size: 10MB
- Compressed to max 1MB before upload
- Max dimension: 1920px (scaled down if larger)

## User Experience

- Photos require saving review first (shows "Please save your review first" message)
- Tap photo to view fullscreen
- Delete button appears on hover/tap
- Add button shown when under limit
- Smooth compression with quality reduction loop

## Verification

- [x] Photo grid shows in dish cards (small variant, 2 max)
- [x] Photo grid shows in overall section (3 max)
- [x] Client-side compression works (max 1MB output)
- [x] Photos display as square thumbnails with rounded corners
- [x] Delete button appears on hover/tap
- [x] Tap photo shows fullscreen view
- [x] "Please save review first" message for new reviews
- [x] JavaScript syntax valid (node --check passed)

## Ready for Next Plan

10-04: Bot Review Flow
- /review command handler
- Review prompt after marking visited
- Inline keyboard for quick rating
- Integration with Telegram bot

---
*Phase: 10-reviews*
*Plan: 03 of 5*
*Completed: 2026-04-13*
