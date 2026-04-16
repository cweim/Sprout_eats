# Discovery Bot UI/UX Comprehensive Audit
*Date: 2026-04-14*
*Scope: Mini App + Telegram Bot*

---

## Executive Summary

**Overall Assessment:** Good foundation with several opportunities for polish and consistency improvements.

**Strengths:**
- Clean, playful design system
- Comprehensive feature set
- Good empty/loading states
- Haptic feedback throughout

**Critical Issues:** 3 high-priority
**Medium Issues:** 12 medium-priority
**Polish Items:** 8 low-priority

---

## 1. USER FLOWS AUDIT

### Flow A: Discovery (Bot → Save Places)

**Steps:**
1. User sends video URL to Telegram bot
2. Bot downloads, transcribes, finds places
3. User selects places to save (if multiple)
4. Places saved to database

**UX Issues:**

🔴 **CRITICAL: No progress feedback during processing**
- Video download/transcription can take 30-60s
- User sees nothing after sending URL
- **Fix:** Add "Downloading video... 📥" → "Transcribing audio... 🎤" → "Finding places... 🔍" status messages

🟡 **MEDIUM: Multi-place selection unclear**
- Inline keyboard shows place names, but no preview
- Can't see location/rating before selecting
- **Fix:** Add mini-preview with rating + address under each button

🟢 **POLISH: Success message generic**
- "Place saved!" is bland
- **Fix:** "✨ Saved **Café Latte**! Open the Mini App to explore"

---

### Flow B: Browse Places (Map View)

**Steps:**
1. Open Mini App
2. View places on map
3. Tap marker → popup
4. Interact with place (review/visit/notes/maps)

**UX Issues:**

🟡 **MEDIUM: Map loads without user location context**
- Map shows all places, may be zoomed out too far
- User doesn't know where they are relative to places
- **Fix:** Auto-center on user location if granted, show blue dot

🟡 **MEDIUM: Filter chips don't show counts**
- "All" / "To Visit" / "Visited ✓" have no numbers
- User doesn't know distribution
- **Fix:** Add counts: "All (15)" / "To Visit (12)" / "Visited ✓ (3)"

🟡 **MEDIUM: Cuisine filter empty until places loaded**
- Dropdown appears even with no cuisines
- **Fix:** Hide until cuisine types available, or show placeholder

🟢 **POLISH: Map controls lack visual feedback**
- 📍 and 🗺️ buttons don't show pressed state
- **Fix:** Add :active state with scale/shadow

🟢 **POLISH: Marker clustering missing**
- If user has 50+ places in one city, markers overlap
- **Fix:** Implement Leaflet marker clustering

---

### Flow C: Browse Places (List View)

**Steps:**
1. Switch to List tab
2. Search/filter/sort places
3. Tap card → opens map popup

**UX Issues:**

🔴 **CRITICAL: Tapping card opens map popup, not place details**
- Unexpected behavior - tapping should show details
- Map popup requires switching views
- **Fix:** Either:
  - Option A: Open place detail sheet (new)
  - Option B: Keep map popup but add visual feedback it's switching views

🟡 **MEDIUM: Search doesn't search address/notes**
- Only searches place name
- Misses "restaurants near Central Park" if in notes
- **Fix:** Extend search to address, notes, types

🟡 **MEDIUM: Filter drawer UX poor**
- Tapping ⚙️ opens full drawer (heavy)
- Drawer blocks all content
- Active filters shown separately in chips, redundant
- **Fix:** Replace drawer with inline expandable filters

🟡 **MEDIUM: No sort persistence**
- User sorts by "Top Rated", switches tab, comes back → reset to "Newest"
- **Fix:** Remember sort preference in localStorage

🟡 **MEDIUM: Distance sort requires permission every time**
- No indication permission is needed until you tap
- **Fix:** Show "🔒 Location needed" on distance sort button if not granted

🟢 **POLISH: Empty search results abrupt**
- "Nothing here yet!" with giant button
- **Fix:** Show "No results for 'pizza'" with suggestions

🟢 **POLISH: Place cards lack visual hierarchy**
- All text same size/weight
- Name doesn't stand out
- **Fix:** Increase name font size, use semibold

---

### Flow D: Place Interaction (Popup/Card Actions)

