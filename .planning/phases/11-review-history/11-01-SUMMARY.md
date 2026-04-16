# 11-01 Summary: Review History UI

## Completed
- Reviews tab added as third navigation option (Map/List/Reviews)
- Review cards display compact summaries with sort and filter
- Sort options: newest, oldest, highest rated, lowest rated
- Filter options: all, with photos, 5 star, 4 star
- Tap review card opens full review sheet
- "View Place" button in review sheet navigates from review to map
- Review indicators (✍️ + stars) displayed on place cards
- Review indicators shown in map popups
- Real-time updates when reviews saved/deleted

## Technical Implementation

### Files Modified
- `webapp/index.html` - Added Reviews view with controls
- `webapp/styles.css` - Added styling for reviews view and indicators
- `webapp/app.js` - Added reviews functionality

### Key Functions Added
- `loadReviews()` - Fetches reviews from API
- `renderReviews()` - Renders review cards with sort/filter
- `createReviewCard()` - Creates review card HTML
- `sortReviews()` - Sorts by newest/oldest/highest/lowest
- `filterReviews()` - Filters by all/photos/stars
- `formatTimeAgo()` - Formats relative timestamps
- `openReviewSheetFromHistory()` - Opens review from history
- `getPlaceReview()` - Gets review for place
- `setupReviewsView()` - Wires up event handlers

### UI Components
- Reviews header with count and sort dropdown
- Filter chips for all/photos/star ratings
- Review cards with:
  - Place name and rating stars
  - Price rating
  - Photo count and dish count
  - Remarks preview (truncated)
  - Relative timestamp
- Empty state for no reviews
- "View Place" button in review sheet (shows when opened from Reviews tab)
- Review badges on place cards showing stars
- Review indicators in map popups

### Real-time Updates
- Reviews reload after save
- Reviews reload after delete
- Place cards refresh to show/hide badges
- Map markers refresh to show/hide indicators

## Notes
- Reviews count updates dynamically
- Empty state shown when no reviews or filters match nothing
- Review cards tappable to open full review
- Navigation flow: Reviews → Review Sheet → View Place → Map
- Review indicators only show for places with reviews