**Steps:**
1. View place details
2. Mark visited / Add notes / Review / Navigate

**UX Issues:**

🟡 **MEDIUM: Inline note editing inconsistent**
- List view: tap note → edit inline
- Map popup: tap note → edit inline
- Behavior: tap outside doesn't save, unclear
- **Fix:** Add explicit "Save" / "Cancel" buttons or auto-save on blur with toast

🟡 **MEDIUM: Visited toggle has no confirmation**
- Tapping visited checkbox immediately toggles
- No undo if accidental
- **Fix:** Add toast with undo: "Marked as visited | Undo"

🟡 **MEDIUM: Review button behavior confusing**
- If not visited: still shows "Write Review" button
- Clicking shows "Please mark as visited first"
- **Fix:** Disable button and show tooltip: "Mark as visited first"

🟢 **POLISH: Delete confirmation modal is plain**
- Generic browser confirm()
- **Fix:** Custom modal with place name and image

🟢 **POLISH: Google Maps link opens new tab**
- Telegram Mini App UX: should use Telegram browser
- **Fix:** Use Telegram.WebApp.openLink()

---

### Flow E: Write Review

**Steps:**
1. Tap "Write Review" (if visited)
2. Add dishes (name, rating, remarks)
3. Upload dish photos
4. Add overall rating, price rating
5. Upload place photos
6. Add overall remarks
7. Save

**UX Issues:**

🔴 **CRITICAL: Photo upload has no progress indicator**
- Clicking + shows file picker
- After selecting: "Uploading photo..." toast appears
- If upload takes 5s, user sees nothing
- **Fix:** Show upload progress bar in photo grid

🟡 **MEDIUM: Can't reorder dishes**
- Added "Appetizer" after "Main" - stuck in wrong order
- **Fix:** Add drag handles to reorder

🟡 **MEDIUM: Can't edit dish after saving**
- Must delete entire review and start over
- **Fix:** Make dishes editable even after save

🟡 **MEDIUM: Star rating not obvious it's interactive**
- No hover state on stars
- **Fix:** Add :hover color change, pointer cursor

🟡 **MEDIUM: Price rating labels unclear**
- Shows 💰💰💰 but user doesn't know what that means upfront
- **Fix:** Show labels as options: "$" "$$" "$$$" "$$$$" "$$$$$"

🟡 **MEDIUM: Photo grid doesn't show which photo is which**
- 5 dish photos all look the same
- Can't tell which goes with which dish
- **Fix:** Already grouped by dish in UI - good. But add dish label overlay on hover

🟢 **POLISH: No image preview before upload**
- Can't verify photo orientation/quality
- **Fix:** Show preview with crop/rotate options

🟢 **POLISH: Remarks placeholder generic**
- "Overall thoughts... (optional)"
- **Fix:** "What stood out? Ambiance? Service? Must-try dishes?"

🟢 **POLISH: Save button always says "Save Review"**
- Even when editing existing review
- **Fix:** "Update Review" when editing

---

### Flow F: Browse Reviews

**Steps:**
1. Switch to Reviews tab
2. Sort/filter reviews
3. Tap review card
4. View full review
5. Navigate to place

**UX Issues:**

🟡 **MEDIUM: Review cards truncate at 80 chars**
- User wrote 200-char review, sees "Best pasta I've ev..."
- **Fix:** Show 2 lines (~140 chars) before truncating

🟡 **MEDIUM: "View Place" button only shows when opened from Reviews tab**
- If user opens review from List view, no "View Place" button
- **Fix:** Always show "View Place" button in review sheet

🟡 **MEDIUM: Can't edit review from Reviews tab**
- Must navigate to place, then edit
- **Fix:** Add "Edit" button in review sheet

🟢 **POLISH: Time ago format inconsistent**
- "2 days ago" vs "1 week ago" vs "2026-01-15"
- **Fix:** Consistent format, add "Edited 5 min ago" if updated recently

🟢 **POLISH: No way to share review**
- Can't share to friends or export
- **Fix:** Add share button (Telegram share API)

---

### Flow G: Search & Discovery (Google Places Modal)

**Steps:**
1. Tap "🔍 Discover Places" FAB
2. Search or select category
3. View results
4. Save places

**UX Issues:**

🟡 **MEDIUM: Modal covers entire screen**
- Can't see map/list underneath
- Feels disconnected from main app
- **Fix:** Use bottom sheet instead of full modal

🟡 **MEDIUM: Search requires manual location grant**
- If location not granted, search fails silently
- **Fix:** Prompt for location with explanation

🟡 **MEDIUM: Can't filter search results**
- Shows all types mixed together
- No distance filter, rating filter
- **Fix:** Add filter chips: "Open now" / "4+ stars" / "< 1km"

🟢 **POLISH: Category chips static**
- Same 6 categories always shown
- **Fix:** Personalize based on saved place types

---

## 2. VISUAL CONSISTENCY AUDIT

### Colors & Theming

✅ **GOOD:** Consistent color variables
- `--sprout-purple`, `--sprout-green`, etc.
- Used throughout

🟡 **MEDIUM: Dark mode not implemented**
- Telegram supports dark theme, app doesn't adapt
- **Fix:** Detect Telegram.WebApp.colorScheme and apply dark theme

🟢 **POLISH: Accent color overused**
- Purple used for too many elements, lacks hierarchy
- **Fix:** Reserve purple for primary actions only

### Typography

✅ **GOOD:** Readable font sizes

🟡 **MEDIUM: No font scaling for accessibility**
- Fixed px sizes don't respect user preferences
- **Fix:** Use rem instead of px

🟢 **POLISH: Headings inconsistent**
- Some use h2, some use .section-header class
- **Fix:** Standardize heading hierarchy

### Spacing & Layout

✅ **GOOD:** Consistent padding/margins

🟡 **MEDIUM: Bottom sheet doesn't respect safe area**
- On iPhone with notch, footer buttons near edge
- **Fix:** Add safe-area-inset-bottom padding

🟢 **POLISH: Cards have inconsistent corner radius**
- Some 12px, some 16px, some 8px
- **Fix:** Standardize to 12px

---

## 3. INTERACTION PATTERNS

### Buttons & Touch Targets

✅ **GOOD:** Minimum 44px touch targets

🟡 **MEDIUM: Some buttons lack active/pressed states**
- Map control buttons, filter chips
- **Fix:** Add :active transform: scale(0.95)

🟡 **MEDIUM: Long-press not utilized**
- Could use for quick actions (long-press place → delete)
- **Fix:** Add long-press menu on place cards

### Gestures

✅ **GOOD:** Haptic feedback on taps

🟡 **MEDIUM: Bottom sheet not draggable**
- Has handle but can't drag to close
- **Fix:** Implement swipe-down to close

🟡 **MEDIUM: No swipe gestures on review cards**
- Could swipe left to delete
- **Fix:** Add swipe-to-delete pattern

### Navigation

🟡 **MEDIUM: Tab switching has no animation**
- Views appear/disappear abruptly
- **Fix:** Add fade or slide transition

🟡 **MEDIUM: Back button behavior unclear**
- Telegram back button sometimes closes app, sometimes closes sheet
- **Fix:** Properly manage Telegram.WebApp.BackButton events

---

## 4. FEEDBACK MECHANISMS

### Success States

✅ **GOOD:** Toast notifications for saves

🟢 **POLISH: Success animations missing**
- Save button could show checkmark animation
- **Fix:** Add success confetti/checkmark micro-interaction

### Error States

🟡 **MEDIUM: Error messages generic**
- "Failed to save" - why? Network? Validation?
- **Fix:** Specific error messages with actions

🟡 **MEDIUM: Network errors not retryable**
- Error shows, user must refresh entirely
- **Fix:** Add "Retry" button on network errors

### Loading States

✅ **GOOD:** Loading spinner on initial load

🟡 **MEDIUM: Skeleton screens missing**
- Shows spinner, then content pops in
- **Fix:** Show skeleton cards while loading

🟡 **MEDIUM: Infinite scroll loading unclear**
- Reviews list could load more, no indicator
- **Fix:** Add "Load more" button or loading indicator at bottom

---

## 5. INFORMATION ARCHITECTURE

### Content Organization

✅ **GOOD:** Logical 3-tab structure

🟡 **MEDIUM: No breadcrumbs/context**
- In review sheet, hard to know which place
- **Fix:** Keep place name in sheet header always

### Search & Findability

🟡 **MEDIUM: No recent searches**
- Search bar forgets what you searched
- **Fix:** Show recent searches when focused

🟡 **MEDIUM: No quick filters/shortcuts**
- Can't save filter combos like "Unvisited Sushi"
- **Fix:** Add "Saved Filters" feature

---

## 6. MOBILE OPTIMIZATION

### Performance

✅ **GOOD:** Lightweight, fast load

🟡 **MEDIUM: Map tiles slow on 3G**
- Leaflet loads full-res tiles
- **Fix:** Implement progressive image loading

🟡 **MEDIUM: Large images not optimized**
- Review photos could be huge
- **Fix:** Use WebP, lazy loading, responsive images

### Touch Optimization

✅ **GOOD:** Large touch targets

🟡 **MEDIUM: Input zoom on iOS**
- Text inputs < 16px trigger zoom
- **Fix:** Ensure inputs are 16px minimum

🟡 **MEDIUM: Keyboard covers inputs**
- Review remarks textarea hidden by keyboard
- **Fix:** Scroll to input on focus, add padding

---

## 7. ACCESSIBILITY

### Screen Readers

🔴 **CRITICAL: No ARIA labels**
- Icon buttons have no labels
- Screen reader says "Button" for ✍️
- **Fix:** Add aria-label="Write review" to all icon buttons

🟡 **MEDIUM: Focus management poor**
- Modals don't trap focus
- Tab order jumps around
- **Fix:** Implement focus trap in modals/sheets

### Keyboard Navigation

🟡 **MEDIUM: No keyboard shortcuts**
- Can't navigate with keyboard
- **Fix:** Add shortcuts: "/" for search, "n" for new review, etc.

### Color Contrast

✅ **GOOD:** Passes WCAG AA for most text

🟡 **MEDIUM: Hint text too light**
- Secondary text #999 on white fails contrast
- **Fix:** Darken to #666

---

## 8. CONSISTENCY ACROSS PLATFORMS

### Telegram Bot vs Mini App

🟡 **MEDIUM: Review flow split between bot and app**
- Bot has conversation review flow
- App has sheet review flow
- Confusing which to use
- **Fix:** Deprecate bot conversation flow, link to Mini App

🟡 **MEDIUM: Terminology inconsistent**
- Bot says "saved places", app says "my places"
- **Fix:** Align on "My Places" everywhere

---

## PRIORITIZED RECOMMENDATIONS

### High Priority (Ship Next Week)

1. **Add progress feedback to bot video processing** (5h)
2. **Fix photo upload progress indicator** (3h)
3. **Add ARIA labels for accessibility** (4h)
4. **Fix list view card tap behavior** (2h)
5. **Add review edit from Reviews tab** (3h)

**Total: 17 hours**

### Medium Priority (Ship Next Sprint)

6. Map auto-center on user location (4h)
7. Filter chip counts (2h)
8. Dark mode support (8h)
9. Inline note editing UX improvements (4h)
10. Review card truncation improvements (2h)
11. Search improvements (address/notes) (6h)
12. Bottom sheet swipe-down to close (4h)
13. Error message improvements (4h)
14. Skeleton loading states (5h)

**Total: 39 hours**

### Polish (Ship When Available)

15. Marker clustering (6h)
16. Drag-to-reorder dishes (5h)
17. Share review feature (4h)
18. Success animations (3h)
19. Image preview before upload (4h)
20. Swipe-to-delete gestures (4h)
21. Quick filter shortcuts (6h)
22. Keyboard shortcuts (4h)

**Total: 36 hours**

---

## QUICK WINS (< 2 hours each)

1. Update success message copy (30min)
2. Add :active states to buttons (1h)
3. Fix placeholder text (30min)
4. Standardize time format (1h)
5. Show "Update Review" instead of "Save" (30min)
6. Add "Retry" to error states (1h)
7. Disable review button when not visited (1h)
8. Add tooltips to icon buttons (2h)

**Total: 8 hours**

---

## MEASURING SUCCESS

**Metrics to Track:**

- Time to first interaction (should decrease with progress feedback)
- Review completion rate (should increase with better UX)
- Error rate (should decrease with clearer feedback)
- Return visits (should increase with better browsing UX)
- User-reported issues (should decrease)

---

*End of Audit*
