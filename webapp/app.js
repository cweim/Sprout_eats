// Configuration
const API_URL = ''; // Set to your API URL, e.g., 'http://localhost:8000'

function trackEvent(eventName, options = {}) {
    window.SproutAnalytics?.track(eventName, options);
}

function setupIntentTracking() {
    document.addEventListener('click', (event) => {
        const link = event.target.closest?.('a[href]');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        if (!href.includes('google.com/maps')) return;
        const placeIdMatch = href.match(/(?:query_place_id=|place_id:)([^&]+)/);
        const googlePlaceId = placeIdMatch ? decodeURIComponent(placeIdMatch[1]) : null;
        trackEvent('directions_clicked', {
            entityType: rcCurrentPlaceId ? 'place' : 'restaurant',
            entityId: rcCurrentPlaceId || googlePlaceId || undefined,
            metadata: { google_place_id: rcCurrentGoogleId || googlePlaceId, surface: currentTab || 'saved' },
        });
    }, true);
}

const _urlParams = new URLSearchParams(window.location.search);
const INITIAL_START_PARAM = window.Telegram?.WebApp?.initDataUnsafe?.start_param
    || _urlParams.get('startapp') || '';
const GROUP_START_PREFIX = 'group_';
const GROUP_TOKEN = INITIAL_START_PARAM.startsWith(GROUP_START_PREFIX)
    ? INITIAL_START_PARAM.slice(GROUP_START_PREFIX.length) : '';
const BOT_USERNAME = _urlParams.get('bot') || '';
const IS_GROUP_MAP = !!GROUP_TOKEN;

// Shared map context — set when opened with ?share=<token> (read-only view of another user's map)
const SHARE_TOKEN = _urlParams.get('share') || '';
const IS_SHARE_MAP = !!SHARE_TOKEN;
let shareOwnerName = '';
let shareOwnerUsername = '';

// Escape user-controlled strings before injecting into innerHTML
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Allow only http/https URLs in href attributes to prevent javascript: XSS
function safeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : '';
}

function parseStartParam(raw) {
    const value = String(raw || '');
    const separator = value.indexOf('_');
    if (separator <= 0 || separator === value.length - 1) return null;
    const target = value.slice(0, separator);
    if (!['review', 'place', 'gplace', 'activity', 'group', 'requests', 'tab'].includes(target)) return null;
    return { target, value: value.slice(separator + 1) };
}

async function routeStartParam(raw) {
    const route = parseStartParam(raw);
    if (!route || route.target === 'group') return;

    if (route.target === 'review') {
        const placeId = Number.parseInt(route.value, 10);
        if (Number.isInteger(placeId)) setTimeout(() => openReviewSheet(placeId), 300);
        return;
    }

    if (route.target === 'place') {
        // Navigate to saved tab — no auto-open RC
        setTimeout(() => switchTab('saved'), 250);
        return;
    }

    if (route.target === 'gplace') {
        // Navigate to discover tab — no auto-open RC
        setTimeout(() => switchTab('home'), 250);
        return;
    }

    if (route.target === 'activity') {
        switchTab('home');
        // After feed renders, scroll to and briefly highlight the target card
        const activityId = route.value;
        if (activityId) {
            const tryHighlight = (attempts) => {
                const card = document.getElementById(`fc-${activityId}`);
                if (card) {
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    card.classList.add('fc-highlight');
                    setTimeout(() => card.classList.remove('fc-highlight'), 3000);
                } else if (attempts > 0) {
                    setTimeout(() => tryHighlight(attempts - 1), 500);
                }
            };
            setTimeout(() => tryHighlight(6), 400);
        }
        return;
    }

    if (route.target === 'requests') {
        setTimeout(() => {
            switchTab('profile');
            showFriendRequests();
        }, 300);
        return;
    }

    if (route.target === 'tab') {
        const validTabs = ['home', 'saved', 'profile'];
        if (validTabs.includes(route.value)) {
            setTimeout(() => switchTab(route.value), 250);
        }
    }
}

// Track focus before opening overlays so we can restore it on close
let _prevFocusEl = null;

// Focus trap: constrain Tab/Shift+Tab within container. Returns cleanup function.
function trapFocus(container) {
    const selector = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
    function getFocusable() {
        return Array.from(container.querySelectorAll(selector))
            .filter(el => getComputedStyle(el).display !== 'none' && !el.hidden);
    }
    function onKeydown(e) {
        if (e.key !== 'Tab') return;
        const els = getFocusable();
        if (!els.length) return;
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
            if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    }
    container.addEventListener('keydown', onKeydown);
    return () => container.removeEventListener('keydown', onKeydown);
}

// Get auth headers for API requests
function getAuthHeaders() {
    const headers = {
        'ngrok-skip-browser-warning': 'true'
    };

    // Share map has no Telegram context — skip auth header
    if (!IS_SHARE_MAP && window.Telegram?.WebApp?.initData) {
        headers['X-Telegram-Init-Data'] = window.Telegram.WebApp.initData;
    }

    return headers;
}

function buildSearchUrl(query, maxResults = 10) {
    const params = new URLSearchParams({
        q: query,
        max_results: String(maxResults),
    });

    if (userLocation?.lat != null && userLocation?.lng != null) {
        params.set('lat', String(userLocation.lat));
        params.set('lng', String(userLocation.lng));
    }

    return `${API_URL}/api/search?${params.toString()}`;
}

// State
let places = [];
let allReviews = [];
let currentView = 'map';
let map = null;
let markersLayer = null;
let friendMarkersLayer = null;
let userLocationMarker = null;

// Filter state (sortBy and visitedFilter loaded from localStorage)
let searchQuery = '';
let activeCategory = '';  // Single category filter (empty = all)
// 'newest' was the old silent default — treat it as no preference → reset to 'distance'
if (localStorage.getItem('sortBy') === 'newest') localStorage.removeItem('sortBy');
let sortBy = localStorage.getItem('sortBy') || 'distance';
let visitedFilter = localStorage.getItem('visitedFilter') || 'all';  // 'all', 'visited', 'unvisited'
let countryFilter = '';  // Country filter (empty = all)
let mapCuisineFilter = '';  // Cuisine filter for map view
let ratingFilter = 0;       // 0 = any; minimum rating threshold (3 / 3.5 / 4 / 4.5)
let priceLevelFilter = '';  // '' = any; INEXPENSIVE / MODERATE / EXPENSIVE / VERY_EXPENSIVE
let openNowFilter = false;  // false = no filter; true = open now only
let searchDebounceTimer = null;

// Collections state
let collections = [];
let activeCollectionId = null;
let _collectionPlacesCache = {};  // { collectionId: [places] }

// SWR caches — show stale data instantly, refresh in background
let _feedCache = null;          // { data: activities[], ts: number }
const FEED_CACHE_TTL_MS = 60_000;
let _friendsCache = null;       // { data: friends[], ts: number }
const FRIENDS_CACHE_TTL_MS = 30_000;
let _profileCache = null;       // { data: profileData, ts: number }
const PROFILE_CACHE_TTL_MS = 60_000;

const PLACE_PRICE_LABELS = {
    INEXPENSIVE: '$',
    MODERATE: '$$',
    EXPENSIVE: '$$$',
    VERY_EXPENSIVE: '$$$$',
};

// Pagination state
let totalPlaces = 0;
let currentPlacesPage = 1;
let hasMorePlaces = false;
let isLoadingMorePlaces = false;
const PLACES_PER_PAGE = 100;

// Notes modal state
let currentEditingPlaceId = null;

// Location state
let userLocation = null;

const PLACE_PREVIEW_MIN_ZOOM = 13;
let listControlsInitialized = false;
let reviewSheetInitialized = false;
let reviewsViewInitialized = false;

// ========== DISTANCE UTILITIES ==========

// Calculate distance between two points using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in km
}

// Format distance for display
function formatDistance(km) {
    if (km < 1) return `${Math.round(km * 1000)}m`;
    return `${km.toFixed(1)}km`;
}

// Get distance from user to a place (returns null if no user location)
function getPlaceDistance(place) {
    if (!userLocation || !place.latitude || !place.longitude) return null;
    return calculateDistance(userLocation.lat, userLocation.lng, place.latitude, place.longitude);
}

// Request user location silently on app init
function requestUserLocation(centerMap = false) {
    if (!navigator.geolocation) return Promise.resolve(null);

    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                userLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };

                // Center map on user location if requested
                if (centerMap && map) {
                    map.setView([userLocation.lat, userLocation.lng], 14);
                    // Add user location marker
                    if (userLocationMarker) {
                        userLocationMarker.setLatLng([userLocation.lat, userLocation.lng]);
                    } else {
                        userLocationMarker = L.circleMarker([userLocation.lat, userLocation.lng], {
                            radius: 8,
                            fillColor: '#4285f4',
                            color: '#fff',
                            weight: 2,
                            opacity: 1,
                            fillOpacity: 1
                        }).addTo(map).bindPopup('You are here');
                    }
                }

                // Re-render with distances
                applyFilters();
                resolve(userLocation);
            },
            (error) => {
                resolve(null);
            },
            { enableHighAccuracy: true, timeout: 5000 }
        );
    });
}

// Initialize Telegram WebApp
function initTelegram() {
    if (window.Telegram && window.Telegram.WebApp) {
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand();

        // Update header for group map context
        if (IS_GROUP_MAP) {
            const h1 = document.querySelector('.app-header h1');
            if (h1) h1.textContent = '🗺️ Group Map';
        }
        // Update header for share map context
        if (IS_SHARE_MAP) {
            const h1 = document.querySelector('.app-header h1');
            if (h1) h1.textContent = '🗺️ Shared Map';
        }

        // Update CSS variables with Telegram theme
        document.documentElement.style.setProperty('--tg-viewport-height', `${tg.viewportHeight}px`);

        // Listen for viewport changes
        tg.onEvent('viewportChanged', () => {
            document.documentElement.style.setProperty('--tg-viewport-height', `${tg.viewportHeight}px`);
        });

        // Listen for theme changes
        tg.onEvent('themeChanged', applyTheme);

        return tg;
    } else {
        return null;
    }
}

// Apply light/dark theme based on Telegram or system preference
function applyTheme() {
    let theme = 'light';

    // Check Telegram colorScheme first
    if (window.Telegram?.WebApp?.colorScheme) {
        theme = window.Telegram.WebApp.colorScheme;
    } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
        // Fallback to system preference
        theme = 'dark';
    }

    document.documentElement.dataset.theme = theme;
}

// Fetch places from API with timeout and retry
async function fetchPlaces(retries = 3) {
    const TIMEOUT_MS = 10000; // 10 second timeout
    let url;
    if (GROUP_TOKEN) url = `${API_URL}/api/group-shares/${encodeURIComponent(GROUP_TOKEN)}/places?page=1&per_page=${PLACES_PER_PAGE}`;
    else if (IS_SHARE_MAP) url = `${API_URL}/api/shares/${SHARE_TOKEN}/places?page=1&per_page=${PLACES_PER_PAGE}`;
    else url = `${API_URL}/api/places?page=1&per_page=${PLACES_PER_PAGE}`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            // Create abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: getAuthHeaders()
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                const isRetriableHttpError = response.status >= 500 || response.status === 429;
                if (!isRetriableHttpError) {
                    let errorMessage = `HTTP error: ${response.status}`;
                    if (response.status === 401) {
                        errorMessage = 'Authentication failed';
                    } else if (response.status === 403) {
                        errorMessage = 'Access denied';
                    } else if (response.status === 404) {
                        errorMessage = 'API endpoint not found';
                    }

                    return {
                        success: false,
                        error: errorMessage,
                        places: []
                    };
                }
                throw new Error(`HTTP error: ${response.status}`);
            }
            const data = await response.json();
            if (IS_SHARE_MAP) {
                shareOwnerName = data.owner_name || '';
                shareOwnerUsername = data.owner_username || '';
            }
            return {
                success: true,
                places: data.places || [],
                total: data.total || 0,
                has_more: data.has_more || false,
            };
        } catch (error) {
            console.error(`Fetch attempt ${attempt} failed:`, error);

            // If this was the last attempt, return error
            if (attempt === retries) {
                const isTimeout = error.name === 'AbortError';
                return {
                    success: false,
                    error: isTimeout ? 'Request timed out' : error.message,
                    places: []
                };
            }

            // Wait before retry (exponential backoff: 1s, 2s, 4s...)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
        }
    }
}

async function loadMorePlaces() {
    if (isLoadingMorePlaces || !hasMorePlaces) return;
    isLoadingMorePlaces = true;

    const btn = document.getElementById('load-more-places-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

    const nextPage = currentPlacesPage + 1;
    try {
        let endpoint;
        if (GROUP_TOKEN) endpoint = `${API_URL}/api/group-shares/${encodeURIComponent(GROUP_TOKEN)}/places?page=${nextPage}&per_page=${PLACES_PER_PAGE}`;
        else if (IS_SHARE_MAP) endpoint = `${API_URL}/api/shares/${SHARE_TOKEN}/places?page=${nextPage}&per_page=${PLACES_PER_PAGE}`;
        else endpoint = `${API_URL}/api/places?page=${nextPage}&per_page=${PLACES_PER_PAGE}`;
        const response = await fetch(endpoint, {
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to load more');
        const data = await response.json();
        places = [...places, ...(data.places || [])];
        currentPlacesPage = nextPage;
        hasMorePlaces = data.has_more || false;
        totalPlaces = data.total || totalPlaces;
        applyFilters();
        displayPlacesOnMap();
    } catch (error) {
        console.error('Failed to load more places:', error);
        showToast('Failed to load more places');
    } finally {
        isLoadingMorePlaces = false;
    }
}

// Show loading state
function showLoading() {
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('map-view').classList.remove('active');
    document.getElementById('list-view').classList.remove('active');
    showSkeletonCards(5);
}

// Hide loading state
function hideLoading() {
    document.getElementById('loading').style.display = 'none';
    clearSkeletonCards();
}

// Show skeleton loading cards in list view
function showSkeletonCards(count = 5) {
    const container = document.getElementById('places-list');
    if (!container) return;

    container.innerHTML = '';

    for (let i = 0; i < count; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton-card';
        skeleton.innerHTML = `
            <div class="skeleton-header">
                <div class="skeleton-avatar"></div>
                <div class="skeleton-title-group">
                    <div class="skeleton-line skeleton-title"></div>
                    <div class="skeleton-line skeleton-subtitle"></div>
                </div>
            </div>
            <div class="skeleton-line skeleton-body"></div>
            <div class="skeleton-line skeleton-body short"></div>
        `;
        container.appendChild(skeleton);
    }
}

// Clear skeleton cards
function clearSkeletonCards() {
    const container = document.getElementById('places-list');
    if (!container) return;
    container.querySelectorAll('.skeleton-card').forEach(el => el.remove());
}

// Feed skeleton — shown on first load (no SWR cache yet)
function showFeedSkeletons(count = 4) {
    const list = document.getElementById('feed-list');
    if (!list) return;
    list.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const row = document.createElement('div');
        row.className = 'feed-skeleton-row';
        row.innerHTML = `
            <div class="feed-skeleton-avatar"></div>
            <div class="feed-skeleton-content">
                <div class="skeleton-line skeleton-title" style="width:70%"></div>
                <div class="skeleton-line skeleton-text" style="width:85%"></div>
                <div class="skeleton-line skeleton-text short" style="width:40%"></div>
            </div>`;
        list.appendChild(row);
    }
}

function clearFeedSkeletons() {
    const list = document.getElementById('feed-list');
    if (!list) return;
    list.querySelectorAll('.feed-skeleton-row').forEach(el => el.remove());
}

// Profile skeleton — shown on first load (no SWR cache yet)
function showProfileSkeleton() {
    const nameEl = document.getElementById('profile-display-name');
    const userEl = document.getElementById('profile-username');
    const avatarEl = document.getElementById('profile-avatar-circle');
    if (nameEl) nameEl.innerHTML = '<div class="skeleton-line skeleton-title" style="width:50%;margin:0 auto"></div>';
    if (userEl) userEl.innerHTML = '<div class="skeleton-line skeleton-text" style="width:30%;margin:0 auto"></div>';
    if (avatarEl) { avatarEl.style.backgroundImage = ''; avatarEl.textContent = ''; avatarEl.className = 'profile-skeleton-avatar'; }
    ['stat-saved', 'stat-visited', 'stat-reviews'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<div class="profile-skeleton-stat"></div>';
    });
}

function clearProfileSkeleton() {
    const avatarEl = document.getElementById('profile-avatar-circle');
    if (avatarEl && avatarEl.classList.contains('profile-skeleton-avatar')) {
        avatarEl.className = 'profile-avatar-circle';
    }
}

// Show shared map owner banner (injected below the header)
function showShareBanner() {
    if (document.getElementById('share-map-banner')) return;
    const displayName = shareOwnerUsername ? `@${shareOwnerUsername}` : (shareOwnerName || 'someone');
    const banner = document.createElement('div');
    banner.id = 'share-map-banner';
    banner.className = 'share-map-banner';
    banner.textContent = `👁 Viewing ${displayName}'s map`;
    document.querySelector('.app-header').after(banner);
}

// Show empty state
function showEmptyState() {
    const emptyState = document.getElementById('empty-state');
    if (IS_GROUP_MAP) {
        const hint = emptyState.querySelector('p') || emptyState.querySelector('.hint');
        if (hint) hint.textContent = 'Share a food video in the group and tap Save to Group Map.';
    }
    emptyState.style.display = 'flex';
    document.getElementById('map-view').classList.remove('active');
    document.getElementById('list-view').classList.remove('active');
}

// Hide empty state
function hideEmptyState() {
    document.getElementById('empty-state').style.display = 'none';
}

function ensurePlacesUiInitialized() {
    hideEmptyState();

    if (!listControlsInitialized) {
        setupListControls();
        listControlsInitialized = true;
    }

    setupNotesModal();

    if (!reviewSheetInitialized) {
        setupReviewSheet();
        reviewSheetInitialized = true;
    }

    if (!reviewsViewInitialized) {
        setupReviewsView();
        reviewsViewInitialized = true;
    }

}

// Show error state
function showErrorState(errorMessage) {
    document.getElementById('error-state').style.display = 'flex';
    document.getElementById('error-message').textContent = errorMessage || 'Please check your connection and try again.';
    document.getElementById('map-view').classList.remove('active');
    document.getElementById('list-view').classList.remove('active');

    // Setup retry button
    const retryBtn = document.getElementById('btn-retry');
    retryBtn.onclick = () => {
        hideErrorState();
        retryFetchPlaces();
    };
}

// Hide error state
function hideErrorState() {
    document.getElementById('error-state').style.display = 'none';
}

// Retry fetching places
async function retryFetchPlaces() {
    showLoading();

    setupSearchModal();

    const fetchResult = await fetchPlaces();

    hideLoading();

    if (!fetchResult.success) {
        showErrorState(fetchResult.error);
        return;
    }

    places = fetchResult.places;
    totalPlaces = fetchResult.total || 0;
    hasMorePlaces = fetchResult.has_more || false;
    currentPlacesPage = 1;

    if (places.length === 0) {
        showEmptyState();
        return;
    }

    // Display places
    displayPlacesOnMap(true);
    setupListControls();
    setupNotesModal();
    setupSearchModal();
    renderPlacesList(places);
    switchView('map');
}

// Initialize Leaflet map
function initMap() {
    // Create map centered at [0, 0] with low zoom (will fit bounds later)
    map = L.map('map', {
        zoomControl: false,  // We have custom controls
        attributionControl: false,  // Cleaner look
        closePopupOnClick: true
    }).setView([0, 0], 2);

    // Use CartoDB Voyager tiles (cute, colorful, clean)
    L.tileLayer('https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=cb1_2dip_1_a547affd6e732c636841df27', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 20
    }).addTo(map);

    // Plain layer group — no clustering, markers always visible
    markersLayer = L.layerGroup().addTo(map);

    // Friend activity layer — separate from user's own markers
    friendMarkersLayer = L.layerGroup().addTo(map);

    let _zoomEndTimer = null;
    map.on('zoomend', () => {
        updatePlacePreviewVisibility();
        // Debounce marker icon updates — zoomend fires multiple times during animation
        clearTimeout(_zoomEndTimer);
        _zoomEndTimer = setTimeout(updateMarkerIconSizes, 150);
    });
    updatePlacePreviewVisibility();

    return map;
}


function truncatePreviewText(text, maxLength = 48) {
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}


function createMarkerPreviewContent(place) {
    const review = getPlaceReview(place.id);
    const text = place.notes || review?.caption || review?.overall_remarks || null;
    if (!text) return '';

    return `
        <div class="place-preview-bubble">
            <div class="place-preview-text">${truncatePreviewText(text, 56)}</div>
        </div>
    `;
}


function updatePlacePreviewVisibility() {
    if (!map) return;

    const container = map.getContainer();
    const currentZoom = map.getZoom();
    const shouldShow = currentZoom >= PLACE_PREVIEW_MIN_ZOOM;
    container.classList.toggle('show-place-previews', shouldShow);
}

// Format place types for display (title case, first 2)
function formatPlaceTypes(typesString) {
    if (!typesString) return '';
    let rawTypes;
    if (typeof typesString === 'string' && typesString.trim().startsWith('[')) {
        try { rawTypes = JSON.parse(typesString); } catch { rawTypes = []; }
    } else if (Array.isArray(typesString)) {
        rawTypes = typesString;
    } else {
        rawTypes = typesString.split(',');
    }
    const types = rawTypes
        .slice(0, 2)
        .map(t => String(t).trim().replace(/_/g, ' '))
        .map(t => t.charAt(0).toUpperCase() + t.slice(1));
    return types.join(', ');
}

// Create popup content for a place
function createPopupContent(place) {
    const review = getPlaceReview(place.id);
    // Treat as visited if there's a review OR if place is marked visited (no review row needed)
    const isReviewed = !!review || !!place.is_visited;
    const photos = review?.overall_photos || [];

    let html = `<div class="place-popup ${isReviewed ? 'place-popup--reviewed' : 'place-popup--new'}" data-place-id="${place.id}">`;

    // ── Photo carousel — matches discovery feed style ───────────────────────
    if (photos.length > 0) {
        const slides = photos.map((p, i) =>
            `<div class="popup-photo-slide"><img class="popup-photo-slide-img" src="${safeUrl(p.url)}" alt="" loading="lazy"></div>`
        ).join('');
        html += `<div class="popup-photo-carousel-wrap"><div class="popup-photo-carousel">${slides}</div></div>`;
    }

    html += `<div class="popup-body">`;

    // ── Name (hero) ────────────────────────────────────────────────────────
    html += `<div class="place-popup-name">${escapeHtml(place.name)}</div>`;

    if (isReviewed) {
        // ── VISITED: user memory first ────────────────────────────────

        // Subtitle: type · price · visit date
        const revTypes = formatPlaceTypes(place.place_types);
        const revPrice = place.place_price_level && PLACE_PRICE_LABELS[place.place_price_level]
            ? PLACE_PRICE_LABELS[place.place_price_level] : '';
        const revDate = place.visited_at ? formatShortDate(place.visited_at) : '';
        const revSubtitle = [revTypes, revPrice, revDate].filter(Boolean).join(' · ');
        if (revSubtitle) {
            html += `<div class="popup-info-row popup-info-muted">${revSubtitle}</div>`;
        }

        // ── Compulsory group ──────────────────────────────────────────
        // Sentiment + overall score badge
        if (review?.sentiment || review) {
            const pfs = review?.food_score ?? null, pvs = review?.vibe_score ?? null, pls = review?.value_score ?? null;
            const pScores = [pfs, pvs, pls].filter(s => s != null);
            const pOverall = pScores.length ? (pScores.reduce((a,b)=>a+b,0)/pScores.length).toFixed(1) : null;
            const pScClass = pOverall ? (parseFloat(pOverall) >= 8 ? 'score-high' : parseFloat(pOverall) >= 6 ? 'score-mid' : 'score-low') : '';
            const sentEmoji = SENTIMENT_EMOJI[review?.sentiment] || '';
            const sentLabel = { loved: 'Loved it', okay: 'It was okay', meh: 'Meh' }[review?.sentiment] || '';
            if (sentLabel || pOverall) {
                html += `<div class="popup-sentiment-row">${sentLabel ? `<span class="popup-sent-chip ${review?.sentiment}">${sentEmoji} ${sentLabel}</span>` : ''}${pOverall ? `<span class="popup-sent-overall ${pScClass}">${pOverall}</span>` : ''}</div>`;
            }
        }

        // Sub-scores: Food · Vibe · Value
        if (review && (review.food_score != null || review.vibe_score != null || review.value_score != null)) {
            html += `<div class="popup-scores">`;
            if (review.food_score != null) html += `<span class="popup-score-chip">🍽 Food <b>${review.food_score}</b></span>`;
            if (review.vibe_score != null) html += `<span class="popup-score-chip">🎵 Vibe <b>${review.vibe_score}</b></span>`;
            if (review.value_score != null) html += `<span class="popup-score-chip">💰 Value <b>${review.value_score}</b></span>`;
            html += `</div>`;
        }

        // ── Optional group ────────────────────────────────────────────
        // Dish chips with score coloring
        const dishes = review?.dishes || [];
        if (dishes.length > 0) {
            const MAX_VISIBLE = 3;
            const visible = dishes.slice(0, MAX_VISIBLE);
            const overflow = dishes.length - MAX_VISIBLE;
            html += `<div class="popup-dishes">`;
            visible.forEach(d => {
                const sc = d.rating != null ? (d.rating >= 8 ? 'dish-high' : d.rating >= 5 ? 'dish-mid' : 'dish-low') : '';
                const scoreSpan = d.rating != null ? `<span class="popup-dish-score ${sc}">${d.rating}</span>` : '';
                html += `<span class="popup-dish-chip ${sc}">${escapeHtml(d.name)}${scoreSpan}</span>`;
            });
            if (overflow > 0) {
                html += `<span class="popup-dish-chip popup-dish-chip--more">+${overflow}</span>`;
            }
            html += `</div>`;
        }

        // Caption below dishes, with quotes
        const caption = review ? (review.caption || review.overall_remarks || '') : '';
        if (caption) {
            html += `<div class="popup-caption">"${escapeHtml(caption)}"</div>`;
        }

        // Primary CTA
        if (!IS_SHARE_MAP) {
            html += `<button class="popup-primary-btn" onclick="openRestaurantCard(${place.id})">View</button>`;
        }

    } else {
        // ── WANT TO GO: help them decide to go ───────────────────────

        // Type · price subtitle
        const wtgTypes = formatPlaceTypes(place.place_types);
        const wtgPrice = place.place_price_level && PLACE_PRICE_LABELS[place.place_price_level]
            ? PLACE_PRICE_LABELS[place.place_price_level] : '';
        const wtgSubtitle = [wtgTypes, wtgPrice].filter(Boolean).join(' · ');
        if (wtgSubtitle) {
            html += `<div class="popup-info-row popup-info-muted">${wtgSubtitle}</div>`;
        }

        // Google rating (social proof)
        if (place.place_rating) {
            const cnt = place.place_rating_count
                ? ` (${Number(place.place_rating_count).toLocaleString()})` : '';
            html += `<div class="popup-info-row popup-info-muted">⭐ ${place.place_rating}${cnt}</div>`;
        }

        // Description — the hook (why they saved it)
        if (place.place_description) {
            html += `<div class="popup-caption">${escapeHtml(place.place_description)}</div>`;
        }

        // Opening hours (is it open now?)
        html += buildPopupHoursHtml(place);

        // Distance
        const dist = getPlaceDistance(place);
        if (dist !== null) {
            html += `<div class="popup-info-row popup-info-muted">🗺 ${formatDistance(dist)} away</div>`;
        }

        // Primary CTA
        if (!IS_SHARE_MAP) {
            html += `<button class="popup-primary-btn" onclick="openRestaurantCard(${place.id})">View</button>`;
        }
    }

    // ── Secondary actions row: Maps · Reel · Delete ────────────────────────
    const secParts = [];

    if (place.google_place_id) {
        const encodedName = encodeURIComponent(place.name);
        secParts.push(`<a href="https://www.google.com/maps/search/?api=1&query=${encodedName}&query_place_id=${place.google_place_id}" target="_blank" class="popup-sec-btn">📍 Maps</a>`);
    } else if (place.latitude && place.longitude) {
        secParts.push(`<a href="https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}" target="_blank" class="popup-sec-btn">📍 Maps</a>`);
    }
    if (place.source_url) {
        secParts.push(`<a href="${safeUrl(place.source_url)}" target="_blank" class="popup-sec-btn">▶️ Reel</a>`);
    }
    if (!IS_SHARE_MAP) {
        const escapedName = place.name.replace(/'/g, "\'").replace(/"/g, "&quot;");
        secParts.push(`<button class="popup-sec-btn popup-sec-btn--delete" onclick="confirmDeletePlace(${place.id}, '${escapedName}')">Delete</button>`);
    }

    if (secParts.length) {
        html += `<div class="popup-secondary-actions">${secParts.join('')}</div>`;
    }

    html += `</div>`; // popup-body
    html += `</div>`;
    return html;
}


// Toggle visited status from popup
async function toggleVisited(placeId) {
    const place = places.find(p => p.id === placeId);
    if (!place) return;
    const newVisited = !place.is_visited;
    if (!newVisited && getPlaceReview(placeId)) {
        const ok = confirm(`Unmark "${place.name}" as visited?\n\nYour review will also be deleted. To edit your review instead, tap ✍️ on the card.`);
        if (!ok) return;
        await deleteReviewForPlace(placeId);
    }
    updatePlaceVisited(placeId, newVisited, true);
}

// Update a marker's popup content in-place without closing it
function updateMarkerPopup(placeId, place) {
    markersLayer.eachLayer(marker => {
        if (marker.placeData && marker.placeData.id === placeId) {
            // Update marker data reference
            marker.placeData = place;
            // Update marker icon using current zoom
            const zoom = map ? map.getZoom() : 15;
            marker.setIcon(getMarkerIconForZoom(zoom, place));
            // Update popup content
            marker.setPopupContent(createPopupContent(place));
            syncMarkerPreviewTooltip(marker, place);
        }
    });
}

// Start inline note editing in popup
function startPopupNoteEdit(placeId, container) {
    const place = places.find(p => p.id === placeId);
    if (!place) return;

    // Replace container content with textarea
    const currentNotes = place.notes || '';
    container.innerHTML = `
        <textarea class="inline-notes-input" placeholder="What did you think? Any must-try dishes?">${currentNotes}</textarea>
        <div class="inline-notes-actions">
            <button class="inline-notes-cancel" onclick="event.stopPropagation(); cancelPopupNoteEdit(${placeId})">Cancel</button>
            <button class="inline-notes-save" onclick="event.stopPropagation(); savePopupNote(${placeId})">Save</button>
        </div>
    `;
    container.classList.add('editing');
    container.classList.remove('has-notes', 'empty');

    // Focus the textarea
    const textarea = container.querySelector('textarea');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Handle keyboard shortcuts
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            cancelPopupNoteEdit(placeId);
        } else if (e.key === 'Enter' && e.metaKey) {
            savePopupNote(placeId);
        }
    });
}

// Cancel popup note editing - refresh the popup
function cancelPopupNoteEdit(placeId) {
    const place = places.find(p => p.id === placeId);
    if (place) {
        updateMarkerPopup(placeId, place);
    }
}

// Save popup note
function savePopupNote(placeId) {
    const popup = document.querySelector(`.place-popup[data-place-id="${placeId}"]`);
    if (!popup) return;

    const textarea = popup.querySelector('.inline-notes-input');
    if (!textarea) return;

    const saveBtn = popup.querySelector('.inline-notes-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

    const notes = textarea.value.trim();
    updatePlaceNotes(placeId, notes).finally(() => {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    });
}



function getPopupFocusedLatLng(latlng, zoom = 15) {
    // Shift the map center upward so the popup card sits on-screen.
    const verticalOffset = 140;
    const projected = map.project(L.latLng(latlng), zoom);
    return map.unproject([projected.x, projected.y - verticalOffset], zoom);
}


let _mapViewBeforeRc = null; // saved zoom/center before RC zoom-in

function focusMarkerWithPopup(marker, latlng, zoom = 15) {
    if (!map || !marker) return;

    // Save current view so closeRestaurantCard can restore it
    _mapViewBeforeRc = { center: map.getCenter(), zoom: map.getZoom() };

    const targetCenter = getPopupFocusedLatLng(latlng, zoom);
    map.setView(targetCenter, zoom, { animate: true });
    setTimeout(() => marker.openPopup(), 220);
}

function getSpeechBubbleOffset(zoom, place) {
    // Position tip ~1px above the top of the marker at any zoom tier
    const isUnvisited = place && !place.is_visited;
    const sz = isUnvisited
        ? (zoom < 15 ? 26 : zoom < 18 ? 35 : 46)
        : (zoom < 15 ? 30 : zoom < 18 ? 40 : 52);
    return [0, -(sz / 2 + 1)];
}

function syncMarkerPreviewTooltip(marker, place) {
    if (!marker) return;

    const review = getPlaceReview(place.id);
    const hasContent = place.notes || review?.caption || review?.overall_remarks;
    if (hasContent) {
        const tooltipContent = createMarkerPreviewContent(place);
        const zoom = map ? map.getZoom() : 13;
        // Always rebind so offset stays correct after zoom changes
        if (marker.getTooltip()) marker.unbindTooltip();
        marker.bindTooltip(tooltipContent, {
            permanent: true,
            direction: 'top',
            offset: getSpeechBubbleOffset(zoom, place),
            className: 'place-preview-tooltip'
        });
    } else if (marker.getTooltip()) {
        marker.unbindTooltip();
    }
}

// Compute a 1–10 place score from a review object.
// Weights: food 40%, vibe 30%, value 30% + sentiment nudge (±0.5).
// Falls back to sentiment-only, then overall_rating (legacy), or null.
function computePlaceScore(review) {
    if (!review) return null;
    const { food_score, vibe_score, value_score, sentiment, overall_rating } = review;
    const nudge = { loved: 0.5, okay: 0, meh: -0.5 }[sentiment] ?? 0;

    const hasFood  = food_score  != null;
    const hasVibe  = vibe_score  != null;
    const hasValue = value_score != null;

    let base;
    if (hasFood && hasVibe && hasValue) {
        base = food_score * 0.4 + vibe_score * 0.3 + value_score * 0.3;
    } else if (hasFood || hasVibe || hasValue) {
        const raw = [food_score, vibe_score, value_score].filter(v => v != null);
        base = raw.reduce((a, b) => a + b, 0) / raw.length;
    } else if (sentiment) {
        // Sentiment-only (no dimension scores)
        const fallback = { loved: 8.5, okay: 6.0, meh: 3.5 };
        return fallback[sentiment] ?? null;
    } else if (overall_rating != null) {
        // Legacy reviews: overall_rating is 1–5 (5=loved, 3=okay, 1=meh) → scale to 1–10
        return Math.round(overall_rating * 2 * 10) / 10;
    } else {
        return null;
    }
    return Math.round(Math.min(10, Math.max(1, base + nudge)) * 10) / 10;
}

function scoreMarkerColor(score) {
    if (score >= 8.0) return '#7CB98E';  // sprout green
    if (score >= 6.0) return '#F5A94A';  // amber
    return '#E06060';                    // coral
}

// Return marker icon for a place at the given zoom level.
// zoom < 10     → tiny dot (dark green = unvisited, score color = visited)
// zoom 10–14   → medium circle / score badge (36px)
// zoom >= 15   → large circle / score badge (44px)
function getMarkerIconForZoom(zoom, place) {
    const isVisited = place.is_visited;
    const score = isVisited ? computePlaceScore(getPlaceReview(place.id)) : null;

    if (zoom < 10) {
        const bg = !isVisited ? '#1E3A2B' : (score !== null ? scoreMarkerColor(score) : '#7CB98E');
        return L.divIcon({
            className: '',
            html: `<div class="marker-dot" style="background:${bg};border:2px solid ${bg};box-sizing:border-box"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6],
            popupAnchor: [0, -6]
        });
    }

    // Three size tiers: far / mid / close
    const sz   = zoom < 15 ? 30 : zoom < 18 ? 40 : 52;

    if (score !== null) {
        // Visited + reviewed → colored score circle
        const bg = scoreMarkerColor(score);
        const fs = zoom < 15 ? 11 : zoom < 18 ? 14 : 17;
        return L.divIcon({
            className: '',
            html: `<div class="score-marker" style="width:${sz}px;height:${sz}px;background:${bg};font-size:${fs}px">${score.toFixed(1)}</div>`,
            iconSize: [sz, sz],
            iconAnchor: [sz / 2, sz / 2],
            popupAnchor: [0, -(sz / 2 + 2)]
        });
    }

    // Visited (no review) → filled dot with ✓; Unvisited → sprout character icon
    const iconSz = zoom < 15 ? 9 : zoom < 18 ? 12 : 15;

    if (isVisited) {
        // Green filled circle with white checkmark
        const innerHtml = `<div class="score-marker-dot" style="width:${sz}px;height:${sz}px;background:#7CB98E;border:2px solid #5a9a70;box-sizing:border-box;display:flex;align-items:center;justify-content:center;">
            <svg width="${iconSz}" height="${iconSz}" viewBox="0 0 10 10" fill="none">
                <polyline points="2,5 4.5,7.5 8,3" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>`;
        return L.divIcon({
            className: '',
            html: innerHtml,
            iconSize: [sz, sz],
            iconAnchor: [sz / 2, sz / 2],
            popupAnchor: [0, -(sz / 2 + 2)]
        });
    } else {
        // White circle with sprout emoji — one size tier smaller than visited
        const usz = zoom < 15 ? 26 : zoom < 18 ? 35 : 46;
        const emojiFontSz = Math.round(usz * 0.55);
        const innerHtml = `<div class="score-marker-dot" style="width:${usz}px;height:${usz}px;background:white;border:2px solid #A8D58A;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:${emojiFontSz}px;line-height:1;">🌱</div>`;
        return L.divIcon({
            className: '',
            html: innerHtml,
            iconSize: [usz, usz],
            iconAnchor: [usz / 2, usz / 2],
            popupAnchor: [0, -(usz / 2 + 2)]
        });
    }
}

// Update all existing marker icons to match current zoom
function updateMarkerIconSizes() {
    if (!map || !markersLayer) return;
    const zoom = map.getZoom();
    markersLayer.getLayers().forEach(marker => {
        if (marker.placeData) {
            marker.setIcon(getMarkerIconForZoom(zoom, marker.placeData));
            syncMarkerPreviewTooltip(marker, marker.placeData);
        }
    });
}

// Add markers for all places
function displayPlacesOnMap(fitBounds = true) {
    if (!map || !markersLayer) return;

    // Clear existing markers
    markersLayer.clearLayers();

    // Filter places based on visited filter and cuisine
    // Skip visited filter when Open Now is active (show all places that are open now)
    let filteredPlaces = openNowFilter ? [...places] : filterPlacesByVisited(places);

    // Apply cuisine filter for map
    if (mapCuisineFilter) {
        filteredPlaces = filteredPlaces.filter(p => {
            const category = getPrimaryCategory(p.place_types);
            return category === mapCuisineFilter;
        });
    }

    // Apply collection filter for map
    if (activeCollectionId) {
        const col = _collectionPlacesCache[activeCollectionId];
        if (col) {
            const gids = new Set(col.map(p => p.google_place_id).filter(Boolean));
            filteredPlaces = filteredPlaces.filter(p => p.google_place_id && gids.has(p.google_place_id));
        }
    }

    // Apply open now filter for map
    filteredPlaces = filterByOpenNow(filteredPlaces);

    // Update collection dropdown options
    populateCollectionsDropdown();

    if (filteredPlaces.length === 0) {
        // No places - show world view or stay at user location
        if (!userLocation) {
            map.setView([20, 0], 2);
        }
        return;
    }

    const zoom = map.getZoom();

    // Add marker for each place, sized for current zoom
    filteredPlaces.forEach(place => {
        if (place.latitude && place.longitude) {
            const icon = getMarkerIconForZoom(zoom, place);
            const marker = L.marker([place.latitude, place.longitude], { icon });
            marker.placeData = place;

            // Zoom to marker on click, then show popup
            marker.on('click', function(e) {
                focusMarkerWithPopup(marker, e.latlng, 16);
            });

            // Bind popup with place details — lazy so review state is read at click time
            marker.bindPopup(function() {
                return createPopupContent(place);
            }, {
                maxWidth: 280,
                className: 'custom-popup'
            });

            syncMarkerPreviewTooltip(marker, place);

            markersLayer.addLayer(marker);
        }
    });

    // Fit map to show all markers only if requested
    if (fitBounds && markersLayer.getLayers().length > 0) {
        const bounds = L.latLngBounds(
            markersLayer.getLayers()
                .filter(m => m.getLatLng)
                .map(m => m.getLatLng())
        );
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
    }

    updatePlacePreviewVisibility();
}

// Debounced map render — use in filter handlers to avoid O(n) marker recreation per rapid click.
// Keep direct displayPlacesOnMap() for data-mutation callers (save, review, fetch).
let _mapRenderTimer = null;
function debouncedDisplayPlacesOnMap(fitBounds = false) {
    clearTimeout(_mapRenderTimer);
    _mapRenderTimer = setTimeout(() => displayPlacesOnMap(fitBounds), 100);
}

// Populate cuisine select from available places
function populateCuisineDropdown() {
    const select = document.getElementById('map-cuisine-filter');
    const wrap = document.getElementById('map-cuisine-wrap');
    if (!select || !wrap) return;

    const cuisines = new Set();
    places.forEach(p => {
        const category = getPrimaryCategory(p.place_types);
        if (category) cuisines.add(category);
    });

    // Hide if no cuisine data
    if (cuisines.size === 0) {
        wrap.style.display = 'none';
        return;
    }

    wrap.style.display = '';

    const currentValue = select.value;
    select.innerHTML = '<option value="">All types</option>';
    Array.from(cuisines).sort().forEach(cuisine => {
        const option = document.createElement('option');
        option.value = cuisine;
        option.textContent = cuisine.charAt(0).toUpperCase() + cuisine.slice(1);
        select.appendChild(option);
    });

    // Restore selection if still valid
    if (currentValue && cuisines.has(currentValue)) {
        select.value = currentValue;
    }
}

function populateCollectionsDropdown() {
    const select = document.getElementById('map-collection-filter');
    const wrap = document.getElementById('map-collection-wrap');
    if (!select || !wrap) return;
    if (!collections.length) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';
    const currentValue = select.value;
    select.innerHTML = '<option value="">All places</option>';
    collections.forEach(c => {
        const option = document.createElement('option');
        option.value = c.id;
        option.textContent = `${c.emoji || '📍'} ${c.name}`;
        if (currentValue && currentValue == c.id) option.selected = true;
        select.appendChild(option);
    });
}

function onMapCollectionChange(val) {
    activeCollectionId = val ? parseInt(val) : null;
    if (activeCollectionId && !_collectionPlacesCache[activeCollectionId]) {
        _fetchCollectionPlaces(activeCollectionId).then(() => displayPlacesOnMap(false));  // direct: after data fetch
    } else {
        debouncedDisplayPlacesOnMap(false);  // filter change: debounced
    }
}

// Extract country from address
function extractCountry(address) {
    if (!address) return null;

    // Common country names to look for
    const countries = [
        'Singapore', 'Malaysia', 'Thailand', 'Indonesia', 'Vietnam', 'Philippines',
        'Japan', 'South Korea', 'Korea', 'China', 'Hong Kong', 'Taiwan', 'India',
        'Australia', 'New Zealand', 'United States', 'USA', 'UK', 'United Kingdom',
        'France', 'Germany', 'Italy', 'Spain', 'Netherlands', 'Belgium', 'Switzerland',
        'Canada', 'Mexico', 'Brazil', 'Argentina', 'UAE', 'Dubai', 'Saudi Arabia'
    ];

    // Check if any country name appears in the address
    const addressLower = address.toLowerCase();
    for (const country of countries) {
        if (addressLower.includes(country.toLowerCase())) {
            return country;
        }
    }

    // Fallback: try last non-numeric part
    const parts = address.split(',').map(p => p.trim());
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i].replace(/\d+/g, '').trim();
        if (part && part.length > 2 && !/^\d+$/.test(parts[i])) {
            return part;
        }
    }

    return null;
}

// Render country filter chips
function renderCountryChips() {
    const container = document.getElementById('country-filter');
    if (!container) return;

    // Get unique countries
    const countries = new Set();
    places.forEach(p => {
        const country = extractCountry(p.address);
        if (country) countries.add(country);
    });

    // Only show if there are countries to filter
    if (countries.size === 0) {
        container.innerHTML = '';
        return;
    }

    // Build chips HTML
    let html = `<button class="country-chip${countryFilter === '' ? ' active' : ''}" data-country="">All</button>`;
    Array.from(countries).sort().forEach(country => {
        const isActive = countryFilter === country ? ' active' : '';
        html += `<button class="country-chip${isActive}" data-country="${country}">${country}</button>`;
    });

    container.innerHTML = html;

    // Add click handlers
    container.querySelectorAll('.country-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            container.querySelectorAll('.country-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            countryFilter = chip.dataset.country;
            applyFilters();
            debouncedDisplayPlacesOnMap(false);
        });
    });
}

// Filter places by country
function filterPlacesByCountry(placesToFilter) {
    if (!countryFilter) return placesToFilter;
    return placesToFilter.filter(p => extractCountry(p.address) === countryFilter);
}

// Filter places by visited status
function filterPlacesByVisited(placesToFilter) {
    switch (visitedFilter) {
        case 'visited':
            return placesToFilter.filter(p => p.is_visited);
        case 'unvisited':
            return placesToFilter.filter(p => !p.is_visited);
        default:
            return placesToFilter;
    }
}


// Show toast message (optionally with retry button)
function showToast(message, retryFn = null, duration = null) {
    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';

    if (retryFn) {
        // Toast with retry button
        toast.innerHTML = `
            <span class="toast-message">${message}</span>
            <button class="toast-retry-btn">Retry</button>
        `;
        toast.querySelector('.toast-retry-btn').onclick = () => {
            toast.remove();
            retryFn();
        };
    } else {
        toast.textContent = message;
    }

    document.body.appendChild(toast);

    // Animate in
    setTimeout(() => toast.classList.add('show'), 10);

    // Remove after 3 seconds (5 seconds if has retry, or custom duration)
    const toastDuration = duration ?? (retryFn ? 5000 : 3000);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, toastDuration);
}

// Show success animation overlay
function showSuccessAnimation() {
    const overlay = document.createElement('div');
    overlay.className = 'success-overlay';
    overlay.innerHTML = `
        <div class="success-checkmark">
            <svg viewBox="0 0 52 52">
                <circle cx="26" cy="26" r="25" fill="none" stroke="currentColor" stroke-width="2"/>
                <path fill="none" stroke="currentColor" stroke-width="3" d="M14 27l7 7 16-16"/>
            </svg>
        </div>
    `;
    document.body.appendChild(overlay);

    // Trigger animation
    requestAnimationFrame(() => overlay.classList.add('show'));

    // Remove after animation
    setTimeout(() => {
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 300);
    }, 1200);

    hapticFeedback('medium');
}


// Fit map to show all places
function fitAllPlaces() {
    if (!map || !markersLayer) return;

    const layers = markersLayer.getLayers();
    if (layers.length === 0) {
        showToast("No places to show");
        return;
    }

    const bounds = markersLayer.getBounds();
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    showToast(`Showing all ${layers.length} places`);
}

// Setup map control buttons
function setupMapControls() {
// Map filter chips (visited/unvisited)
    const mapFilterChips = document.querySelectorAll('.map-filter-chip');
    mapFilterChips.forEach(chip => {
        if (!chip.dataset.filter) return;
        chip.addEventListener('click', () => {
            const filter = chip.dataset.filter;
            mapFilterChips.forEach(c => { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
            chip.classList.add('active');
            chip.setAttribute('aria-pressed', 'true');

            if (filter === 'open-now') {
                // Open Now: show all places open now regardless of visited state
                openNowFilter = true;
            } else {
                // Visited/All/To Visit: clear Open Now
                openNowFilter = false;
                visitedFilter = filter;
                localStorage.setItem('visitedFilter', filter);
                document.querySelectorAll('.visited-chip').forEach(c => {
                    const isActive = c.dataset.filter === filter;
                    c.classList.toggle('active', isActive);
                    c.setAttribute('aria-pressed', String(isActive));
                });
            }
            applyFilters();
            debouncedDisplayPlacesOnMap(false);
        });
    });

    // Cuisine type filter
    const cuisineSelect = document.getElementById('map-cuisine-filter');
    if (cuisineSelect) {
        cuisineSelect.addEventListener('change', (e) => {
            mapCuisineFilter = e.target.value;
            debouncedDisplayPlacesOnMap(false);
        });
    }
}

// Get platform icon/emoji
function getPlatformIcon(platform) {
    switch (platform?.toLowerCase()) {
        case 'instagram': return '📸';
        case 'tiktok': return '🎵';
        case 'youtube': return '▶️';
        default: return '🔗';
    }
}

// Get primary category from place types
function getPrimaryCategory(typesString) {
    if (!typesString) return null;
    const firstType = typesString.split(',')[0].trim();
    return firstType.replace(/_/g, ' ');
}

// Create a place card element
function createPlaceCard(place) {
    const card = document.createElement('div');
    card.className = 'place-card' + (place.is_visited ? ' visited' : '');
    card.dataset.placeId = place.id;

    // Sprout icon (visited=happy, unvisited=before-sprout)
    const sproutImg = place.is_visited ? '/images/sprout-happy.png' : '/images/sprout-before-sprout.png';

    // Header with sprout icon, name, and more button
    let headerHtml = `<div class="place-card-header">`;
    headerHtml += `<span class="sprout-icon"><img src="${sproutImg}" alt="${place.is_visited ? 'Visited' : 'To visit'}"></span>`;
    // Add review badge if exists (personal map only)
    const review = (IS_GROUP_MAP || IS_SHARE_MAP) ? null : getPlaceReview(place.id);
    const reviewBadge = review
        ? `<span class="place-review-badge">${SENTIMENT_EMOJI[review.sentiment] || '✍️'}</span>`
        : '';
    headerHtml += `<span class="place-card-name">${escapeHtml(place.name)} ${reviewBadge}</span>`;
    if (!IS_GROUP_MAP && !IS_SHARE_MAP) {
        headerHtml += `<button class="more-btn" onclick="event.stopPropagation(); openPlaceMenu(${place.id}, '${place.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')" aria-label="More options">···</button>`;
    }
    headerHtml += `</div>`;

    // Address
    let addressHtml = '';
    if (place.address) {
        addressHtml = `<div class="place-card-address">${escapeHtml(place.address)}</div>`;
    }

    // Description (editorial summary)
    let descriptionHtml = '';
    if (place.place_description) {
        descriptionHtml = `<div class="place-description">${escapeHtml(place.place_description)}</div>`;
    }

    // Meta row: rating, price level, and types
    let metaHtml = '<div class="place-card-meta">';
    if (place.place_rating) {
        const count = place.place_rating_count ? ` (${place.place_rating_count})` : '';
        metaHtml += `<span class="place-card-rating">⭐ ${place.place_rating}${count}</span>`;
    }
    if (place.place_price_level && PLACE_PRICE_LABELS[place.place_price_level]) {
        metaHtml += `<span class="place-card-price">${PLACE_PRICE_LABELS[place.place_price_level]}</span>`;
    }
    const types = formatPlaceTypes(place.place_types);
    if (types) {
        metaHtml += `<span class="place-card-types">${types}</span>`;
    }
    metaHtml += '</div>';

    // Attribution + vote count (group map only)
    let attributionHtml = '';
    if (IS_GROUP_MAP) {
        const byLine = place.saved_by ? `Added by ${escapeHtml(place.saved_by)}` : '';
        const voterNames = (place.voters || []).join(', ');
        const votes = place.vote_count > 0
            ? `👍 ${place.vote_count}${voterNames ? ` (${escapeHtml(voterNames)})` : ''}`
            : '';
        const parts = [byLine, votes].filter(Boolean).join(' · ');
        if (parts) attributionHtml = `<div class="place-attribution">${parts}</div>`;
    }

    // Distance row (no visited toggle — moved to been-here-btn in actions)
    const distance = getPlaceDistance(place);
    const distanceText = distance !== null ? `<span class="place-card-distance">📍 ${formatDistance(distance)} away</span>` : '';
    const distanceHtml = distanceText ? `<div class="place-card-distance-row">${distanceText}</div>` : '';

    const notesHtml = '';

    // Reviews section (group map and share map)
    let reviewsHtml = '';
    if (IS_GROUP_MAP) {
        reviewsHtml = `<div class="group-reviews-section" data-place-id="${place.id}" data-loaded="false">
            <div class="group-reviews-toggle" onclick="event.stopPropagation(); toggleGroupReviews(this, ${place.id})">📝 Reviews</div>
            <div class="group-reviews-list"></div>
        </div>`;
    } else if (IS_SHARE_MAP) {
        reviewsHtml = `<div class="group-reviews-section" data-place-id="${place.id}" data-loaded="false">
            <div class="group-reviews-toggle" onclick="event.stopPropagation(); toggleShareReviews(this, ${place.id})">📝 Reviews</div>
            <div class="group-reviews-list"></div>
        </div>`;
    }

    // Been here button (personal map only)
    let beenHereHtml = '';
    if (!IS_GROUP_MAP && !IS_SHARE_MAP) {
        const beenClass = place.is_visited ? ' active' : '';
        const beenText = place.is_visited ? 'Been here ✓' : 'Been here?';
        beenHereHtml = `<button class="been-here-btn${beenClass}" onclick="event.stopPropagation(); openBeenHereSheet(${place.id})">${beenText}</button>`;
    } else if (IS_SHARE_MAP && place.is_visited) {
        beenHereHtml = `<button class="been-here-btn active" style="pointer-events:none">Been here ✓</button>`;
    }

    // Action buttons (Maps, Reel, Share)
    let actionsHtml = '<div class="place-card-actions">';

    // Google Maps link
    if (place.google_place_id) {
        const encodedName = encodeURIComponent(place.name);
        actionsHtml += `<a href="https://www.google.com/maps/search/?api=1&query=${encodedName}&query_place_id=${place.google_place_id}"
                          target="_blank" class="card-action-btn external-btn" onclick="event.stopPropagation()" aria-label="Open in Google Maps">📍 Maps</a>`;
    } else if (place.latitude && place.longitude) {
        actionsHtml += `<a href="https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}"
                          target="_blank" class="card-action-btn external-btn" onclick="event.stopPropagation()" aria-label="Open in Google Maps">📍 Maps</a>`;
    }

    // Original reel link
    if (place.source_url) {
        actionsHtml += `<a href="${safeUrl(place.source_url)}" target="_blank" class="card-action-btn external-btn" onclick="event.stopPropagation()" aria-label="View original reel">▶️ Reel</a>`;
    }

    // Share button (not shown when viewing someone else's map)
    if (!IS_SHARE_MAP) {
        actionsHtml += `<button class="card-action-btn share-btn" onclick="event.stopPropagation(); sharePlace(${place.id})" aria-label="Share this place">↗ Share</button>`;
    }

    actionsHtml += '</div>';

    card.innerHTML = headerHtml + addressHtml + descriptionHtml + attributionHtml + metaHtml + distanceHtml + beenHereHtml + reviewsHtml + actionsHtml;

    // Click handler - show on map
    card.addEventListener('click', (e) => {
        // Don't navigate if clicking on interactive elements
        if (e.target.closest('button, a, input, textarea, select, .place-edit-form')) {
            return;
        }
        showPlaceOnMap(place);
    });

    return card;
}

// ── Collapsible list sections ─────────────────────────────────────────

function getListSectionCollapse() {
    try { return JSON.parse(localStorage.getItem('plist-section-collapse')) || {}; } catch { return {}; }
}

function buildListSection(id, title, places, renderFn) {
    const collapsed = getListSectionCollapse()[id] || false;
    const sec = document.createElement('div');
    sec.className = 'plist-section' + (collapsed ? ' plist-section--collapsed' : '');
    sec.dataset.sectionId = id;

    const header = document.createElement('div');
    header.className = 'plist-section-header';
    header.innerHTML = `<span class="plist-section-title">${title}</span><span class="plist-section-count">${places.length}</span><span class="plist-section-chevron">▾</span>`;
    header.addEventListener('click', () => toggleListSection(sec));
    sec.appendChild(header);

    const body = document.createElement('div');
    body.className = 'plist-section-body';
    places.forEach(p => body.appendChild(renderFn(p)));
    sec.appendChild(body);

    return sec;
}

function toggleListSection(sec) {
    const isCollapsed = sec.classList.toggle('plist-section--collapsed');
    const state = getListSectionCollapse();
    state[sec.dataset.sectionId] = isCollapsed;
    localStorage.setItem('plist-section-collapse', JSON.stringify(state));
}

// ── Personal place card (new design) ─────────────────────────────────

function createPersonalPlaceCard(place) {
    const card = document.createElement('div');
    card.className = 'pcard' + (place.is_visited ? ' pcard-visited' : '');
    card.dataset.placeId = place.id;

    const review = getPlaceReview(place.id);
    const safeName = place.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const moreBtn = `<button class="pcard-more" onclick="event.stopPropagation(); openPlaceMenu(${place.id}, '${safeName}')" aria-label="More options">···</button>`;
    const nameRow = `<div class="pcard-name-row"><span class="pcard-name">${escapeHtml(place.name)}</span>${moreBtn}</div>`;

    const mapsHref = place.google_place_id
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${place.google_place_id}`
        : (place.latitude && place.longitude ? `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}` : null);
    const mapsBtn = mapsHref ? `<a href="${mapsHref}" target="_blank" class="pcard-action-btn" onclick="event.stopPropagation()">📍 Maps</a>` : '';
    const reelBtn = place.source_url ? `<a href="${safeUrl(place.source_url)}" target="_blank" class="pcard-action-btn" onclick="event.stopPropagation()">▶️ Reel</a>` : '';

    if (place.is_visited) {
        // ─── VISITED: social feed style ──────────────────────────────

        // Composite score for badge
        const score = computePlaceScore(review);
        const visitedNameRow = `<div class="pcard-name-row"><span class="pcard-name">${escapeHtml(place.name)}</span>${moreBtn}</div>`;

        // Photo carousel (scroll-snap, full-bleed)
        const allPhotos = [
            ...(review?.overall_photos || []),
            ...(review?.dishes || []).flatMap(d => d.photos || [])
        ];
        if (allPhotos.length > 0) {
            const carousel = document.createElement('div');
            carousel.className = 'pcard-carousel-wrap';
            const slides = allPhotos.map((photo, i) =>
                `<div class="pcard-carousel-slide"><img class="pcard-carousel-img" src="${safeUrl(photo.url)}" alt="" loading="lazy"></div>`
            ).join('');
            carousel.innerHTML = `<div class="pcard-carousel">${slides}</div>`;
            // Photo clicks bubble up to the card click handler → opens RC card
            card.appendChild(carousel);
        }

        // Body
        const body = document.createElement('div');
        body.className = 'pcard-body';
        body.innerHTML = visitedNameRow;

        // Subtitle: type · price · date · distance
        const types = formatPlaceTypes(place.place_types);
        const price = place.place_price_level && PLACE_PRICE_LABELS[place.place_price_level]
            ? PLACE_PRICE_LABELS[place.place_price_level] : '';
        const dateStr = place.visited_at ? formatShortDate(place.visited_at) : '';
        const distV = getPlaceDistance(place);
        const distStrV = distV !== null ? `📍 ${formatDistance(distV)}` : '';
        const subtitleParts = [types, price, dateStr, distStrV].filter(Boolean);
        if (subtitleParts.length) {
            body.innerHTML += `<div class="pcard-subtitle">${subtitleParts.join(' · ')}</div>`;
        }

        // ── Compulsory group ──────────────────────────────────────────
        // Sentiment pill + inline overall score
        const scClass = score !== null ? (score >= 8 ? 'score-high' : score >= 6 ? 'score-mid' : 'score-low') : '';
        if (review?.sentiment || score !== null) {
            const emoji = SENTIMENT_EMOJI[review?.sentiment] || '';
            const label = { loved: 'Loved it', okay: 'It was okay', meh: 'Meh' }[review?.sentiment] || '';
            const sentHtml = review?.sentiment
                ? `<span class="pcard-sent-chip ${review.sentiment}">${emoji} ${label}</span>`
                : '';
            const overallHtml = score !== null
                ? `<span class="pcard-sent-overall ${scClass}">${score.toFixed(1)}</span>`
                : '';
            body.innerHTML += `<div class="pcard-sent-row">${sentHtml}${overallHtml}</div>`;
        }

        // Sub-scores: Food · Vibe · Value
        if (review && (review.food_score != null || review.vibe_score != null || review.value_score != null)) {
            const chips = [
                review.food_score != null ? `<span class="pcard-score-chip">🍽 Food <b>${review.food_score}</b></span>` : '',
                review.vibe_score != null ? `<span class="pcard-score-chip">🎵 Vibe <b>${review.vibe_score}</b></span>` : '',
                review.value_score != null ? `<span class="pcard-score-chip">💰 Value <b>${review.value_score}</b></span>` : '',
            ].filter(Boolean).join('');
            body.innerHTML += `<div class="pcard-scores">${chips}</div>`;
        }

        // ── Optional group ────────────────────────────────────────────
        // Dish chips with ratings
        if (review?.dishes?.length > 0) {
            const chips = review.dishes.map(d => {
                const sc = d.rating != null ? (d.rating >= 8 ? 'dish-high' : d.rating >= 5 ? 'dish-mid' : 'dish-low') : '';
                return `<span class="pcard-dish-chip ${sc}">${escapeHtml(d.name)}${d.rating != null ? `<span class="pcard-dish-score ${sc}"> ${d.rating}</span>` : ''}</span>`;
            }).join('');
            body.innerHTML += `<div class="pcard-dishes">${chips}</div>`;
        }

        // Caption below dishes, with quotes
        const caption = review?.caption || review?.overall_remarks;
        if (caption) {
            body.innerHTML += `<p class="pcard-caption">"${escapeHtml(caption)}"</p>`;
        }

        // Actions: Maps · Reel · Share
        const shareBtn = `<button class="pcard-action-btn" onclick="event.stopPropagation(); sharePlace(${place.id})">↗ Share</button>`;
        body.innerHTML += `<div class="pcard-actions">${mapsBtn}${reelBtn}${shareBtn}</div>`;

        card.appendChild(body);

    } else {
        // ─── WANT TO GO: clean & minimal ─────────────────────────────

        const types = formatPlaceTypes(place.place_types);
        const price = place.place_price_level && PLACE_PRICE_LABELS[place.place_price_level]
            ? PLACE_PRICE_LABELS[place.place_price_level] : '';
        const ratingStr = place.place_rating
            ? `⭐ ${place.place_rating}${place.place_rating_count ? ` (${Number(place.place_rating_count).toLocaleString()})` : ''}`
            : '';
        const distU = getPlaceDistance(place);
        const distStrU = distU !== null ? `📍 ${formatDistance(distU)}` : '';
        const subtitleParts = [types, price, ratingStr, distStrU].filter(Boolean);
        const subtitleHtml = subtitleParts.length
            ? `<div class="pcard-subtitle">${subtitleParts.join(' · ')}</div>` : '';
        const descHtml = place.place_description
            ? `<p class="pcard-caption pcard-caption--muted">${escapeHtml(place.place_description.slice(0, 120))}${place.place_description.length > 120 ? '…' : ''}</p>`
            : '';
        const hoursHtml = buildCardHoursHtml(place);
        const wtgActions = (mapsBtn || reelBtn) ? `<div class="pcard-actions pcard-actions--wtg">${mapsBtn}${reelBtn}</div>` : '';

        card.innerHTML = `
            ${nameRow}
            ${subtitleHtml}
            ${descHtml}
            ${hoursHtml}
            ${wtgActions}`;
    }

    card.addEventListener('click', e => {
        if (e.target.closest('button, a')) return;
        openRestaurantCard(place.id);
    });
    return card;
}

function formatShortDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-SG', { month: 'short', day: 'numeric' });
}

// Share a place via native share sheet or Telegram share URL
async function toggleGroupVisitedFromCard(placeId, btn) {
    try {
        const groupBase = `${API_URL}/api/group-shares/${encodeURIComponent(GROUP_TOKEN)}`;
        const res = await fetch(`${groupBase}/places/${placeId}/visited`, { method: 'PATCH' });
        if (!res.ok) return;
        const data = await res.json();
        const isVisited = data.is_visited;
        btn.classList.toggle('active', isVisited);
        btn.textContent = isVisited ? '✓ Visited' : 'Mark as visited';
        // Update local cache
        const place = places.find(p => p.id === placeId);
        if (place) place.is_visited = isVisited;
        // After marking visited, nudge for review
        if (isVisited && BOT_USERNAME) {
            const placeName = place ? place.name : '';
            showToast(`✅ Marked! <a href="https://t.me/${BOT_USERNAME}?start=grpreview_${placeId}" target="_blank" style="color:var(--button-color)">Write a review →</a>`, 5000);
        }
    } catch (e) {
        // silently fail
    }
}


async function toggleGroupReviews(toggleEl, placeId) {
    const section = toggleEl.closest('.group-reviews-section');
    const listEl = section.querySelector('.group-reviews-list');
    const isOpen = section.dataset.open === 'true';

    if (isOpen) {
        listEl.style.display = 'none';
        section.dataset.open = 'false';
        toggleEl.textContent = '📝 Reviews';
        return;
    }

    // Fetch reviews lazily
    if (section.dataset.loaded !== 'true') {
        toggleEl.textContent = '📝 Loading...';
        try {
            const groupBase = `/api/group-shares/${encodeURIComponent(GROUP_TOKEN)}`;
            const res = await fetch(`${groupBase}/places/${placeId}/reviews`);
            const data = await res.json();
            const reviews = data.reviews || [];
            const writeLink = BOT_USERNAME
                ? `<a href="https://t.me/${BOT_USERNAME}?start=grpreview_${placeId}" target="_blank" class="group-reviews-write-link">✏️ Write a review →</a>`
                : '';
            if (reviews.length === 0) {
                listEl.innerHTML = `<div class="group-review-item" style="color:var(--hint-color)">No reviews yet.</div>${writeLink}`;
            } else {
                listEl.innerHTML = reviews.map(r => {
                    const stars = '⭐'.repeat(Math.round(r.overall_rating || 0));
                    const remark = r.overall_remarks ? `"${escapeHtml(r.overall_remarks)}"` : '';
                    const author = r.reviewer_name ? `— ${escapeHtml(r.reviewer_name)}` : '';
                    return `<div class="group-review-item">
                        <span>${stars} ${remark}</span>
                        <div class="group-review-author">${author}</div>
                    </div>`;
                }).join('') + writeLink;
            }
            section.dataset.loaded = 'true';
        } catch (e) {
            listEl.innerHTML = '<div class="group-review-item" style="color:var(--hint-color)">Failed to load.</div>';
        }
    }

    listEl.style.display = 'block';
    section.dataset.open = 'true';
    toggleEl.textContent = '📝 Hide reviews';
}


async function toggleShareReviews(toggleEl, placeId) {
    const section = toggleEl.closest('.group-reviews-section');
    const listEl = section.querySelector('.group-reviews-list');
    const isOpen = section.dataset.open === 'true';

    if (isOpen) {
        listEl.style.display = 'none';
        section.dataset.open = 'false';
        toggleEl.textContent = '📝 Reviews';
        return;
    }

    if (section.dataset.loaded !== 'true') {
        toggleEl.textContent = '📝 Loading...';
        try {
            const res = await fetch(`/api/shares/${SHARE_TOKEN}/places/${placeId}/reviews`);
            const data = await res.json();
            const reviews = data.reviews || [];
            if (reviews.length === 0) {
                listEl.innerHTML = `<div class="group-review-item" style="color:var(--hint-color)">No reviews yet.</div>`;
            } else {
                listEl.innerHTML = reviews.map(r => {
                    const stars = '⭐'.repeat(Math.round(r.overall_rating || 0));
                    const remark = r.overall_remarks ? `"${escapeHtml(r.overall_remarks)}"` : '';
                    return `<div class="group-review-item">
                        <span>${stars} ${remark}</span>
                    </div>`;
                }).join('');
            }
            section.dataset.loaded = 'true';
        } catch (e) {
            listEl.innerHTML = '<div class="group-review-item" style="color:var(--hint-color)">Failed to load.</div>';
        }
    }

    listEl.style.display = 'block';
    section.dataset.open = 'true';
    toggleEl.textContent = '📝 Hide reviews';
}


async function shareMyMap() {
    try {
        const res = await fetch(`${API_URL}/api/my-share`, { headers: getAuthHeaders() });
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        const shareUrl = data.share_url;
        if (!shareUrl) throw new Error('No URL');
        trackEvent('map_shared', {
            entityType: 'map',
            metadata: { method: window.Telegram?.WebApp?.openTelegramLink ? 'telegram' : 'native' },
        });

        const ownerName = window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name || 'my';
        const shareText = `🌱 Check out ${ownerName}'s food map on Sprout!\nDiscover where they eat 👇\n\nBuild yours: @sprout_eats_bot`;
        const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`;

        if (window.Telegram?.WebApp?.openTelegramLink) {
            window.Telegram.WebApp.openTelegramLink(tgShareUrl);
        } else if (navigator.share) {
            await navigator.share({ title: `${ownerName}'s Sprout Map`, url: shareUrl, text: shareText });
        } else {
            await navigator.clipboard.writeText(shareUrl);
            showToast('Link copied! Share it anywhere 🌱');
        }
    } catch (e) {
        showToast('Could not generate share link');
    }
}

// ── Share picker state ──────────────────────────────────────────────────────
let _sharePicker = null; // { tgText, waText, fullText, mapsUrl, name }

function sharePlace(placeId) {
    const place = places.find(p => p.id === placeId);
    if (!place) return;
    trackEvent('map_shared', {
        entityType: 'place', entityId: placeId,
        metadata: { google_place_id: place.google_place_id, method: 'place_share' },
    });

    const mapsUrl = place.google_place_id
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${place.google_place_id}`
        : `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}`;

    const types    = formatPlaceTypes(place.place_types);
    const price    = place.place_price_level ? '$'.repeat(place.place_price_level) : '';
    const rating   = place.place_rating ? `⭐ ${place.place_rating}` : '';
    const subtitle = [types, price, rating].filter(Boolean).join(' · ');
    const area     = place.address ? place.address.split(',')[0].trim() : '';

    const review = getPlaceReview(placeId);
    const sentimentLine = review?.sentiment
        ? ({ loved: '🔥 Loved it', okay: '😊 Pretty good', meh: '😑 Alright' }[review.sentiment] || '')
        : '';
    const caption = review?.caption
        ? `"${review.caption.slice(0, 80)}${review.caption.length > 80 ? '…' : ''}"`
        : '';

    const myName = document.getElementById('profile-display-name')?.textContent?.trim();
    const myTgId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    const botBase = BOT_USERNAME || 'sprout_eats_bot';
    const botLink = myTgId
        ? `https://t.me/${botBase}?start=addfriend_${myTgId}`
        : `https://t.me/${botBase}`;

    // Telegram: url= becomes rich preview card → text has no raw Maps URL
    const tgLines = [];
    if (myName) tgLines.push(`${myName} discovered this on Sprout 🌱`);
    tgLines.push('');
    tgLines.push(`🍽️ ${place.name}`);
    if (subtitle)      tgLines.push(subtitle);
    if (area)          tgLines.push(`📍 ${area}`);
    if (sentimentLine) tgLines.push(sentimentLine);
    if (caption)       tgLines.push(caption);
    if (place.source_url) tgLines.push(`▶️ Reel: ${place.source_url}`);
    tgLines.push('');
    tgLines.push(`Join me on Sprout → ${botLink}`);

    // WhatsApp / More / Copy: include raw Maps URL (clickable in every app)
    const waLines = [...tgLines];
    waLines.splice(waLines.length - 2, 0, `🗺️ ${mapsUrl}`);

    _sharePicker = {
        name: place.name,
        mapsUrl,
        tgText: tgLines.join('\n'),
        waText: waLines.join('\n'),
        fullText: waLines.join('\n'),
    };

    // Show picker
    const nameEl = document.getElementById('share-picker-name');
    if (nameEl) nameEl.textContent = place.name;
    document.getElementById('share-picker').style.display = 'flex';
}

function closeSharePicker(e) {
    const overlay = document.getElementById('share-picker');
    if (e && e.target !== overlay) return;
    if (overlay) overlay.style.display = 'none';
    _sharePicker = null;
}

function _doShareTelegram() {
    document.getElementById('share-picker').style.display = 'none';
    if (!_sharePicker) return;
    // url= renders as a rich link preview card in Telegram; text stays clean
    const url = `https://t.me/share/url?url=${encodeURIComponent(_sharePicker.mapsUrl)}&text=${encodeURIComponent(_sharePicker.tgText)}`;
    window.Telegram?.WebApp?.openTelegramLink(url);
    _sharePicker = null;
    showToast('✈️ Opening Telegram…');
}

function _doShareWhatsApp() {
    document.getElementById('share-picker').style.display = 'none';
    if (!_sharePicker) return;
    const url = `https://wa.me/?text=${encodeURIComponent(_sharePicker.waText)}`;
    window.open(url, '_blank');
    _sharePicker = null;
    showToast('💬 Opening WhatsApp…');
}

function _doShareCopy() {
    document.getElementById('share-picker').style.display = 'none';
    if (!_sharePicker) return;
    navigator.clipboard?.writeText(_sharePicker.fullText)
        .then(() => showToast('📋 Copied to clipboard!'))
        .catch(() => showToast('📋 Copied!'));
    _sharePicker = null;
}

function _doShareMore() {
    document.getElementById('share-picker').style.display = 'none';
    if (!_sharePicker) return;
    const { name, fullText } = _sharePicker;
    _sharePicker = null;
    if (navigator.share) {
        navigator.share({ title: `🌱 ${name}`, text: fullText })
            .then(() => showToast('🌱 Shared!'))
            .catch(err => {
                if (err?.name !== 'AbortError') {
                    navigator.clipboard?.writeText(fullText);
                    showToast('📋 Copied to clipboard!');
                }
            });
    } else {
        navigator.clipboard?.writeText(fullText);
        showToast('📋 Copied to clipboard!');
    }
}

// Toggle visited from card sprout button
async function toggleVisitedFromCard(placeId) {
    const place = places.find(p => p.id === placeId);
    if (!place) return;
    const newVisited = !place.is_visited;
    if (!newVisited && getPlaceReview(placeId)) {
        const ok = confirm(`Unmark "${place.name}" as visited?\n\nYour review will also be deleted. To edit your review instead, tap ✍️ on the card.`);
        if (!ok) return;
        await deleteReviewForPlace(placeId);
    }
    updatePlaceVisited(placeId, newVisited, false);
}

// ========== PLACE OVERFLOW MENU ==========

let currentMenuPlaceId = null;
let currentMenuPlaceName = null;

function openPlaceMenu(placeId, placeName) {
    currentMenuPlaceId = placeId;
    currentMenuPlaceName = placeName;
    const menu = document.getElementById('place-menu');
    _prevFocusEl = document.activeElement;
    menu.style.display = 'flex';
    menu._trapFocusCleanup = trapFocus(menu);
    menu.querySelector('button')?.focus();
    hapticFeedback('light');
}

function closePlaceMenu() {
    const menu = document.getElementById('place-menu');
    menu._trapFocusCleanup?.();
    menu.style.display = 'none';
    currentMenuPlaceId = null;
    currentMenuPlaceName = null;
    _prevFocusEl?.focus();
    _prevFocusEl = null;
}

function setupPlaceMenu() {
    document.getElementById('menu-edit').addEventListener('click', () => {
        const placeId = currentMenuPlaceId;
        closePlaceMenu();
        if (placeId) openEditPlaceSheet(placeId);
    });

    document.getElementById('menu-delete').addEventListener('click', () => {
        if (currentMenuPlaceId && currentMenuPlaceName) {
            const placeId = currentMenuPlaceId;
            const placeName = currentMenuPlaceName;
            closePlaceMenu();
            closeRestaurantCard();
            confirmDeletePlace(placeId, placeName);
        }
    });

    document.getElementById('menu-cancel').addEventListener('click', closePlaceMenu);

    // Close on backdrop click
    document.getElementById('place-menu').addEventListener('click', (e) => {
        if (e.target.id === 'place-menu') {
            closePlaceMenu();
        }
    });
}

// ── Edit Place Sheet ─────────────────────────────────────────────────────
let editPlaceId = null;

function openEditPlaceSheet(placeId) {
    const place = places.find(p => p.id === placeId);
    if (!place) return;
    editPlaceId = placeId;

    document.getElementById('ep-subtitle').textContent = place.name;
    document.getElementById('ep-name').value = place.name;
    const currentType = place.place_types ? place.place_types.split(',')[0].trim().replace(/_/g, ' ') : '';
    document.getElementById('ep-type').value = currentType;

    const overlay = document.getElementById('edit-place-overlay');
    const sheet = document.getElementById('edit-place-sheet');
    overlay.style.display = 'flex';
    sheet.classList.add('rc-open');
    document.getElementById('ep-name').focus();
}

function closeEditPlaceSheet() {
    const overlay = document.getElementById('edit-place-overlay');
    const sheet = document.getElementById('edit-place-sheet');
    sheet.classList.remove('rc-open');
    overlay.style.display = 'none';
    editPlaceId = null;
}

async function saveEditPlace() {
    if (!editPlaceId) return;
    const place = places.find(p => p.id === editPlaceId);
    if (!place) return;

    const newName = document.getElementById('ep-name').value.trim();
    const newTypeRaw = document.getElementById('ep-type').value.trim().toLowerCase().replace(/\s+/g, '_');
    const newType = newTypeRaw || null;

    if (!newName) { showToast('Name cannot be empty'); return; }

    const currentType = place.place_types ? place.place_types.split(',')[0].trim() : '';
    if (newName === place.name && newType === currentType) {
        closeEditPlaceSheet();
        return;
    }

    hapticFeedback('light');
    place.name = newName;
    place.place_types = newType;

    try {
        const res = await fetch(`${API_URL}/api/places/${editPlaceId}`, {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName, place_types: newType })
        });
        if (!res.ok) throw new Error('Failed to update');
        showToast('Saved ✓');
    } catch (e) {
        showToast('Failed to save');
    }

    closeEditPlaceSheet();
    updateMarkerPopup(editPlaceId, place);
    applyFilters();

    // Refresh RC card if it's open for this place
    if (rcCurrentPlaceId === editPlaceId) {
        renderRestaurantCard(place, getPlaceReview(editPlaceId));
    }
}

// Show a specific place on the map
function showPlaceOnMap(place) {
    if (!place.latitude || !place.longitude) {
        showToast("No location data for this place");
        return;
    }

    // Show feedback before switching views
    showToast(`📍 Showing on map...`);

    // Switch to map view
    switchView('map');

    // Find and open the marker for this place
    setTimeout(() => {
        markersLayer.eachLayer(marker => {
            if (marker.placeData && marker.placeData.id === place.id) {
                focusMarkerWithPopup(marker, [place.latitude, place.longitude], 15);
            }
        });
    }, 150);
}

// Render all place cards in the list
function renderPlacesList(placesToRender) {
    const listContainer = document.getElementById('places-list');
    const noResults = document.getElementById('no-results');

    listContainer.innerHTML = '';
    document.getElementById('load-more-places-btn')?.remove();

    if (placesToRender.length === 0) {
        listContainer.style.display = 'none';
        noResults.style.display = 'flex';
        updateResultsCount(0, places.length);
        return;
    }

    listContainer.style.display = 'block';
    noResults.style.display = 'none';

    if (!IS_GROUP_MAP && !IS_SHARE_MAP) {
        // Personal map: two-section layout
        const wishlist = placesToRender.filter(p => !p.is_visited);
        const visited  = placesToRender.filter(p => p.is_visited);

        if (wishlist.length > 0) listContainer.appendChild(buildListSection('wishlist', 'To Visit', wishlist, createPersonalPlaceCard));
        if (visited.length > 0)  listContainer.appendChild(buildListSection('visited',  'Visited ✓',  visited,  createPersonalPlaceCard));
    } else {
        placesToRender.forEach(place => {
            listContainer.appendChild(createPlaceCard(place));
        });
    }

    updateResultsCount(placesToRender.length, totalPlaces || places.length);

    const noFiltersActive = !searchQuery && !activeCategory && visitedFilter === 'all' && !countryFilter;
    if (hasMorePlaces && noFiltersActive) {
        const btn = document.createElement('button');
        btn.id = 'load-more-places-btn';
        btn.className = 'load-more-btn';
        btn.textContent = `Load more (${places.length} of ${totalPlaces})`;
        btn.onclick = loadMorePlaces;
        listContainer.after(btn);
    }
}

// Update the results count display
function updateResultsCount(showing, total) {
    const countEl = document.getElementById('results-count');
    let label = 'places';
    if (visitedFilter === 'visited') {
        label = 'visited';
    } else if (visitedFilter === 'unvisited') {
        label = 'to visit';
    }

    if (showing === total || visitedFilter !== 'all') {
        countEl.textContent = `${showing} ${label}`;
    } else {
        countEl.textContent = `${showing} of ${total} places`;
    }
}

// Extract unique categories from all places
function getUniqueCategories() {
    const categories = new Set();
    places.forEach(place => {
        const primary = getPrimaryCategory(place.place_types);
        if (primary) {
            categories.add(primary);
        }
    });
    return Array.from(categories).sort();
}

// Render category filter chips (single choice)
function renderFilterChips() {
    const container = document.getElementById('filter-chips');
    container.innerHTML = '';

    // "All" chip
    const allChip = document.createElement('button');
    allChip.className = 'filter-chip' + (activeCategory === '' ? ' active' : '');
    allChip.textContent = 'All';
    allChip.addEventListener('click', () => {
        activeCategory = '';
        applyFilters();
    });
    container.appendChild(allChip);

    // Category chips
    const categories = getUniqueCategories();
    categories.forEach(category => {
        const chip = document.createElement('button');
        chip.className = 'filter-chip' + (activeCategory === category ? ' active' : '');
        chip.textContent = category.charAt(0).toUpperCase() + category.slice(1);
        chip.addEventListener('click', () => {
            // Single choice - just set the category (or clear if clicking active)
            activeCategory = (activeCategory === category) ? '' : category;
            applyFilters();
        });
        container.appendChild(chip);
    });
}

// Filter places by search query — token-based matching with normalization
function filterBySearch(placesToFilter) {
    if (!searchQuery.trim()) return placesToFilter;

    // Normalize: lowercase, strip apostrophes/hyphens, collapse whitespace
    const normalize = s => s.toLowerCase().replace(/['\u2019\-]/g, '').replace(/\s+/g, ' ').trim();
    const tokens = normalize(searchQuery).split(' ').filter(Boolean);
    if (tokens.length === 0) return placesToFilter;

    return placesToFilter.filter(place => {
        const fields = [
            place.name,
            place.address,
            place.notes,
            place.place_types,
        ].filter(Boolean).map(s => normalize(s));

        // ALL tokens must match at least one field (AND across tokens, OR across fields per token)
        return tokens.every(token => fields.some(field => field.includes(token)));
    });
}

// Filter places by category (single choice)
function filterByCategory(placesToFilter) {
    if (!activeCategory) return placesToFilter;

    return placesToFilter.filter(place => {
        const primary = getPrimaryCategory(place.place_types);
        return primary === activeCategory;
    });
}

// Sort places
function sortPlaces(placesToSort) {
    const sorted = [...placesToSort];

    switch (sortBy) {
        case 'name':
            sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            break;
        case 'rating':
            sorted.sort((a, b) => (b.place_rating || 0) - (a.place_rating || 0));
            break;
        case 'favourites':
            sorted.sort((a, b) => {
                const scoreA = computePlaceScore(getPlaceReview(a.id)) ?? -1;
                const scoreB = computePlaceScore(getPlaceReview(b.id)) ?? -1;
                return scoreB - scoreA;
            });
            break;
        case 'distance':
            if (!userLocation) {
                // No location yet — silently fall back to newest
                sorted.sort((a, b) => (b.id || 0) - (a.id || 0));
                return sorted;
            }
            sorted.sort((a, b) => {
                const distA = getPlaceDistance(a) ?? Infinity;
                const distB = getPlaceDistance(b) ?? Infinity;
                return distA - distB;
            });
            break;
        case 'newest':
        default:
            // Assume higher ID = newer (or use created_at if available)
            sorted.sort((a, b) => (b.id || 0) - (a.id || 0));
            break;
    }

    return sorted;
}

// Apply all filters and re-render list
function filterByRating(placesArr) {
    if (!ratingFilter) return placesArr;
    return placesArr.filter(p => p.place_rating && p.place_rating >= ratingFilter);
}

function filterByPriceLevel(placesArr) {
    if (!priceLevelFilter) return placesArr;
    return placesArr.filter(p => p.place_price_level === priceLevelFilter);
}

function isOpenNow(place) {
    if (!place.place_opening_hours) return null;
    let hours;
    try { hours = JSON.parse(place.place_opening_hours); } catch { return null; }
    if (!Array.isArray(hours)) return null;
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayStr = hours.find(h => h.startsWith(dayNames[new Date().getDay()]));
    if (!todayStr) return null;
    if (todayStr.includes('Open 24 hours')) return true;
    if (todayStr.includes('Closed')) return false;

    // Normalize all dash variants (en-dash, em-dash, minus, hyphen) → hyphen
    const normalized = todayStr.replace(/[\u2013\u2014\u2012\u2212]/g, '-');
    // Match HH:MM AM/PM or HH:MM (24h), case-insensitive
    const match = normalized.match(/(\d{1,2}:\d{2}\s*(?:[AP]M)?)\s*-\s*(\d{1,2}:\d{2}\s*(?:[AP]M)?)/i);
    if (!match) { console.warn('isOpenNow: no time match in', todayStr); return null; }

    const toMin = s => {
        s = s.trim();
        const ampm = (s.match(/([AP]M)/i) || [])[1];
        const timePart = s.replace(/[AP]M/i, '').trim();
        let [h, m] = timePart.split(':').map(Number);
        m = m || 0;
        if (ampm) {
            const up = ampm.toUpperCase();
            if (up === 'PM' && h !== 12) h += 12;
            if (up === 'AM' && h === 12) h = 0;
        }
        return h * 60 + m;
    };
    const cur = new Date().getHours() * 60 + new Date().getMinutes();
    let open = toMin(match[1]), close = toMin(match[2]);
    if (close < open) close += 1440; // overnight
    return cur >= open && cur <= close;
}

function filterByOpenNow(placesArr) {
    if (!openNowFilter) return placesArr;
    return placesArr.filter(p => isOpenNow(p) === true);
}

function buildHoursHtml(place, idPrefix) {
    const noHours = '<div class="popup-info-row popup-info-muted popup-hours-unavailable">Hours not available</div>';
    if (!place.place_opening_hours) return noHours;
    let hours;
    try { hours = JSON.parse(place.place_opening_hours); } catch { return noHours; }
    if (!Array.isArray(hours) || hours.length === 0) return noHours;

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayName = dayNames[new Date().getDay()];
    const todayStr = hours.find(h => h.startsWith(todayName));
    if (!todayStr) return '';

    const colonIdx = todayStr.indexOf(': ');
    const todayHours = colonIdx >= 0 ? todayStr.slice(colonIdx + 2) : todayStr;

    const openNow = isOpenNow(place);
    const statusClass = openNow === true ? 'open' : openNow === false ? 'closed' : '';
    const statusText  = openNow === true ? 'Open'  : openNow === false ? 'Closed'  : '';

    const weekRows = hours.map(h => {
        const isToday = h.startsWith(todayName);
        return `<div class="popup-hours-day${isToday ? ' popup-hours-today' : ''}">${escapeHtml(h)}</div>`;
    }).join('');

    const dotClass = statusClass ? ` popup-hours-dot--${statusClass}` : '';
    const dropId = `${idPrefix}-hours-${place.id}`;
    return `<div class="popup-hours-row" onclick="event.stopPropagation(); toggleHoursDropdown('${dropId}')">
        <span class="popup-hours-dot${dotClass}"></span>
        ${statusClass ? `<span class="popup-hours-status popup-hours-status--${statusClass}">${statusText}</span>` : ''}
        <span class="popup-hours-time">${escapeHtml(todayHours)}</span>
        <span class="popup-hours-chevron-btn"><span class="popup-hours-chevron">▾</span></span>
    </div>
    <div class="popup-hours-full" id="${dropId}">${weekRows}</div>`;
}

function buildPopupHoursHtml(place) { return buildHoursHtml(place, 'popup'); }
function buildCardHoursHtml(place)  { return buildHoursHtml(place, 'card'); }

function toggleHoursDropdown(dropId) {
    const el = document.getElementById(dropId);
    if (!el) return;
    const open = el.classList.toggle('popup-hours-full--open');
    const chevron = el.previousElementSibling?.querySelector('.popup-hours-chevron');
    if (chevron) chevron.classList.toggle('popup-hours-chevron--open', open);
}

// Legacy aliases — kept for any inline onclick still referencing these
function togglePopupHours(placeId) { toggleHoursDropdown(`popup-hours-${placeId}`); }
function toggleCardHours(placeId)  { toggleHoursDropdown(`card-hours-${placeId}`); }

function toggleOpenNow() {
    openNowFilter = !openNowFilter;
    const chip = document.getElementById('open-now-chip');
    if (chip) {
        chip.classList.toggle('active', openNowFilter);
        chip.setAttribute('aria-pressed', String(openNowFilter));
    }
    applyFilters();
    debouncedDisplayPlacesOnMap(false);
}

function applyFilters() {
    let filtered = [...places];

    // Apply visited filter (skip when Open Now is active — it shows all places open now)
    if (!openNowFilter) {
        filtered = filterPlacesByVisited(filtered);
    }

    // Apply country filter
    filtered = filterPlacesByCountry(filtered);

    // Apply search filter
    filtered = filterBySearch(filtered);

    // Apply category filter
    filtered = filterByCategory(filtered);

    // Apply rating filter
    filtered = filterByRating(filtered);

    // Apply price level filter
    filtered = filterByPriceLevel(filtered);

    // Apply open now filter
    filtered = filterByOpenNow(filtered);

    // Apply collection filter
    if (activeCollectionId) {
        const col = _collectionPlacesCache[activeCollectionId];
        if (col) {
            const gids = new Set(col.map(p => p.google_place_id).filter(Boolean));
            filtered = filtered.filter(p => p.google_place_id && gids.has(p.google_place_id));
        }
    }

    // Apply sort
    filtered = sortPlaces(filtered);

    // Re-render list
    renderPlacesList(filtered);

    // Update all filter chip counts
    updateVisitedChipCounts();
    updateMapFilterCounts();

    // Update search clear button visibility
    const clearBtn = document.getElementById('search-clear');
    clearBtn.style.display = searchQuery.trim() ? 'block' : 'none';
}

// Setup search functionality
function setupSearch() {
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('search-clear');

    // Search input with debounce
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            searchQuery = e.target.value;
            applyFilters();
        }, 300);
    });

    // Clear button
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchQuery = '';
        applyFilters();
        searchInput.focus();
    });
}

// Setup sort functionality (legacy - now in filter drawer)
// Kept for backwards compatibility if sort-select element exists
function setupSort() {
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            sortBy = e.target.value;
            localStorage.setItem('sortBy', sortBy);
            applyFilters();
        });
    }
}

// Setup list controls (search, filters, sort)
function setupListControls() {
    setupSearch();
    setupVisitedFilter();
    setupFilterDrawer();
    setupPlaceMenu();
    updateVisitedChipCounts();
    updateFilterButton();
    renderActiveFilterPills();
}

// Setup visited filter buttons
function setupVisitedFilter() {
    const chips = document.querySelectorAll('.visited-chip');

    // Apply saved visited filter to UI
    chips.forEach(c => {
        const isActive = c.dataset.filter === visitedFilter;
        c.classList.toggle('active', isActive);
        c.setAttribute('aria-pressed', String(isActive));
    });
    document.querySelectorAll('.map-filter-chip').forEach(c => {
        const isActive = c.dataset.filter === visitedFilter;
        c.classList.toggle('active', isActive);
        c.setAttribute('aria-pressed', String(isActive));
    });

    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            // Update active state
            chips.forEach(c => { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
            chip.classList.add('active');
            chip.setAttribute('aria-pressed', 'true');

            // Update filter and persist
            visitedFilter = chip.dataset.filter;
            localStorage.setItem('visitedFilter', visitedFilter);

            // Re-apply filters
            applyFilters();
            debouncedDisplayPlacesOnMap(false);
        });
    });
}

// ========== VISITED & NOTES FUNCTIONALITY ==========

// Trigger haptic feedback if available
function hapticFeedback(style = 'light') {
    if (window.Telegram?.WebApp?.HapticFeedback) {
        window.Telegram.WebApp.HapticFeedback.impactOccurred(style);
    }
}

// Update place visited status via API
async function updatePlaceVisited(placeId, isVisited, fromPopup = false) {
    const place = places.find(p => p.id === placeId);
    if (!place) return;

    // Update local state immediately
    place.is_visited = isVisited;

    hapticFeedback('light');
    showToast(isVisited ? `✓ Marked ${place.name} as visited!` : `Unmarked ${place.name}`);

    // Update UI instantly — before API call
    if (fromPopup) {
        updateMarkerPopup(placeId, place);
    } else {
        displayPlacesOnMap();
    }
    applyFilters();

    // Persist to server
    try {
        const response = await fetch(`${API_URL}/api/places/${placeId}`, {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_visited: isVisited })
        });
        if (!response.ok) throw new Error('Failed to update');
    } catch (error) {
        console.error('Failed to update visited status:', error);
        // Revert local state and UI on error
        place.is_visited = !isVisited;
        showToast('Failed to save');
        if (fromPopup) updateMarkerPopup(placeId, place);
        applyFilters();
        displayPlacesOnMap();
    }
}


// Update place notes via API
async function updatePlaceNotes(placeId, notes) {
    // Update local state immediately
    const place = places.find(p => p.id === placeId);
    if (place) {
        place.notes = notes;
    }

    // Haptic feedback
    hapticFeedback('light');

    // Show feedback
    const placeName = place ? place.name : '';
    showToast(`Notes saved for ${placeName}!`);

    // Persist to server
    try {
        const response = await fetch(`${API_URL}/api/places/${placeId}`, {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes: notes })
        });
        if (!response.ok) {
            throw new Error('Failed to update');
        }
    } catch (error) {
        console.error('Failed to update notes:', error);
        showToast('Failed to save notes');
    }

    // Update marker popup in-place and list view
    if (place) {
        updateMarkerPopup(placeId, place);
    }
    applyFilters();
}

// Start inline note editing in list view


// Confirm delete place
async function confirmDeletePlace(placeId, placeName) {
    const normalizedPlaceId = Number(placeId);
    if (!Number.isInteger(normalizedPlaceId) || normalizedPlaceId <= 0) {
        console.error('Refusing to delete place with invalid id:', placeId);
        showToast("Couldn't delete this place");
        return false;
    }

    if (!confirm(`Delete "${placeName}"?\n\nThis can't be undone! 🥺`)) {
        return false;
    }

    // Disable the delete button to prevent double-submit
    const card = document.querySelector(`.place-card[data-place-id="${normalizedPlaceId}"]`);
    const deleteBtn = card?.querySelector('.delete-btn');
    if (deleteBtn) { deleteBtn.disabled = true; deleteBtn.textContent = 'Deleting...'; }

    return deletePlace(normalizedPlaceId);
}

// Delete a place
async function deletePlace(placeId) {
    const normalizedPlaceId = Number(placeId);
    if (!Number.isInteger(normalizedPlaceId) || normalizedPlaceId <= 0) {
        console.error('Refusing to call DELETE with invalid place id:', placeId);
        showToast("Couldn't delete this place");
        return false;
    }

    // Haptic feedback
    hapticFeedback('medium');

    // Delete from server
    try {
        const response = await fetch(`${API_URL}/api/places/${normalizedPlaceId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!response.ok) {
            throw new Error('Failed to delete');
        }
    } catch (error) {
        console.error('Failed to delete place:', error);
        showToast('Oops! Failed to delete 😅');
        // Re-enable button on failure
        const card = document.querySelector(`.place-card[data-place-id="${normalizedPlaceId}"]`);
        const deleteBtn = card?.querySelector('.delete-btn');
        if (deleteBtn) { deleteBtn.disabled = false; deleteBtn.textContent = 'Delete'; }
        return false;
    }

    // Get place name before removal
    const deletedPlace = places.find(p => p.id === normalizedPlaceId);
    const placeName = deletedPlace ? deletedPlace.name : '';

    // Remove from local state
    places = places.filter(p => p.id !== normalizedPlaceId);
    allReviews = allReviews.filter(review => review.place_id !== normalizedPlaceId);

    if (currentReviewPlaceId === normalizedPlaceId) {
        closeReviewSheet();
    }

    // Show feedback
    showToast(`Bye bye ${placeName}! 👋`);

    // Re-render
    applyFilters();
    displayPlacesOnMap();
    renderReviews();
    updateReviewFilterCounts();
    return true;
}

// Get all unique types from places for dropdown
function getAllPlaceTypes() {
    const types = new Set();
    places.forEach(p => {
        if (p.place_types) {
            p.place_types.split(',').forEach(t => {
                const trimmed = t.trim();
                if (trimmed) types.add(trimmed);
            });
        }
    });
    return Array.from(types).sort();
}

// Start inline place edit (name + type)
function startPlaceEdit(placeId, card) {
    const place = places.find(p => p.id === placeId);
    if (!place) return;

    // Get existing types for dropdown
    const existingTypes = getAllPlaceTypes();
    const currentType = place.place_types ? place.place_types.split(',')[0].trim() : '';

    // Build type options
    let typeOptions = '<option value="">No type</option>';
    existingTypes.forEach(type => {
        const selected = type === currentType ? ' selected' : '';
        const displayName = type.replace(/_/g, ' ');
        typeOptions += `<option value="${type}"${selected}>${displayName}</option>`;
    });
    typeOptions += '<option value="__new__">+ Add new type...</option>';

    // Create edit form
    const editHtml = `
        <div class="place-edit-form">
            <div class="edit-field">
                <label>Name</label>
                <input type="text" class="edit-name-input" value="${place.name.replace(/"/g, '&quot;')}" />
            </div>
            <div class="edit-field">
                <label>Type</label>
                <select class="edit-type-select">${typeOptions}</select>
                <input type="text" class="edit-type-new" placeholder="Enter new type..." style="display: none;" />
            </div>
            <div class="edit-actions">
                <button class="edit-cancel-btn" onclick="event.stopPropagation(); cancelPlaceEdit(${placeId})">Cancel</button>
                <button class="edit-save-btn" onclick="event.stopPropagation(); savePlaceEdit(${placeId})">Save</button>
            </div>
        </div>
    `;

    // Replace card content
    card.dataset.originalHtml = card.innerHTML;
    card.innerHTML = editHtml;
    card.classList.add('editing');

    // Focus name input
    const nameInput = card.querySelector('.edit-name-input');
    nameInput.focus();
    nameInput.select();

    // Handle "Add new type" selection
    const typeSelect = card.querySelector('.edit-type-select');
    const typeNewInput = card.querySelector('.edit-type-new');
    typeSelect.addEventListener('change', () => {
        if (typeSelect.value === '__new__') {
            typeNewInput.style.display = 'block';
            typeNewInput.focus();
        } else {
            typeNewInput.style.display = 'none';
        }
    });

    // Handle keyboard
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            cancelPlaceEdit(placeId);
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            savePlaceEdit(placeId);
        }
    });
}

// Cancel place edit
function cancelPlaceEdit(placeId) {
    applyFilters(); // Re-render to restore original
}

// Save place edit (name + type)
async function savePlaceEdit(placeId) {
    const card = document.querySelector(`.place-card[data-place-id="${placeId}"]`);
    if (!card) return;

    const nameInput = card.querySelector('.edit-name-input');
    const typeSelect = card.querySelector('.edit-type-select');
    const typeNewInput = card.querySelector('.edit-type-new');

    const newName = nameInput.value.trim();
    let newType = typeSelect.value;

    // Handle new type
    if (newType === '__new__') {
        newType = typeNewInput.value.trim().toLowerCase().replace(/\s+/g, '_');
    }

    if (!newName) {
        showToast('Name cannot be empty');
        return;
    }

    const place = places.find(p => p.id === placeId);
    if (!place) return;

    // Check if anything changed
    const currentType = place.place_types ? place.place_types.split(',')[0].trim() : '';
    if (newName === place.name && newType === currentType) {
        cancelPlaceEdit(placeId);
        return;
    }

    hapticFeedback('light');

    // Update local state
    place.name = newName;
    place.place_types = newType || null;

    // Persist to server
    try {
        const response = await fetch(`${API_URL}/api/places/${placeId}`, {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName, place_types: newType || null })
        });
        if (!response.ok) {
            throw new Error('Failed to update');
        }
        showToast('Updated! ✓');
    } catch (error) {
        console.error('Failed to update place:', error);
        showToast('Failed to save');
    }

    // Update marker and re-render
    updateMarkerPopup(placeId, place);
    applyFilters();
}

// Rename a place (legacy, kept for popup)
async function renamePlace(placeId, currentName) {
    const newName = prompt('Rename place:', currentName);
    if (!newName || newName.trim() === '' || newName === currentName) return;

    hapticFeedback('light');

    // Update local state
    const place = places.find(p => p.id === placeId);
    if (place) {
        place.name = newName.trim();
    }

    // Persist to server
    try {
        const response = await fetch(`${API_URL}/api/places/${placeId}`, {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() })
        });
        if (!response.ok) {
            throw new Error('Failed to rename');
        }
        showToast('Renamed! ✏️');
    } catch (error) {
        console.error('Failed to rename place:', error);
        if (place) place.name = currentName; // Revert
        showToast('Failed to rename');
    }

    // Update marker popup in-place and list view
    if (place) {
        updateMarkerPopup(placeId, place);
    }
    applyFilters();
}


// Open notes editor modal
function openNotesModal(place) {
    currentEditingPlaceId = place.id;
    const modal = document.getElementById('notes-modal');
    const textarea = document.getElementById('notes-textarea');
    const charCount = document.getElementById('char-count');

    textarea.value = place.notes || '';
    charCount.textContent = textarea.value.length;

    _prevFocusEl = document.activeElement;
    modal.style.display = 'flex';
    modal._trapFocusCleanup = trapFocus(modal);
    textarea.focus();

    // Update character count on input
    textarea.oninput = () => {
        charCount.textContent = textarea.value.length;
    };
}

// Close notes modal
function closeNotesModal() {
    const modal = document.getElementById('notes-modal');
    modal._trapFocusCleanup?.();
    modal.style.display = 'none';
    currentEditingPlaceId = null;
    _prevFocusEl?.focus();
    _prevFocusEl = null;
}

// Save notes from modal
function saveNotesFromModal() {
    if (currentEditingPlaceId === null) return;

    const textarea = document.getElementById('notes-textarea');
    const notes = textarea.value.trim();

    // Send empty string to clear notes (not null, which API ignores)
    updatePlaceNotes(currentEditingPlaceId, notes);
    closeNotesModal();
}

// Setup notes modal event listeners
function setupNotesModal() {
    document.getElementById('modal-close').addEventListener('click', closeNotesModal);
    document.getElementById('notes-cancel').addEventListener('click', closeNotesModal);
    document.getElementById('notes-save').addEventListener('click', saveNotesFromModal);

    // Close on backdrop click
    document.getElementById('notes-modal').addEventListener('click', (e) => {
        if (e.target.id === 'notes-modal') {
            closeNotesModal();
        }
    });
}


// ========== GOOGLE SEARCH MODAL ==========

const DEFAULT_DISCOVER_TYPES = [
    { query: 'restaurant', label: 'Restaurant', emoji: '🍽️' },
    { query: 'cafe', label: 'Cafe', emoji: '☕' },
    { query: 'bar', label: 'Bar', emoji: '🍺' },
    { query: 'bakery', label: 'Bakery', emoji: '🥐' },
    { query: 'ramen', label: 'Ramen', emoji: '🍜' },
    { query: 'sushi', label: 'Sushi', emoji: '🍣' },
    { query: 'pizza', label: 'Pizza', emoji: '🍕' },
    { query: 'burger', label: 'Burger', emoji: '🍔' },
];

const PLACE_TYPE_DISCOVER_MAP = {
    restaurant: { query: 'restaurant', label: 'Restaurant', emoji: '🍽️' },
    cafe: { query: 'cafe', label: 'Cafe', emoji: '☕' },
    coffee_shop: { query: 'coffee', label: 'Coffee', emoji: '☕' },
    bar: { query: 'bar', label: 'Bar', emoji: '🍺' },
    bakery: { query: 'bakery', label: 'Bakery', emoji: '🥐' },
    brunch_restaurant: { query: 'brunch', label: 'Brunch', emoji: '🍳' },
    breakfast_restaurant: { query: 'breakfast', label: 'Breakfast', emoji: '🍳' },
    japanese_restaurant: { query: 'japanese restaurant', label: 'Japanese', emoji: '🍱' },
    korean_restaurant: { query: 'korean restaurant', label: 'Korean', emoji: '🥘' },
    chinese_restaurant: { query: 'chinese restaurant', label: 'Chinese', emoji: '🥟' },
    italian_restaurant: { query: 'italian restaurant', label: 'Italian', emoji: '🍝' },
    thai_restaurant: { query: 'thai restaurant', label: 'Thai', emoji: '🍜' },
    vietnamese_restaurant: { query: 'vietnamese restaurant', label: 'Vietnamese', emoji: '🍜' },
    indian_restaurant: { query: 'indian restaurant', label: 'Indian', emoji: '🍛' },
    sushi_restaurant: { query: 'sushi', label: 'Sushi', emoji: '🍣' },
    ramen_restaurant: { query: 'ramen', label: 'Ramen', emoji: '🍜' },
    pizza_restaurant: { query: 'pizza', label: 'Pizza', emoji: '🍕' },
    hamburger_restaurant: { query: 'burger', label: 'Burger', emoji: '🍔' },
    dessert_shop: { query: 'dessert', label: 'Dessert', emoji: '🍰' },
    ice_cream_shop: { query: 'ice cream', label: 'Ice Cream', emoji: '🍨' },
};


function dismissSearchKeyboard() {
    const input = document.getElementById('google-search-input');
    if (document.activeElement === input) {
        input.blur();
    }
}


function getDynamicDiscoverTypes() {
    const typeCounts = new Map();

    places.forEach((place) => {
        if (!place.place_types) return;

        const distance = getPlaceDistance(place);
        if (userLocation && distance !== null && distance > 10) {
            return;
        }

        place.place_types.split(',').forEach((rawType) => {
            const mapped = PLACE_TYPE_DISCOVER_MAP[rawType.trim()];
            if (!mapped) return;

            const existing = typeCounts.get(mapped.query) || { ...mapped, count: 0 };
            existing.count += 1;
            typeCounts.set(mapped.query, existing);
        });
    });

    const dynamicTypes = Array.from(typeCounts.values())
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
        .slice(0, 8)
        .map(({ query, label, emoji }) => ({ query, label, emoji }));

    if (dynamicTypes.length >= 4) {
        return dynamicTypes;
    }

    const seen = new Set(dynamicTypes.map((item) => item.query));
    DEFAULT_DISCOVER_TYPES.forEach((item) => {
        if (!seen.has(item.query) && dynamicTypes.length < 8) {
            dynamicTypes.push(item);
        }
    });

    return dynamicTypes;
}


function renderSearchTypeChips() {
    const container = document.getElementById('search-type-chips');
    const types = getDynamicDiscoverTypes();

    container.innerHTML = types.map((type) => `
        <button class="search-type-chip" data-type="${type.query}">
            ${type.emoji} ${type.label}
        </button>
    `).join('');
}

// Open search modal (optionally pre-fill with a query)
function openSearchModal(prefill = '') {
    const modal = document.getElementById('search-modal');
    const input = document.getElementById('google-search-input');
    const resultsContainer = document.getElementById('search-results');

    // Clear input and results
    input.value = '';
    resultsContainer.innerHTML = '';
    document.getElementById('search-loading').style.display = 'none';
    document.getElementById('search-empty').style.display = 'none';

    // Rebuild and clear active state from type chips
    renderSearchTypeChips();
    document.querySelectorAll('.search-type-chip').forEach(c => c.classList.remove('active'));

    _prevFocusEl = document.activeElement;
    modal.style.display = 'flex';
    modal._trapFocusCleanup = trapFocus(modal);
    input.focus();

    // Pre-fill and search if a query was provided (from Discover tab chips)
    if (prefill) {
        input.value = prefill;
        searchGooglePlaces();
        return;
    }

    // Auto-load nearby restaurants if location available
    if (userLocation) {
        searchNearbyPlaces('restaurant');
        // Mark restaurant chip as active
        document.querySelector('.search-type-chip[data-type="restaurant"]')?.classList.add('active');
    }
}

// Search for nearby places by type
async function searchNearbyPlaces(type) {
    const resultsContainer = document.getElementById('search-results');
    const loadingEl = document.getElementById('search-loading');
    const emptyEl = document.getElementById('search-empty');

    const query = type;

    // Show loading
    resultsContainer.innerHTML = '';
    loadingEl.style.display = 'flex';
    emptyEl.style.display = 'none';

    try {
        const response = await fetch(buildSearchUrl(query, 10), {
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Search failed');

        const data = await response.json();
        loadingEl.style.display = 'none';

        if (data.results.length === 0) {
            emptyEl.style.display = 'flex';
            return;
        }

        // Sort by distance if location available
        let results = data.results;
        if (userLocation) {
            results = results.sort((a, b) => {
                const distA = (a.latitude && a.longitude) ? calculateDistance(userLocation.lat, userLocation.lng, a.latitude, a.longitude) : Infinity;
                const distB = (b.latitude && b.longitude) ? calculateDistance(userLocation.lat, userLocation.lng, b.latitude, b.longitude) : Infinity;
                return distA - distB;
            });
        }

        // Render results
        renderSearchResults(results);

    } catch (error) {
        console.error('Search error:', error);
        loadingEl.style.display = 'none';
        showToast('Search failed. Try again!');
    }
}

// Render search results (shared function)
function renderSearchResults(results) {
    const resultsContainer = document.getElementById('search-results');

    resultsContainer.innerHTML = results.map(place => {
        let mapsUrl = '';
        if (place.google_place_id) {
            const encodedName = encodeURIComponent(place.name);
            mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodedName}&query_place_id=${place.google_place_id}`;
        } else if (place.latitude && place.longitude) {
            mapsUrl = `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}`;
        }

        // Calculate distance if user location available
        let distanceHtml = '';
        if (userLocation && place.latitude && place.longitude) {
            const dist = calculateDistance(userLocation.lat, userLocation.lng, place.latitude, place.longitude);
            distanceHtml = `<span class="search-result-distance">📍 ${formatDistance(dist)}</span>`;
        }

        // Format place types
        let typesHtml = '';
        if (place.place_types) {
            const types = place.place_types.split(',').slice(0, 2)
                .map(t => t.trim().replace(/_/g, ' '))
                .map(t => t.charAt(0).toUpperCase() + t.slice(1));
            typesHtml = `<span class="search-result-types">${types.join(' · ')}</span>`;
        }

        return `
            <div class="search-result-card">
                <div class="search-result-header">
                    <div class="search-result-info">
                        <div class="search-result-name">${escapeHtml(place.name)}</div>
                        <div class="search-result-address">${escapeHtml(place.address || '')}</div>
                    </div>
                    <div class="search-result-actions">
                        ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="search-result-maps" onclick="event.stopPropagation()">Maps</a>` : ''}
                        <button class="search-result-add" onclick="event.stopPropagation(); addPlaceFromSearch(${JSON.stringify(place).replace(/"/g, '&quot;')})">+ Add</button>
                    </div>
                </div>
                <div class="search-result-meta">
                    ${place.place_rating ? `<span class="search-result-rating">⭐ ${place.place_rating}${place.place_rating_count ? ` (${Number(place.place_rating_count).toLocaleString()})` : ''}</span>` : ''}
                    ${typesHtml}
                    ${distanceHtml}
                </div>
            </div>
        `;
    }).join('');
}


// Close search modal
function closeSearchModal() {
    const modal = document.getElementById('search-modal');
    modal._trapFocusCleanup?.();
    modal.style.display = 'none';
    _prevFocusEl?.focus();
    _prevFocusEl = null;
}

// Search Google Places API
async function searchGooglePlaces() {
    const input = document.getElementById('google-search-input');
    const query = input.value.trim();

    if (!query || query.length < 2) {
        showToast('Type at least 2 characters');
        return;
    }

    // Clear active state from type chips when doing custom search
    document.querySelectorAll('.search-type-chip').forEach(c => c.classList.remove('active'));

    const resultsContainer = document.getElementById('search-results');
    const loadingEl = document.getElementById('search-loading');
    const emptyEl = document.getElementById('search-empty');

    // Show loading
    resultsContainer.innerHTML = '';
    loadingEl.style.display = 'flex';
    emptyEl.style.display = 'none';

    try {
        const response = await fetch(buildSearchUrl(query, 10), {
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Search failed');

        const data = await response.json();
        loadingEl.style.display = 'none';

        if (data.results.length === 0) {
            emptyEl.style.display = 'flex';
            return;
        }

        // Sort by distance if location available
        let results = data.results;
        if (userLocation) {
            results = results.sort((a, b) => {
                const distA = (a.latitude && a.longitude) ? calculateDistance(userLocation.lat, userLocation.lng, a.latitude, a.longitude) : Infinity;
                const distB = (b.latitude && b.longitude) ? calculateDistance(userLocation.lat, userLocation.lng, b.latitude, b.longitude) : Infinity;
                return distA - distB;
            });
        }

        // Render results using shared function
        renderSearchResults(results);

    } catch (error) {
        console.error('Search error:', error);
        loadingEl.style.display = 'none';
        showToast('Search failed. Try again!');
    }
}

// Add place from search results
async function addPlaceFromSearch(place) {
    hapticFeedback('medium');

    try {
        const response = await fetch(`${API_URL}/api/places`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(place)
        });

        if (!response.ok) throw new Error('Failed to add');

        const data = await response.json();

        // Add to local state
        places.push(data.place);
        const wasEmpty = places.length === 1;

        // Close modal
        closeSearchModal();

        // Show success toast
        showToast(`Added ${place.name}! 🎉`);

        // If this is the first saved place, initialize the non-empty app UI.
        if (wasEmpty) {
            ensurePlacesUiInitialized();
        }

        // Re-render map with new place
        displayPlacesOnMap();

        // Switch to map view and show the new place
        switchView('map');

        // Pan to and highlight the new place after a short delay
        setTimeout(() => {
            if (place.latitude && place.longitude) {
                // Find and open the marker popup
                markersLayer.eachLayer(marker => {
                    if (marker.placeData && marker.placeData.id === data.place.id) {
                        focusMarkerWithPopup(marker, [place.latitude, place.longitude], 15);
                    }
                });
            }
        }, 300);

        // Also update list/review views
        applyFilters();
        updateMapFilterCounts();
        loadReviews();

    } catch (error) {
        console.error('Failed to add place:', error);
        showToast('Failed to add 😅', () => addPlaceFromSearch(place));
    }
}

// Setup search modal
function setupSearchModal() {
    document.getElementById('search-modal-close').onclick = closeSearchModal;
    document.getElementById('google-search-btn').onclick = searchGooglePlaces;

    const openModal = () => openSearchModal();
    ['btn-search-google', 'btn-search-empty'].forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.onclick = openModal;
    });

    // Search on Enter
    const searchInput = document.getElementById('google-search-input');
    if (!searchInput.dataset.bound) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') searchGooglePlaces();
        });
        searchInput.dataset.bound = 'true';
    }

    const chipContainer = document.getElementById('search-type-chips');
    if (!chipContainer.dataset.bound) {
        chipContainer.addEventListener('click', (e) => {
            const chip = e.target.closest('.search-type-chip');
            if (!chip) return;

            const type = chip.dataset.type;
            document.querySelectorAll('.search-type-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            document.getElementById('google-search-input').value = '';
            dismissSearchKeyboard();
            searchNearbyPlaces(type);
            hapticFeedback('light');
        });
        chipContainer.dataset.bound = 'true';
    }

    const resultsContainer = document.getElementById('search-results');
    if (!resultsContainer.dataset.bound) {
        resultsContainer.addEventListener('scroll', dismissSearchKeyboard, { passive: true });
        resultsContainer.dataset.bound = 'true';
    }

    // Close on backdrop click
    const modal = document.getElementById('search-modal');
    if (!modal.dataset.bound) {
        modal.addEventListener('click', (e) => {
            if (e.target.id === 'search-modal') {
                closeSearchModal();
            }
        });
        modal.dataset.bound = 'true';
    }
}

// ========== FILTER DRAWER ==========

// Temporary filter state for drawer
let drawerSort = 'distance';
let drawerCountry = '';
let drawerType = '';
let drawerRating = 0;
let drawerPriceLevel = '';
let drawerOpenNow = false;

function openFilterDrawer() {
    // Initialize drawer state from current filters
    drawerSort = sortBy;
    drawerCountry = countryFilter;
    drawerType = activeCategory;
    drawerRating = ratingFilter;
    drawerPriceLevel = priceLevelFilter;
    drawerOpenNow = openNowFilter;

    // Populate options
    populateFilterDrawerOptions();

    // Show drawer
    const drawer = document.getElementById('filter-drawer');
    _prevFocusEl = document.activeElement;
    document.getElementById('filter-btn').setAttribute('aria-expanded', 'true');
    drawer.style.display = 'flex';
    drawer._trapFocusCleanup = trapFocus(drawer);
    drawer.querySelector('button')?.focus();
    hapticFeedback('light');
}

function closeFilterDrawer() {
    const drawer = document.getElementById('filter-drawer');
    drawer._trapFocusCleanup?.();
    drawer.style.display = 'none';
    document.getElementById('filter-btn').setAttribute('aria-expanded', 'false');
    _prevFocusEl?.focus();
    _prevFocusEl = null;
}

function populateFilterDrawerOptions() {
    // Sort options
    document.querySelectorAll('#sort-options .filter-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sort === drawerSort);
    });

    // Country options
    const countryContainer = document.getElementById('country-options');
    const countries = new Set();
    places.forEach(p => {
        const country = extractCountry(p.address);
        if (country) countries.add(country);
    });

    // Hide section if no countries
    document.getElementById('country-section').style.display = countries.size > 0 ? 'block' : 'none';

    let countryHtml = `<button class="filter-option${drawerCountry === '' ? ' active' : ''}" data-country="">All</button>`;
    Array.from(countries).sort().forEach(country => {
        const isActive = drawerCountry === country ? ' active' : '';
        countryHtml += `<button class="filter-option${isActive}" data-country="${country}">${country}</button>`;
    });
    countryContainer.innerHTML = countryHtml;

    // Type options
    const typeContainer = document.getElementById('type-options');
    const types = getUniqueCategories();

    // Hide section if no types
    document.getElementById('type-section').style.display = types.length > 0 ? 'block' : 'none';

    let typeHtml = `<button class="filter-option${drawerType === '' ? ' active' : ''}" data-type="">All</button>`;
    types.forEach(type => {
        const isActive = drawerType === type ? ' active' : '';
        const displayName = type.charAt(0).toUpperCase() + type.slice(1);
        typeHtml += `<button class="filter-option${isActive}" data-type="${type}">${displayName}</button>`;
    });
    typeContainer.innerHTML = typeHtml;

    // Rating options
    document.querySelectorAll('#rating-filter-chips .filter-option').forEach(btn => {
        btn.classList.toggle('active', parseFloat(btn.dataset.rating) === drawerRating);
    });

    // Price options
    document.querySelectorAll('#price-filter-chips .filter-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.price === drawerPriceLevel);
    });

    // Open Now options
    document.querySelectorAll('#open-now-filter-chips .filter-option').forEach(btn => {
        btn.classList.toggle('active', (btn.dataset.openNow === 'true') === drawerOpenNow);
    });

    // Add click handlers
    setupFilterDrawerClicks();
}

function setupFilterDrawerClicks() {
    // Sort options
    document.querySelectorAll('#sort-options .filter-option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#sort-options .filter-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            drawerSort = btn.dataset.sort;
        });
    });

    // Country options
    document.querySelectorAll('#country-options .filter-option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#country-options .filter-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            drawerCountry = btn.dataset.country;
        });
    });

    // Type options
    document.querySelectorAll('#type-options .filter-option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#type-options .filter-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            drawerType = btn.dataset.type;
        });
    });

    // Rating options
    document.querySelectorAll('#rating-filter-chips .filter-option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#rating-filter-chips .filter-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            drawerRating = parseFloat(btn.dataset.rating);
        });
    });

    // Price options
    document.querySelectorAll('#price-filter-chips .filter-option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#price-filter-chips .filter-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            drawerPriceLevel = btn.dataset.price;
        });
    });

    // Open Now options
    document.querySelectorAll('#open-now-filter-chips .filter-option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#open-now-filter-chips .filter-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            drawerOpenNow = btn.dataset.openNow === 'true';
        });
    });
}

function applyFilterDrawer() {
    sortBy = drawerSort;
    localStorage.setItem('sortBy', sortBy);
    countryFilter = drawerCountry;
    activeCategory = drawerType;
    ratingFilter = drawerRating;
    priceLevelFilter = drawerPriceLevel;
    openNowFilter = drawerOpenNow;
    // Sync map chip
    const openNowChip = document.getElementById('open-now-chip');
    if (openNowChip) {
        openNowChip.classList.toggle('active', openNowFilter);
        openNowChip.setAttribute('aria-pressed', String(openNowFilter));
    }

    closeFilterDrawer();
    applyFilters();
    debouncedDisplayPlacesOnMap(false);
    updateFilterButton();
    renderActiveFilterPills();
}

function clearAllFilters() {
    drawerSort = 'distance';
    drawerCountry = '';
    drawerType = '';
    drawerRating = 0;
    drawerPriceLevel = '';
    drawerOpenNow = false;
    populateFilterDrawerOptions();
}

function setupFilterDrawer() {
    document.getElementById('filter-btn').addEventListener('click', openFilterDrawer);
    document.getElementById('filter-drawer-close').addEventListener('click', closeFilterDrawer);
    document.getElementById('filter-apply').addEventListener('click', applyFilterDrawer);
    document.getElementById('filter-clear-all').addEventListener('click', clearAllFilters);

    // Close on backdrop click
    document.getElementById('filter-drawer').addEventListener('click', (e) => {
        if (e.target.id === 'filter-drawer') {
            closeFilterDrawer();
        }
    });
}

function updateFilterButton() {
    const btn = document.getElementById('filter-btn');
    const countEl = btn.querySelector('.filter-count');

    // Count active filters (distance is silent default, not counted)
    let count = 0;
    if (sortBy !== 'distance') count++;
    if (countryFilter) count++;
    if (activeCategory) count++;
    if (ratingFilter) count++;
    if (priceLevelFilter) count++;

    if (count > 0) {
        btn.classList.add('has-filters');
        countEl.textContent = count;
        countEl.style.display = 'flex';
    } else {
        btn.classList.remove('has-filters');
        countEl.style.display = 'none';
    }
}

function renderActiveFilterPills() {
    const container = document.getElementById('active-filters');
    let html = '';

    if (countryFilter) {
        html += `<span class="filter-pill">
            ${countryFilter}
            <button class="filter-pill-remove" onclick="removeFilter('country')">×</button>
        </span>`;
    }

    if (activeCategory) {
        const displayName = activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1);
        html += `<span class="filter-pill">
            ${displayName}
            <button class="filter-pill-remove" onclick="removeFilter('type')">×</button>
        </span>`;
    }

    if (sortBy !== 'distance') {
        const sortLabels = { newest: 'Newest', name: 'A-Z', rating: 'Top Rated', favourites: 'Favourites' };
        html += `<span class="filter-pill">
            ${sortLabels[sortBy] || sortBy}
            <button class="filter-pill-remove" onclick="removeFilter('sort')">×</button>
        </span>`;
    }

    if (ratingFilter) {
        html += `<span class="filter-pill">
            ${ratingFilter}+ ⭐
            <button class="filter-pill-remove" onclick="removeFilter('rating')">×</button>
        </span>`;
    }

    if (priceLevelFilter) {
        html += `<span class="filter-pill">
            ${PLACE_PRICE_LABELS[priceLevelFilter] || priceLevelFilter}
            <button class="filter-pill-remove" onclick="removeFilter('price')">×</button>
        </span>`;
    }

    container.innerHTML = html;
}

function removeFilter(type) {
    if (type === 'country') countryFilter = '';
    if (type === 'type') activeCategory = '';
    if (type === 'sort') sortBy = 'distance';
    if (type === 'rating') ratingFilter = 0;
    if (type === 'price') priceLevelFilter = '';

    applyFilters();
    debouncedDisplayPlacesOnMap(false);
    updateFilterButton();
    renderActiveFilterPills();
}

// ========== FILTER CHIP COUNTS ==========

// Update list view visited chip counts
function updateVisitedChipCounts() {
    const allCount = places.length;
    const visitedCount = places.filter(p => p.is_visited).length;
    const unvisitedCount = allCount - visitedCount;

    document.querySelectorAll('.visited-chip').forEach(chip => {
        const countEl = chip.querySelector('.chip-count');
        if (!countEl) return;

        switch (chip.dataset.filter) {
            case 'all':
                countEl.textContent = allCount > 0 ? `(${allCount})` : '';
                break;
            case 'visited':
                countEl.textContent = visitedCount > 0 ? `(${visitedCount})` : '';
                break;
            case 'unvisited':
                countEl.textContent = unvisitedCount > 0 ? `(${unvisitedCount})` : '';
                break;
        }
    });

}

// Update map view filter chip counts
function updateMapFilterCounts() {
    const allCount = places.length;
    const visitedCount = places.filter(p => p.is_visited).length;
    const unvisitedCount = allCount - visitedCount;

    document.querySelectorAll('.map-filter-chip').forEach(chip => {
        const filter = chip.dataset.filter;
        if (!filter) return; // skip chips with no data-filter (e.g. Open Now)

        let count = 0;
        switch (filter) {
            case 'all':      count = allCount;       break;
            case 'visited':  count = visitedCount;   break;
            case 'unvisited': count = unvisitedCount; break;
        }

        if (filter === 'open-now') return; // preserve its own label/emoji
        const baseText = filter === 'all' ? 'All' : filter === 'visited' ? 'Visited' : 'To Visit';
        chip.textContent = count > 0 ? `${baseText} (${count})` : baseText;
    });
}

// Update review filter chip counts
function updateReviewFilterCounts() {
    // Filter chips removed — no-op
}

// Update all filter counts
function updateAllFilterCounts() {
    updateVisitedChipCounts();
    updateMapFilterCounts();
    updateReviewFilterCounts();
}

// Switch view (within map tab: map / list / reviews)
function switchView(view) {
    currentView = view;
    document.querySelector('.app-main')?.setAttribute('data-view', view);

    // Update toggle buttons (may not exist in new bottom-nav UI)
    document.getElementById('btn-map')?.classList.toggle('active', view === 'map');
    document.getElementById('btn-list')?.classList.toggle('active', view === 'list');
    document.getElementById('btn-reviews')?.classList.toggle('active', view === 'reviews');
    document.getElementById('btn-map')?.setAttribute('aria-pressed', String(view === 'map'));
    document.getElementById('btn-list')?.setAttribute('aria-pressed', String(view === 'list'));
    document.getElementById('btn-reviews')?.setAttribute('aria-pressed', String(view === 'reviews'));

    // Update view visibility
    document.getElementById('map-view').classList.toggle('active', view === 'map');
    document.getElementById('list-view').classList.toggle('active', view === 'list');
    document.getElementById('reviews-view').classList.toggle('active', view === 'reviews');

    // Invalidate map size when switching to map view
    if (view === 'map' && map) {
        setTimeout(() => map.invalidateSize(), 100);
        setTimeout(() => map.invalidateSize(), 450);
    }
}

// View toggle event listeners
function setupViewToggle() {
    document.getElementById('btn-map')?.addEventListener('click', () => switchView('map'));
    document.getElementById('btn-list')?.addEventListener('click', () => switchView('list'));
    document.getElementById('btn-reviews')?.addEventListener('click', () => switchView('reviews'));
}

// Initialize app
async function initApp() {
    // Initialize Telegram
    const tg = initTelegram();
    setupIntentTracking();
    trackEvent(IS_SHARE_MAP ? 'shared_map_opened' : 'mini_app_opened', {
        entityType: 'session',
        metadata: { source: IS_SHARE_MAP ? 'shared_map' : 'telegram', tab: 'saved' },
    });

    // Apply theme immediately
    applyTheme();

    // Setup view toggle
    setupViewToggle();

    // Global Escape key handler — close whichever overlay is open
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
if (document.getElementById('review-sheet')?.style.display === 'flex') { closeReviewSheet(); return; }
        if (document.getElementById('search-modal')?.style.display === 'flex') { closeSearchModal(); return; }
        if (document.getElementById('filter-drawer')?.style.display === 'flex') { closeFilterDrawer(); return; }
        if (document.getElementById('reviews-filter-drawer')?.style.display === 'flex') { closeReviewsFilterDrawer(); return; }
        if (document.getElementById('notes-modal')?.style.display === 'flex') { closeNotesModal(); return; }
        if (document.getElementById('place-menu')?.style.display === 'flex') { closePlaceMenu(); return; }
    });

    // Initialize map
    initMap();

    // Setup map controls
    setupMapControls();

    // Setup manual discovery triggers regardless of saved-place state
    setupSearchModal();

    // Show loading
    showLoading();

    // Fetch places first so the main UI can render immediately.
    // Location and reviews are loaded in the background afterward.
    const fetchResult = await fetchPlaces();

    // Hide loading
    hideLoading();

    // Check for API error
    if (!fetchResult.success) {
        console.error('API error:', fetchResult.error);
        showErrorState(fetchResult.error);
        return;
    }

    places = fetchResult.places;
    totalPlaces = fetchResult.total || 0;
    hasMorePlaces = fetchResult.has_more || false;
    currentPlacesPage = 1;

    // Check if empty
    if (places.length === 0) {
        showEmptyState();
        // Request location so discover search is location-biased even for new users
        requestUserLocation(false);
        // Still initialize nav and social state so tabs + friend requests work
        currentTab = null;
        switchTab('saved');
        loadFriendRequests();
        return;
    }

    // Fire geolocation without blocking — it calls applyFilters() + re-centers map
    // internally once GPS resolves. Map starts at fit-bounds view immediately.
    requestUserLocation(true);
    // Reviews must be loaded before map markers are created so popup content
    // correctly shows the reviewed vs un-reviewed card on first render.
    await loadReviews();

    displayPlacesOnMap(true);

    ensurePlacesUiInitialized();

    // Render list view
    renderPlacesList(places);

    // Update all filter counts
    updateMapFilterCounts();
    updateVisitedChipCounts();

    if (IS_SHARE_MAP) {
        showShareBanner();
    }


    // Show saved tab by default (main home screen), force map view on load
    currentTab = null;
    switchTab('saved');

    // Load friend request badge in background
    loadFriendRequests();

    // Load collections in background
    loadCollections();

    // Handle Telegram startapp deep link param
    await routeStartParam(INITIAL_START_PARAM);
}

// ========== REVIEW SHEET ==========

// Review state
let currentReviewPlaceId = null;
let currentReview = null;
let dishChips = [];       // [{localId, persistedId, name}]
let chipIdCounter = 0;

const PRICE_LABELS = ['', 'Cheap', 'Affordable', 'Moderate', 'Pricey', 'Expensive'];


// Initialize price rating component
function initPriceRating(container, onChange) {
    container.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
        const icon = document.createElement('button');
        icon.type = 'button';
        icon.className = 'price-icon';
        icon.textContent = '💰';
        icon.dataset.value = i;
        icon.setAttribute('aria-label', `Price level ${i}`);
        container.appendChild(icon);
    }

    const updatePrice = (rating, hoverValue = null) => {
        container.querySelectorAll('.price-icon').forEach((icon, idx) => {
            const val = idx + 1;
            icon.classList.toggle('filled', val <= rating);
            icon.classList.toggle('hovered', hoverValue !== null && val <= hoverValue);
        });
        // Update label
        const label = document.getElementById('price-label');
        if (label) {
            label.textContent = PRICE_LABELS[rating] || '';
        }
    };

    container.addEventListener('click', (e) => {
        const icon = e.target.closest('.price-icon');
        if (!icon) return;
        const value = parseInt(icon.dataset.value);
        container.dataset.rating = value;
        updatePrice(value);
        hapticFeedback('light');
        if (onChange) onChange(value);
    });

    container.addEventListener('mouseover', (e) => {
        const icon = e.target.closest('.price-icon');
        if (!icon) return;
        const hoverVal = parseInt(icon.dataset.value);
        updatePrice(parseInt(container.dataset.rating), hoverVal);
        // Show hover label
        const label = document.getElementById('price-label');
        if (label) label.textContent = PRICE_LABELS[hoverVal] || '';
    });

    container.addEventListener('mouseleave', () => {
        const rating = parseInt(container.dataset.rating);
        updatePrice(rating);
    });

    // Set initial state
    updatePrice(parseInt(container.dataset.rating) || 0);
}

// ========== DISH CHIPS ==========

function addDishChip(name, persistedId = null, rating = null) {
    if (!name.trim()) return;
    const localId = `chip-${++chipIdCounter}`;
    dishChips.push({ localId, persistedId, name: name.trim(), rating });
    renderDishChips();
}

function removeDishChip(localId) {
    dishChips = dishChips.filter(c => c.localId !== localId);
    renderDishChips();
}

function renderDishChips() {
    const container = document.getElementById('dish-chips-container');
    if (!container) return;
    container.querySelectorAll('.dish-chip-wrap').forEach(el => el.remove());
    const trigger = container.querySelector('#dish-add-trigger');
    dishChips.forEach(chip => {
        const wrap = document.createElement('div');
        wrap.className = 'dish-chip-wrap';

        // Chip row
        const chipEl = document.createElement('span');
        chipEl.className = 'dish-chip';
        chipEl.innerHTML = `<span class="dish-chip-name">${escapeHtml(chip.name)}</span><button type="button" class="dish-chip-remove" aria-label="Remove ${escapeHtml(chip.name)}">×</button>`;
        chipEl.querySelector('.dish-chip-remove').addEventListener('click', () => removeDishChip(chip.localId));

        // Score circles row (1-10, optional)
        const scoreRow = document.createElement('div');
        scoreRow.className = 'dish-score-circles';
        for (let i = 1; i <= 10; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'score-circle score-circle--dish';
            btn.dataset.val = i;
            btn.textContent = i;
            if (chip.rating) {
                if (i === chip.rating) btn.classList.add('active');
                else if (i < chip.rating) btn.classList.add('filled');
            }
            btn.addEventListener('click', () => {
                chip.rating = chip.rating === i ? null : i;
                scoreRow.querySelectorAll('.score-circle--dish').forEach(c => {
                    const val = parseInt(c.dataset.val);
                    c.classList.remove('active', 'filled');
                    if (chip.rating) {
                        if (val === chip.rating) c.classList.add('active');
                        else if (val < chip.rating) c.classList.add('filled');
                    }
                });
            });
            scoreRow.appendChild(btn);
        }

        wrap.appendChild(chipEl);
        wrap.appendChild(scoreRow);
        container.insertBefore(wrap, trigger);
    });
}

function setupDishChipInput() {
    const input = document.getElementById('dish-chip-input');
    const label = document.getElementById('dish-add-label');
    const inputWrap = document.getElementById('dish-add-input-wrap');
    const confirmBtn = document.getElementById('dish-chip-confirm-btn');
    if (!input || !label || !inputWrap) return;

    function openInput() {
        label.style.display = 'none';
        inputWrap.style.display = 'flex';
        input.focus();
    }

    function commitAndClose() {
        const name = input.value.trim().replace(/,$/, '');
        if (name) addDishChip(name);
        input.value = '';
        inputWrap.style.display = 'none';
        label.style.display = '';
    }

    label.addEventListener('click', openInput);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commitAndClose();
        }
        if (e.key === 'Escape') {
            input.value = '';
            commitAndClose();
        }
    });

    input.addEventListener('change', () => commitAndClose());

    input.addEventListener('blur', (e) => {
        // Delay so confirmBtn click fires first
        setTimeout(() => commitAndClose(), 150);
    });

    if (confirmBtn) {
        confirmBtn.addEventListener('mousedown', (e) => e.preventDefault()); // prevent blur
        confirmBtn.addEventListener('click', () => commitAndClose());
    }
}

// ========== REVIEW FORM HELPERS ==========

const SENTIMENT_EMOJI = { loved: '🤩', okay: '👍', meh: '😐' };
const SENTIMENT_TO_RATING = { loved: 5, okay: 3, meh: 1 };

// Inject 1-10 circles into each score row (called once on init)
function initScoreCircles() {
    ['food-score', 'vibe-score', 'value-score'].forEach(id => {
        const container = document.getElementById(id);
        if (!container || container.children.length > 0) return;
        for (let i = 1; i <= 10; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'score-circle';
            btn.dataset.val = i;
            btn.textContent = i;
            btn.addEventListener('click', () => {
                const current = parseInt(container.dataset.score) || 0;
                const newVal = current === i ? 0 : i;
                container.dataset.score = newVal || '';
                updateScoreCircles(container, newVal);
            });
            container.appendChild(btn);
        }
    });
}

function updateScoreCircles(container, value) {
    container.querySelectorAll('.score-circle').forEach(btn => {
        const val = parseInt(btn.dataset.val);
        btn.classList.remove('active', 'filled');
        if (value !== 0) {
            if (val === value) btn.classList.add('active');
            else if (val < value) btn.classList.add('filled');
        }
    });
}

function initSentimentButtons() {
    document.querySelectorAll('.sentiment-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sentiment-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('sentiment-group')?.classList.remove('invalid');
        });
    });
}

function getReviewFormValidation() {
    const missing = [];
    const elements = [];

    const sentiment = document.querySelector('.sentiment-btn.active')?.dataset.sentiment;
    if (!sentiment) {
        missing.push('Overall vibe (Loved it / Okay / Meh)');
        elements.push(document.getElementById('sentiment-group'));
    }
    const foodScore = parseInt(document.getElementById('food-score')?.dataset.score) || 0;
    if (!foodScore) {
        missing.push('Food rating');
        elements.push(document.getElementById('food-score'));
    }
    const vibeScore = parseInt(document.getElementById('vibe-score')?.dataset.score) || 0;
    if (!vibeScore) {
        missing.push('Vibe rating');
        elements.push(document.getElementById('vibe-score'));
    }
    const valueScore = parseInt(document.getElementById('value-score')?.dataset.score) || 0;
    if (!valueScore) {
        missing.push('Value rating');
        elements.push(document.getElementById('value-score'));
    }

    if (missing.length > 0) {
        return {
            valid: false,
            message: `Please fill in: ${missing.join(', ')}`,
            elements,
        };
    }
    return { valid: true };
}

function getReviewFormPayload() {
    const sentiment = document.querySelector('.sentiment-btn.active')?.dataset.sentiment || null;
    const foodScore = parseInt(document.getElementById('food-score')?.dataset.score) || null;
    const vibeScore = parseInt(document.getElementById('vibe-score')?.dataset.score) || null;
    const valueScore = parseInt(document.getElementById('value-score')?.dataset.score) || null;
    const caption = document.getElementById('overall-remarks')?.value.trim() || null;
    const isPublic = document.getElementById('review-is-public')?.checked ?? true;
    return {
        sentiment,
        food_score: foodScore,
        vibe_score: vibeScore,
        value_score: valueScore,
        caption,
        is_public: isPublic,
        // Legacy bridge: keep overall_rating + overall_remarks for DB compat until migration
        overall_rating: SENTIMENT_TO_RATING[sentiment] || 3,
        price_rating: 0,
        overall_remarks: caption,
        dishes: dishChips.map(c => {
            const d = c.persistedId ? { id: c.persistedId, name: c.name } : { name: c.name };
            if (c.rating != null) d.rating = c.rating;
            return d;
        }),
    };
}

// Populate review form from currentReview (or blank for new)
function populateReviewForm() {
    // Sentiment
    const sentiment = currentReview?.sentiment || null;
    document.querySelectorAll('.sentiment-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sentiment === sentiment);
    });

    // Scores
    [['food-score', 'food_score'], ['vibe-score', 'vibe_score'], ['value-score', 'value_score']].forEach(([elId, field]) => {
        const container = document.getElementById(elId);
        if (!container) return;
        const score = currentReview?.[field] || 0;
        container.dataset.score = score || '';
        updateScoreCircles(container, score);
    });

    // Caption
    document.getElementById('overall-remarks').value = currentReview?.caption || currentReview?.overall_remarks || '';

    // Dish chips
    dishChips = [];
    chipIdCounter = 0;
    (currentReview?.dishes || []).forEach(d => addDishChip(d.name, d.id, d.rating ?? null));
    renderDishChips();

    // Photos
    const photosGrid = document.getElementById('overall-photos');
    updatePhotoGrid(photosGrid, [...(currentReview?.overall_photos || []), ...getPendingPhotos()], 10, null);

    // Privacy toggle
    const isPublicToggle = document.getElementById('review-is-public');
    if (isPublicToggle) isPublicToggle.checked = currentReview?.is_public ?? true;

    // Delete button only for existing reviews
    document.getElementById('delete-review-btn').style.display = currentReview ? 'block' : 'none';

    clearReviewValidationState();
}

function clearReviewValidationState() {
    const errorEl = document.getElementById('review-form-error');
    if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }
    document.getElementById('sentiment-group')?.classList.remove('invalid');
    document.querySelectorAll('.score-circles.invalid').forEach(el => el.classList.remove('invalid'));
    document.querySelectorAll('.dish-card.invalid').forEach(card => card.classList.remove('invalid'));
}

function showReviewValidationError(message, elements = []) {
    const errorEl = document.getElementById('review-form-error');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.style.display = 'block';
    }

    const elArray = Array.isArray(elements) ? elements : [elements];
    elArray.forEach((el, i) => {
        if (!el) return;
        el.classList.add('invalid');
        if (i === 0) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    showToast(message, null, 4000);
}

let pendingOverallPhotos = [];
let pendingPhotoIdCounter = 0;
let _reviewPhotos = [];          // single ordered source-of-truth for the photo grid
let _pdSrc = null, _pdSrcIdx = -1, _pdTargetIdx = -1;  // drag state
let _pdClone = null, _pdOffX = 0, _pdOffY = 0;

function resetPendingReviewPhotos() {
    pendingOverallPhotos = [];
    _reviewPhotos = [];
}

function getPendingPhotos() {
    return pendingOverallPhotos;
}

async function queuePendingPhoto(file) {
    const previewUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
    });
    const pendingPhoto = {
        localId: `pending-${++pendingPhotoIdCounter}`,
        pending: true,
        file,
        previewUrl,
    };
    pendingOverallPhotos.push(pendingPhoto);
    return pendingPhoto;
}

function removePendingPhoto(localId) {
    pendingOverallPhotos = pendingOverallPhotos.filter(photo => photo.localId !== localId);
}

async function flushPendingReviewPhotos(reviewId) {
    for (const photo of pendingOverallPhotos) {
        await uploadPhoto(reviewId, photo.file, null);
    }
    pendingOverallPhotos = [];
}

// Open review/visit sheet ("Been here?" entry point)
function openBeenHereSheet(placeId) {
    openReviewSheet(placeId);
}

// Open review sheet from RC — closes RC first, reopens it after save
function openReviewFromRc(placeId) {
    _rcAfterReview = placeId;
    closeRestaurantCard();
    openReviewSheet(placeId);
}

// Open review sheet for a place
async function openReviewSheet(placeId) {
    resetPendingReviewPhotos();
    currentReviewPlaceId = placeId;
    const pnParam = new URLSearchParams(window.location.search).get('pn');
    const place = places.find(p => p.id === placeId)
        || (pnParam ? { id: placeId, name: decodeURIComponent(pnParam) } : null);
    if (!place) return;

    document.getElementById('review-sheet-title').textContent = 'Review';
    document.getElementById('review-sheet-place').textContent = place.name;

    const sheet = document.getElementById('review-sheet');
    _prevFocusEl = document.activeElement;
    sheet.style.display = 'flex';
    sheet._trapFocusCleanup = trapFocus(sheet);
    sheet.classList.add('loading');
    hapticFeedback('light');

    try {
        const response = await fetch(`${API_URL}/api/places/${placeId}/review`, {
            headers: getAuthHeaders()
        });
        sheet.classList.remove('loading');
        currentReview = response.ok ? (await response.json()).review : null;
    } catch (error) {
        console.error('Failed to load review:', error);
        sheet.classList.remove('loading');
        currentReview = null;
    }

    populateReviewForm();
}

// Close review sheet
function closeReviewSheet() {
    const sheet = document.getElementById('review-sheet');
    sheet._trapFocusCleanup?.();
    sheet.style.display = 'none';
    currentReviewPlaceId = null;
    currentReview = null;
    resetPendingReviewPhotos();
    _prevFocusEl?.focus();
    _prevFocusEl = null;
    // If user cancelled (not saved), discard the pending RC reopen
    _rcAfterReview = null;
}


// Setup swipe-to-close gesture for bottom sheets
function setupSheetGestures(sheetEl, closeFn) {
    const content = sheetEl.querySelector('.sheet-content');
    if (!content) return;

    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    content.addEventListener('touchstart', (e) => {
        // Only drag from header area (near handle), not sheet-body
        if (e.target.closest('.sheet-body')) return;
        startY = e.touches[0].clientY;
        isDragging = true;
        content.style.transition = 'none';
    });

    content.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        currentY = e.touches[0].clientY - startY;
        // Only allow dragging down
        if (currentY > 0) {
            content.style.transform = `translateY(${currentY}px)`;
        }
    });

    content.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        content.style.transition = 'transform 0.3s ease';
        if (currentY > 100) {
            closeFn();
        }
        content.style.transform = '';
        currentY = 0;
    });
}

// Save review
async function saveReview() {
    if (!currentReviewPlaceId) return;

    clearReviewValidationState();
    const validation = getReviewFormValidation();
    if (!validation.valid) {
        showReviewValidationError(validation.message, validation.elements || [validation.element]);
        return;
    }

    const saveButton = document.getElementById('save-review-btn');
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';
    }

    hapticFeedback('medium');

    try {
        const response = await fetch(`${API_URL}/api/places/${currentReviewPlaceId}/review`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(getReviewFormPayload())
        });

        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            console.error('Save review failed:', response.status, errBody);
            throw new Error('Failed to save review');
        }

        const data = await response.json();
        currentReview = data.review;

        await flushPendingReviewPhotos(currentReview.id);

        // Refresh review data after photo upload
        const refreshed = await fetch(`${API_URL}/api/places/${currentReviewPlaceId}/review`, {
            headers: getAuthHeaders()
        });
        if (refreshed.ok) {
            currentReview = (await refreshed.json()).review;
        }

        // Auto-mark visited when saving review (if not already)
        const reviewedPlace = places.find(p => p.id === currentReviewPlaceId);
        if (reviewedPlace && !reviewedPlace.is_visited) {
            reviewedPlace.is_visited = true;
            fetch(`${API_URL}/api/places/${currentReviewPlaceId}`, {
                method: 'PATCH',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_visited: true })
            }).catch(e => console.error('Failed to mark visited:', e));
        }

        showSuccessAnimation();
        const savedForPlaceId = currentReviewPlaceId;
        const rcToReopen = _rcAfterReview;
        _rcAfterReview = null;
        closeReviewSheet();

        await loadReviews();
        applyFilters();
        displayPlacesOnMap(false);

        // Update feed card badges to "✓ You visited · date" for this place
        const reviewedPlaceObj = places.find(p => p.id === savedForPlaceId);
        if (reviewedPlaceObj?.google_place_id && typeof feedActivitiesMap !== 'undefined') {
            const visitedDate = ` · ${formatShortDate(new Date().toISOString())}`;
            const visitedBadgeHtml = `<span class="fc-state-badge fc-state-visited">✓ You visited${visitedDate}</span>`;
            Object.entries(feedActivitiesMap).forEach(([aid, activity]) => {
                if (activity.google_place_id !== reviewedPlaceObj.google_place_id) return;
                if (activity.user_place_state) {
                    activity.user_place_state.visited = true;
                    activity.user_place_state.saved = true;
                }
                const cardEl = document.getElementById(`fc-${aid}`);
                if (!cardEl) return;
                // Remove right-side CTAs
                cardEl.querySelector('.fc-quick-save')?.remove();
                cardEl.querySelector('.fc-notif-save')?.remove();
                cardEl.querySelector('.fc-notif-state')?.remove();
                // Update existing badge or inject below place name
                const existing = cardEl.querySelector('.fc-state-badge');
                if (existing) {
                    existing.outerHTML = visitedBadgeHtml;
                } else {
                    cardEl.querySelector('.fc-actor-block')?.insertAdjacentHTML('beforeend', visitedBadgeHtml);
                    cardEl.querySelector('.fc-notif-body')?.insertAdjacentHTML('beforeend', visitedBadgeHtml);
                }
            });
        }

        // Reopen RC on the saved place
        const placeToReopen = rcToReopen || (rcCurrentPlaceId === savedForPlaceId ? savedForPlaceId : null);
        if (placeToReopen) {
            openRestaurantCard(placeToReopen);
        }

    } catch (error) {
        console.error('Failed to save review:', error);
        showToast('Failed to save review. Please try again.');
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = 'Save Review';
        }
    }
}

// Silently delete review for a place (no confirm, used when unvisiting)
async function deleteReviewForPlace(placeId) {
    try {
        const response = await fetch(`${API_URL}/api/places/${placeId}/review`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error('Failed to delete review');
        await loadReviews();
    } catch (error) {
        console.error('Failed to delete review:', error);
    }
}

// Delete review
async function deleteReview() {
    if (!currentReviewPlaceId) return;

    if (!confirm('Remove this visit? Your review will be deleted too.')) return;

    hapticFeedback('medium');

    try {
        const response = await fetch(`${API_URL}/api/places/${currentReviewPlaceId}/review`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });

        if (!response.ok) throw new Error('Failed to delete review');

        // Unmark visited
        const unvisitPlace = places.find(p => p.id === currentReviewPlaceId);
        if (unvisitPlace) {
            unvisitPlace.is_visited = false;
            fetch(`${API_URL}/api/places/${currentReviewPlaceId}`, {
                method: 'PATCH',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_visited: false })
            }).catch(e => console.error('Failed to unmark visited:', e));
        }

        showToast('Visit removed');
        closeReviewSheet();

        // Reload reviews and refresh displays
        await loadReviews();
        applyFilters();
        displayPlacesOnMap(false);

    } catch (error) {
        console.error('Failed to delete review:', error);
        showToast('Failed to delete review 😅', deleteReview);
    }
}

// ========== PHOTO UPLOAD & DISPLAY ==========

/**
 * Compress image to max 1MB while maintaining quality
 * @param {File} file - Original image file
 * @param {number} maxSizeKB - Max size in KB (default 1000 = 1MB)
 * @returns {Promise<Blob>} - Compressed image blob
 */
async function compressImage(file, maxSizeKB = 1000) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Scale down if too large (max 1920px on longest side)
                const maxDimension = 1920;
                if (width > maxDimension || height > maxDimension) {
                    if (width > height) {
                        height = Math.round(height * maxDimension / width);
                        width = maxDimension;
                    } else {
                        width = Math.round(width * maxDimension / height);
                        height = maxDimension;
                    }
                }

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Start with high quality, reduce if needed
                let quality = 0.9;
                const tryCompress = () => {
                    canvas.toBlob((blob) => {
                        if (blob.size / 1024 <= maxSizeKB || quality <= 0.1) {
                            resolve(blob);
                        } else {
                            quality -= 0.1;
                            tryCompress();
                        }
                    }, 'image/jpeg', quality);
                };
                tryCompress();
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Validate image file before processing
 */
function validateImageFile(file) {
    if (!file.type || !file.type.startsWith('image/')) {
        return { valid: false, error: `Can't upload that file type (${file.type || 'unknown'}). Please choose a photo (JPEG, PNG, HEIC, etc.)` };
    }
    if (file.size > 10 * 1024 * 1024) {
        return { valid: false, error: 'Photo too large — please use one under 10MB' };
    }
    return { valid: true };
}

/**
 * Upload photo to server
 */
async function uploadPhoto(reviewId, file, dishId = null) {
    // Validate file
    const validation = validateImageFile(file);
    if (!validation.valid) {
        showToast(validation.error);
        return null;
    }

    // Show uploading state
    showToast('Uploading photo...');

    try {
        // Compress image
        const compressed = await compressImage(file);

        // Create form data
        const formData = new FormData();
        formData.append('file', compressed, 'photo.jpg');
        if (dishId && !String(dishId).startsWith('new-')) {
            formData.append('dish_id', dishId);
        }

        // Upload to API
        const response = await fetch(`${API_URL}/api/reviews/${reviewId}/photos`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: formData
        });

        if (response.ok) {
            const data = await response.json();
            showToast('Photo added!');
            return data.photo;
        } else {
            const error = await response.json();
            showToast(error.detail || 'Failed to upload photo');
            return null;
        }
    } catch (e) {
        console.error('Photo upload error:', e);
        showToast('Error uploading photo');
        return null;
    }
}

/**
 * Upload photo with progress callback using XMLHttpRequest
 */
async function uploadPhotoWithProgress(reviewId, file, dishId = null, onProgress) {
    try {
        // Compress image first
        const compressed = await compressImage(file);

        // Create form data
        const formData = new FormData();
        formData.append('file', compressed, 'photo.jpg');
        if (dishId && !String(dishId).startsWith('new-')) {
            formData.append('dish_id', dishId);
        }

        // Use XMLHttpRequest for progress tracking
        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable && onProgress) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    onProgress(percent);
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const response = JSON.parse(xhr.responseText);
                        showToast('Photo added!');
                        resolve(response.photo);
                    } catch {
                        showToast('Error processing response');
                        resolve(null);
                    }
                } else {
                    try {
                        const error = JSON.parse(xhr.responseText);
                        showToast(error.detail || 'Failed to upload photo');
                    } catch {
                        showToast('Failed to upload photo');
                    }
                    resolve(null);
                }
            });

            xhr.addEventListener('error', () => {
                showToast('Error uploading photo');
                resolve(null);
            });

            xhr.open('POST', `${API_URL}/api/reviews/${reviewId}/photos`);
            // Add auth headers
            const authHeaders = getAuthHeaders();
            Object.keys(authHeaders).forEach(key => {
                xhr.setRequestHeader(key, authHeaders[key]);
            });
            xhr.send(formData);
        });
    } catch (e) {
        console.error('Photo upload error:', e);
        showToast('Error uploading photo');
        return null;
    }
}

/**
 * Delete photo from server
 */
async function deletePhoto(reviewId, photoId) {
    try {
        const response = await fetch(
            `${API_URL}/api/reviews/${reviewId}/photos/${photoId}`,
            {
                method: 'DELETE',
                headers: getAuthHeaders()
            }
        );

        if (response.ok) {
            showToast('Photo removed');
            return true;
        } else {
            showToast('Failed to remove photo');
            return false;
        }
    } catch (e) {
        showToast('Error removing photo');
        return false;
    }
}

/**
 * Update photo grid with photos and add button
 */
function _pdAddDragListeners(thumb, container, maxPhotos, dishId) {
    thumb.addEventListener('touchstart', e => {
        if (e.target.closest('.photo-delete-btn') || e.touches.length !== 1) return;
        const thumbs = [...container.querySelectorAll('.photo-thumb')];
        _pdSrcIdx = thumbs.indexOf(thumb);
        _pdSrc = thumb;
        _pdTargetIdx = _pdSrcIdx;

        const t = e.touches[0];
        const rect = thumb.getBoundingClientRect();
        _pdOffX = t.clientX - rect.left;
        _pdOffY = t.clientY - rect.top;

        _pdClone = thumb.cloneNode(true);
        Object.assign(_pdClone.style, {
            position: 'fixed',
            width: rect.width + 'px', height: rect.height + 'px',
            left: rect.left + 'px', top: rect.top + 'px',
            zIndex: '9999', pointerEvents: 'none',
            opacity: '0.92', transform: 'scale(1.1)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            borderRadius: '12px', overflow: 'hidden', transition: 'none',
        });
        document.body.appendChild(_pdClone);
        thumb.style.opacity = '0.25';

        function onMove(ev) {
            if (!_pdClone) return;
            ev.preventDefault();
            const touch = ev.touches[0];
            _pdClone.style.left = (touch.clientX - _pdOffX) + 'px';
            _pdClone.style.top = (touch.clientY - _pdOffY) + 'px';

            _pdClone.style.visibility = 'hidden';
            const el = document.elementFromPoint(touch.clientX, touch.clientY);
            _pdClone.style.visibility = '';
            const over = el?.closest('.photo-thumb');
            if (over && over !== _pdSrc) {
                const newIdx = [...container.querySelectorAll('.photo-thumb')].indexOf(over);
                if (newIdx >= 0 && newIdx !== _pdTargetIdx) {
                    _pdTargetIdx = newIdx;
                    container.querySelectorAll('.photo-thumb').forEach((th, i) => {
                        th.style.outline = (i === newIdx) ? '2px solid var(--sprout-green, #4caf50)' : '';
                        th.style.opacity = (th === _pdSrc) ? '0.25' : '';
                    });
                }
            }
        }

        function onEnd() {
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            if (_pdClone) { _pdClone.remove(); _pdClone = null; }
            if (_pdSrc) _pdSrc.style.opacity = '';
            container.querySelectorAll('.photo-thumb').forEach(th => {
                th.style.outline = '';
                th.style.opacity = '';
            });
            if (_pdTargetIdx !== _pdSrcIdx && _pdTargetIdx >= 0 && _pdTargetIdx < _reviewPhotos.length) {
                const moved = _reviewPhotos.splice(_pdSrcIdx, 1)[0];
                _reviewPhotos.splice(_pdTargetIdx, 0, moved);
                // Keep pendingOverallPhotos in sync with new pending order
                const newPending = _reviewPhotos.filter(p => p.pending);
                pendingOverallPhotos.splice(0, pendingOverallPhotos.length, ...newPending);
                updatePhotoGrid(container, [..._reviewPhotos], maxPhotos, dishId);
            }
            _pdSrc = null; _pdSrcIdx = -1; _pdTargetIdx = -1;
        }

        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd, { passive: true });
    }, { passive: true });
}

function updatePhotoGrid(container, photos, maxPhotos, dishId = null) {
    _reviewPhotos = [...photos];
    container.innerHTML = '';

    photos.forEach((photo) => {
        const thumb = document.createElement('div');
        thumb.className = 'photo-thumb';
        thumb.dataset.photoId = photo.id || photo.localId;
        thumb.innerHTML = `
            <img src="${photo.url || photo.previewUrl}" alt="Photo">
            <button type="button" class="photo-delete-btn" aria-label="Remove photo">×</button>
        `;

        thumb.querySelector('.photo-delete-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (photo.pending) {
                removePendingPhoto(photo.localId);
                _reviewPhotos = _reviewPhotos.filter(p => (p.id || p.localId) !== photo.localId);
                updatePhotoGrid(container, [..._reviewPhotos], maxPhotos, dishId);
                return;
            }
            if (!currentReview?.id) return;
            if (await deletePhoto(currentReview.id, photo.id)) {
                _reviewPhotos = _reviewPhotos.filter(p => p.id !== photo.id);
                updatePhotoGrid(container, [..._reviewPhotos], maxPhotos, dishId);
            }
        });

        _pdAddDragListeners(thumb, container, maxPhotos, dishId);
        container.appendChild(thumb);
    });

    if (photos.length < maxPhotos) {
        addPhotoButton(container, maxPhotos, dishId);
    }
}

/**
 * Add photo upload button to grid
 */
function addPhotoButton(container, maxPhotos, dishId) {
    if (container.querySelector('.photo-add-btn')) return;
    if (container.querySelectorAll('.photo-thumb').length >= maxPhotos) return;

    const label = document.createElement('label');
    label.className = 'photo-add-btn';
    label.setAttribute('aria-label', 'Add photos');
    label.innerHTML = `
        <input type="file" accept="image/*" multiple hidden aria-label="Upload photos">
        <span>+</span>
    `;

    label.querySelector('input').addEventListener('change', async (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        if (!files.length) return;

        const slots = maxPhotos - _reviewPhotos.length;
        if (slots <= 0) return;

        let added = 0;
        for (const file of files.slice(0, slots)) {
            const validation = validateImageFile(file);
            if (!validation.valid) { showToast(validation.error); continue; }
            const newPhoto = await queuePendingPhoto(file);
            _reviewPhotos.push(newPhoto);
            added++;
        }
        if (added > 0) {
            updatePhotoGrid(container, [..._reviewPhotos], maxPhotos, dishId);
            showToast(added > 1 ? `${added} photos ready to save` : 'Photo ready to save');
        }
    });

    container.appendChild(label);
}

// viewPhotoFullscreen removed - now uses openPhotoViewer with swipe support

// Setup review sheet
// Setup drag-and-drop for dish cards
function setupReviewSheet() {
    document.getElementById('review-sheet-close').addEventListener('click', closeReviewSheet);
    document.getElementById('save-review-btn').addEventListener('click', saveReview);
    document.getElementById('delete-review-btn').addEventListener('click', deleteReview);

    // Close on backdrop click
    document.getElementById('review-sheet').addEventListener('click', (e) => {
        if (e.target.id === 'review-sheet') closeReviewSheet();
    });

    // Setup swipe-to-close gesture
    setupSheetGestures(document.getElementById('review-sheet'), closeReviewSheet);

    // Init sentiment buttons and score circles
    initSentimentButtons();
    initScoreCircles();

    // Setup dish chip input
    setupDishChipInput();

}

// ========== REVIEWS VIEW ==========

// Get review for a place
function getPlaceReview(placeId) {
    return allReviews.find(r => r.place_id === placeId);
}

// Load reviews from API
async function loadReviews() {
    try {
        const endpoint = IS_SHARE_MAP
            ? `${API_URL}/api/shares/${SHARE_TOKEN}/reviews`
            : `${API_URL}/api/reviews`;
        const response = await fetch(endpoint, {
            headers: getAuthHeaders()
        });
        if (response.ok) {
            const data = await response.json();
            allReviews = data.reviews;
            renderReviews();
            updateReviewFilterCounts();
        }
    } catch (error) {
        console.error('Failed to load reviews:', error);
    }
}

// Render reviews list with current sort/filter
function renderReviews() {
    const container = document.getElementById('reviews-list');
    const emptyState = document.getElementById('reviews-empty');

    // Apply current sort and filter
    const sorted = sortReviews(allReviews);
    const filtered = filterReviews(sorted);

    // Update results count
    const countEl = document.getElementById('reviews-results-count');
    if (countEl) countEl.textContent = `${filtered.length} ${filtered.length === 1 ? 'review' : 'reviews'}`;

    // Show empty state if no reviews
    if (filtered.length === 0) {
        container.innerHTML = '';
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';

    container.innerHTML = '';
    filtered.forEach(review => {
        const card = createReviewCard(review);
        container.appendChild(card);
    });
}

// Create DOM element for review card
function createReviewCard(review) {
    const allPhotos = [
        ...(review.overall_photos || []),
        ...(review.dishes || []).flatMap(d => d.photos || [])
    ];
    const timeAgo = formatTimeAgo(review.updated_at || review.created_at);

    const card = document.createElement('div');
    card.className = 'review-card';
    card.dataset.placeId = review.place_id;

    // Photo strip: ≤3 use fixed grid, >3 scrollable
    if (allPhotos.length > 0) {
        const strip = document.createElement('div');
        if (allPhotos.length <= 3) {
            strip.className = `review-card-photo-strip count-${allPhotos.length}`;
        } else {
            strip.className = 'review-card-photo-strip scrollable';
        }
        allPhotos.forEach((photo, index) => {
            const thumb = document.createElement('div');
            thumb.className = 'review-card-photo-thumb';
            thumb.innerHTML = `<img src="${safeUrl(photo.url)}" alt="Photo" loading="lazy">`;
            thumb.addEventListener('click', (e) => { e.stopPropagation(); });
            strip.appendChild(thumb);
        });
        card.appendChild(strip);
    }

    // Body
    const body = document.createElement('div');
    body.className = 'review-card-body';

    // Place name + stars
    let starsHtml = '';
    for (let i = 1; i <= 5; i++) {
        starsHtml += `<span class="rc-star${i <= review.overall_rating ? ' filled' : ''}">★</span>`;
    }
    const nameRow = document.createElement('div');
    nameRow.className = 'review-card-name-row';
    nameRow.innerHTML = `
        <div class="review-card-place">${escapeHtml(review.place_name || 'Unknown Place')}</div>
        <div class="review-card-stars">${starsHtml}</div>
    `;
    body.appendChild(nameRow);

    // Price icons + timestamp
    let priceHtml = '';
    if (review.price_rating) {
        for (let i = 1; i <= 5; i++) {
            priceHtml += `<span class="rc-price${i <= review.price_rating ? ' filled' : ''}">💰</span>`;
        }
    }
    const metaRow = document.createElement('div');
    metaRow.className = 'review-card-meta-row';
    metaRow.innerHTML = `
        <div class="review-card-price-icons">${priceHtml}</div>
        <div class="review-card-time">${timeAgo}</div>
    `;
    body.appendChild(metaRow);

    // Dish chips — single line, overflow fades out
    if (review.dishes?.length > 0) {
        const chipsRow = document.createElement('div');
        chipsRow.className = 'review-card-chips';
        review.dishes.forEach(d => {
            const chip = document.createElement('span');
            chip.className = 'review-card-chip';
            chip.textContent = d.name;
            chipsRow.appendChild(chip);
        });
        body.appendChild(chipsRow);
    }

    // Notes preview
    if (review.overall_remarks) {
        const preview = review.overall_remarks.length > 90
            ? review.overall_remarks.slice(0, 90) + '…'
            : review.overall_remarks;
        const notes = document.createElement('div');
        notes.className = 'review-card-preview';
        notes.textContent = `"${preview}"`;
        body.appendChild(notes);
    }

    card.appendChild(body);

    card.addEventListener('click', () => {
        openReviewSheetFromHistory(review.place_id);
        hapticFeedback('light');
    });

    return card;
}


// ========== REVIEWS FILTER STATE ==========
let reviewsSortBy = 'newest';       // active sort
let reviewsDrawerSort = 'newest';   // in-drawer pending sort
let reviewSearchQuery = '';

function sortReviews(reviews) {
    const sorted = [...reviews];
    switch (reviewsSortBy) {
        case 'newest':
            sorted.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
            break;
        case 'oldest':
            sorted.sort((a, b) => new Date(a.updated_at || a.created_at) - new Date(b.updated_at || b.created_at));
            break;
        case 'highest':
            sorted.sort((a, b) => b.overall_rating - a.overall_rating);
            break;
        case 'lowest':
            sorted.sort((a, b) => a.overall_rating - b.overall_rating);
            break;
    }
    return sorted;
}

// Filter reviews by search query (place name)
function filterReviews(reviews) {
    if (!reviewSearchQuery.trim()) return reviews;
    const q = reviewSearchQuery.toLowerCase();
    return reviews.filter(r => (r.place_name || '').toLowerCase().includes(q));
}

function updateReviewsFilterButton() {
    const countEl = document.getElementById('reviews-filter-count');
    if (!countEl) return;
    const count = reviewsSortBy !== 'newest' ? 1 : 0;
    countEl.textContent = count;
    countEl.style.display = count > 0 ? 'flex' : 'none';
}

function renderReviewsActiveFilterPills() {
    const container = document.getElementById('reviews-active-filters');
    if (!container) return;
    let html = '';
    if (reviewsSortBy !== 'newest') {
        const labels = { oldest: 'Oldest', highest: 'Top Rated', lowest: 'Lowest Rated' };
        html = `<span class="filter-pill">${labels[reviewsSortBy] || reviewsSortBy}<button class="filter-pill-remove" onclick="removeReviewsFilter('sort')">×</button></span>`;
    }
    container.innerHTML = html;
}

function removeReviewsFilter(type) {
    if (type === 'sort') reviewsSortBy = 'newest';
    renderReviews();
    updateReviewsFilterButton();
    renderReviewsActiveFilterPills();
}

function openReviewsFilterDrawer() {
    reviewsDrawerSort = reviewsSortBy;
    // Sync drawer UI
    document.querySelectorAll('#reviews-sort-options .filter-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sort === reviewsDrawerSort);
    });
    const drawer = document.getElementById('reviews-filter-drawer');
    drawer.style.display = 'flex';
    document.getElementById('reviews-filter-btn').setAttribute('aria-expanded', 'true');
}

function closeReviewsFilterDrawer() {
    document.getElementById('reviews-filter-drawer').style.display = 'none';
    document.getElementById('reviews-filter-btn').setAttribute('aria-expanded', 'false');
}

function applyReviewsFilterDrawer() {
    reviewsSortBy = reviewsDrawerSort;
    closeReviewsFilterDrawer();
    renderReviews();
    updateReviewsFilterButton();
    renderReviewsActiveFilterPills();
}

function clearReviewsFilterDrawer() {
    reviewsDrawerSort = 'newest';
    document.querySelectorAll('#reviews-sort-options .filter-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sort === 'newest');
    });
}

// Open review sheet from history
async function openReviewSheetFromHistory(placeId) {
    const place = places.find(p => p.id === placeId);
    if (!place) {
        showToast('Place not found');
        return;
    }

    await openReviewSheet(placeId);
}

// Setup reviews view
function setupReviewsView() {
    // Search
    const searchInput = document.getElementById('reviews-search-input');
    const clearBtn = document.getElementById('reviews-search-clear');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            reviewSearchQuery = searchInput.value;
            clearBtn.style.display = reviewSearchQuery ? 'block' : 'none';
            renderReviews();
        });
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            reviewSearchQuery = '';
            clearBtn.style.display = 'none';
            renderReviews();
            searchInput.focus();
        });
    }

    // Filter button
    document.getElementById('reviews-filter-btn')?.addEventListener('click', openReviewsFilterDrawer);
    document.getElementById('reviews-filter-drawer-close')?.addEventListener('click', closeReviewsFilterDrawer);
    document.getElementById('reviews-filter-apply')?.addEventListener('click', applyReviewsFilterDrawer);
    document.getElementById('reviews-filter-clear-all')?.addEventListener('click', clearReviewsFilterDrawer);

    // Backdrop close
    document.getElementById('reviews-filter-drawer')?.addEventListener('click', (e) => {
        if (e.target.id === 'reviews-filter-drawer') closeReviewsFilterDrawer();
    });

    // Sort option buttons inside drawer
    document.querySelectorAll('#reviews-sort-options .filter-option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#reviews-sort-options .filter-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            reviewsDrawerSort = btn.dataset.sort;
        });
    });
}

// Run on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    initApp().catch((error) => {
        console.error('Mini app failed to initialize:', error);
        try {
            hideLoading();
            showErrorState(error?.message || 'Failed to initialize app');
        } catch (fallbackError) {
            console.error('Failed to render error state:', fallbackError);
        }
    });
});

// ========== BOTTOM NAV / TAB SWITCHING ==========

let currentTab = 'saved';
let feedLoaded = false;

function switchTab(tab) {
    const prevTab = currentTab;
    currentTab = tab;
    if (tab === 'home' && prevTab !== 'home') {
        trackEvent('feed_opened', { entityType: 'feed', metadata: { tab: 'discover' } });
    }

    // Update nav tab active state
    document.querySelectorAll('.nav-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Header always hidden — no top banner on any tab
    const header = document.getElementById('app-header');
    if (header) header.style.display = 'none';

    // Saved tab: toggle map↔list when already on saved; always start on map from other tabs
    if (tab === 'saved') {
        if (prevTab === 'saved') {
            currentView = currentView === 'map' ? 'list' : 'map';
        } else {
            currentView = 'map';
        }
    }

    // View visibility
    const isSavedMap  = tab === 'saved' && currentView === 'map';
    const isSavedList = tab === 'saved' && currentView !== 'map';
    document.getElementById('map-view')?.classList.toggle('active', isSavedMap);
    document.getElementById('list-view')?.classList.toggle('active', isSavedList);
    document.getElementById('reviews-view')?.classList.toggle('active', false);
    document.getElementById('feed-view')?.classList.toggle('active', tab === 'home');
    document.getElementById('profile-view')?.classList.toggle('active', tab === 'profile');

    // Show/hide saved toggle FAB
    const savedFab = document.getElementById('btn-saved-toggle');
    if (savedFab) savedFab.style.display = tab === 'saved' ? 'flex' : 'none';

    if (tab === 'saved') {
        updateSavedToggleIcon(currentView);
        // Restore empty state if user has no places
        if (places.length === 0) showEmptyState();
        if (map) {
            // Double invalidateSize: 100ms catches most cases, 450ms covers
            // slow CSS transitions and devices where the container is still
            // animating at 100ms (root cause of intermittent blue-screen bug)
            setTimeout(() => map.invalidateSize(), 100);
            setTimeout(() => map.invalidateSize(), 450);
            // Friend places intentionally excluded from saved map (personal map only)
            if (friendMarkersLayer) friendMarkersLayer.clearLayers();
        }
    } else {
        // Hide empty-state overlay so it doesn't cover non-saved tabs
        hideEmptyState();
        if (tab === 'home') {
            if (prevTab === 'home') {
                // Re-tap: scroll to top and force-refresh feed
                document.getElementById('feed-view')?.scrollTo({ top: 0, behavior: 'smooth' });
                _feedCache = null;
            }
            loadFeed();
        } else if (tab === 'profile') {
            loadProfile();
        }
    }
}

function switchSavedView(view) {
    currentView = view;
    document.getElementById('list-view')?.classList.toggle('active', view === 'list');
    document.getElementById('map-view')?.classList.toggle('active', view === 'map');
    updateSavedToggleIcon(view);
    if (view === 'map' && map) {
        setTimeout(() => map.invalidateSize(), 100);
        if (friendMarkersLayer) friendMarkersLayer.clearLayers();
    }
}

function toggleSavedView() {
    switchSavedView(currentView === 'map' ? 'list' : 'map');
}

// SVG paths for the toggle icon
const MAP_ICON_SVG = `<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>`;
const LIST_ICON_SVG = `<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>`;

function updateSavedToggleIcon(view) {
    const fab = document.getElementById('btn-saved-toggle');
    if (!fab) return;
    const svg = document.getElementById('saved-toggle-svg');
    if (svg) {
        svg.innerHTML = view === 'map' ? LIST_ICON_SVG : MAP_ICON_SVG;
    }
}

// ========== FRIEND MAP LAYER ==========

function createFriendIcon(name) {
    const initial = (name || '?')[0].toUpperCase();
    return L.divIcon({
        className: '',
        html: `<div class="friend-map-pin">${initial}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -18]
    });
}

async function loadFriendMapActivity() {
    if (!friendMarkersLayer) return;
    friendMarkersLayer.clearLayers();
    try {
        const res = await fetch('/api/friends/map-activity', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const { activities } = await res.json();
        activities.forEach(act => {
            const p = act.places;
            if (!p?.latitude || !p?.longitude) return;
            const name = act.users?.first_name || 'Friend';
            const timeAgo = formatTimeAgo(act.created_at);
            const stars = act.rating ? '⭐'.repeat(Math.round(act.rating)) : '';
            const verb = act.activity_type === 'visited' ? 'visited' : 'saved';
            const placeJson = escapeHtml(JSON.stringify({ name: p.name, latitude: p.latitude, longitude: p.longitude, google_place_id: p.google_place_id, address: p.address }));
            const marker = L.marker([p.latitude, p.longitude], { icon: createFriendIcon(name) });
            marker.bindPopup(`
                <div class="friend-popup">
                    <div class="friend-popup-name">${escapeHtml(name)} ${verb}</div>
                    <div class="friend-popup-place">${escapeHtml(p.name)}</div>
                    <div class="friend-popup-meta">${timeAgo}${stars ? ' · ' + stars : ''}</div>
                    <button class="friend-popup-save" onclick="saveFriendPlace('${placeJson}')">Save to my list →</button>
                </div>
            `);
            friendMarkersLayer.addLayer(marker);
        });
    } catch (e) {
        console.error('Friend map load failed', e);
    }
}

async function saveFriendPlace(placeJsonStr) {
    try {
        const place = JSON.parse(placeJsonStr);
        const res = await fetch('/api/places', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: place.name,
                address: place.address || '',
                latitude: place.latitude,
                longitude: place.longitude,
                google_place_id: place.google_place_id || null,
            })
        });
        if (res.ok) {
            showToast('Saved to your list!');
            await loadPlaces();
        } else {
            const data = await res.json().catch(() => ({}));
            showToast(data.detail || 'Could not save place.');
        }
    } catch (e) {
        console.error('saveFriendPlace failed', e);
    }
}

// ========== DISCOVER SEARCH ==========

let _discoverSearchTimer = null;

function onDiscoverSearchInput(value) {
    const clearBtn = document.getElementById('discover-search-clear');
    if (clearBtn) clearBtn.style.display = value ? '' : 'none';
    clearTimeout(_discoverSearchTimer);
    if (!value || value.trim().length < 2) {
        hideDiscoverResults();
        _showDiscoverSuggestions();
        return;
    }
    _hideDiscoverSuggestions();
    _discoverSearchTimer = setTimeout(() => runDiscoverSearch(value.trim()), 400);
}

function onDiscoverSearchFocus() {
    const val = document.getElementById('discover-search-input')?.value || '';
    if (val.trim().length >= 2) {
        showDiscoverResults();
    } else {
        _showDiscoverSuggestions();
    }
}

function populateFeedEmptyChips() {
    const el = document.getElementById('feed-empty-cuisine-chips');
    if (!el) return;
    const types = DEFAULT_DISCOVER_TYPES.slice(0, 6);
    el.innerHTML = types.map(t =>
        `<button class="feed-empty-chip" onclick="quickDiscoverSearch('${t.query}')">${t.emoji} ${t.label}</button>`
    ).join('');
}

function quickDiscoverSearch(query) {
    const input = document.getElementById('discover-search-input');
    if (input) { input.value = query; onDiscoverSearchInput(query); }
    showDiscoverResults();
}

function showDiscoverResults() {
    document.getElementById('discover-results')?.style && (document.getElementById('discover-results').style.display = '');
    document.getElementById('feed-section')?.style && (document.getElementById('feed-section').style.display = 'none');
}

function hideDiscoverResults() {
    _hideDiscoverSuggestions();
    document.getElementById('discover-results')?.style && (document.getElementById('discover-results').style.display = 'none');
    document.getElementById('feed-section')?.style && (document.getElementById('feed-section').style.display = '');
}

function clearDiscoverSearch() {
    const input = document.getElementById('discover-search-input');
    if (input) { input.value = ''; input.focus(); }
    const clearBtn = document.getElementById('discover-search-clear');
    if (clearBtn) clearBtn.style.display = 'none';
    hideDiscoverResults();
    _showDiscoverSuggestions();
}

// ── Discover suggestions helpers ──────────────────────────────────────────────
const _DSS_KEY = 'discover_recent_searches';
const _DSS_MAX = 8;

function _showDiscoverSuggestions() {
    const el = document.getElementById('discover-search-suggestions');
    if (!el) return;
    _loadDiscoverRecentSearches();
    _buildDiscoverPills();
    document.getElementById('feed-section')?.style.setProperty('display', 'none');
    el.style.display = '';
}

function _buildDiscoverPills() {
    const container = document.getElementById('dss-pills');
    if (!container) return;

    // 1. Loved cuisines — from reviews with sentiment=loved or food_score >= 7
    const lovedScore = new Map();
    (allReviews || []).forEach(r => {
        const place = (places || []).find(p => p.id === r.place_id);
        if (!place?.place_types) return;
        if (r.sentiment !== 'loved' && (r.food_score == null || r.food_score < 7)) return;
        place.place_types.split(',').forEach(rawType => {
            const mapped = PLACE_TYPE_DISCOVER_MAP[rawType.trim()];
            if (!mapped || mapped.query === 'restaurant') return;
            const s = lovedScore.get(mapped.query) || { ...mapped, score: 0 };
            s.score += (r.food_score || 7);
            lovedScore.set(mapped.query, s);
        });
    });
    const lovedPills = [...lovedScore.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .map(item => ({ ...item, tag: 'loved' }));

    // 2. Friend trending — most common cuisine in feedActivitiesMap (last 30 days)
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const friendScore = new Map();
    const usedQueries = new Set(lovedPills.map(p => p.query));
    Object.values(feedActivitiesMap || {}).forEach(activity => {
        if (!activity.created_at || new Date(activity.created_at).getTime() < cutoff) return;
        (activity.place_types || '').split(',').forEach(rawType => {
            const mapped = PLACE_TYPE_DISCOVER_MAP[rawType.trim()];
            if (!mapped || mapped.query === 'restaurant' || usedQueries.has(mapped.query)) return;
            const s = friendScore.get(mapped.query) || { ...mapped, count: 0 };
            s.count++;
            friendScore.set(mapped.query, s);
        });
    });
    const trendingPills = [...friendScore.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 1)
        .map(item => ({ ...item, tag: 'trending' }));
    trendingPills.forEach(p => usedQueries.add(p.query));

    // 3. Unexplored fill — DEFAULT_DISCOVER_TYPES not already in user's history
    const savedQueries = new Set();
    (places || []).forEach(p => {
        (p.place_types || '').split(',').forEach(rawType => {
            const mapped = PLACE_TYPE_DISCOVER_MAP[rawType.trim()];
            if (mapped) savedQueries.add(mapped.query);
        });
    });
    const targetCount = 7; // pills after Near Me
    const fillCount = targetCount - lovedPills.length - trendingPills.length;
    const fillPills = [];
    for (const item of DEFAULT_DISCOVER_TYPES) {
        if (fillPills.length >= fillCount) break;
        if (usedQueries.has(item.query)) continue;
        fillPills.push({ ...item, tag: savedQueries.has(item.query) ? 'explore' : 'new' });
        usedQueries.add(item.query);
    }

    // 4. Render
    const allPills = [...lovedPills, ...trendingPills, ...fillPills];
    let html = `<button class="dss-pill dss-pill--near" onclick="runDiscoverNearMe()">📍 Near Me</button>`;
    html += allPills.map(item => {
        const label = item.tag === 'trending'
            ? `🔥 ${item.label}`
            : `${item.emoji} ${item.label}`;
        const extra = item.tag === 'loved' ? ' dss-pill--loved' : '';
        return `<button class="dss-pill${extra}" onclick="runDiscoverPill('${item.query}')">${label}</button>`;
    }).join('');
    container.innerHTML = html;
}

function _hideDiscoverSuggestions() {
    const el = document.getElementById('discover-search-suggestions');
    if (el) el.style.display = 'none';
}

function _saveDiscoverRecentSearch(query) {
    try {
        let list = JSON.parse(localStorage.getItem(_DSS_KEY) || '[]');
        list = [query, ...list.filter(q => q.toLowerCase() !== query.toLowerCase())].slice(0, _DSS_MAX);
        localStorage.setItem(_DSS_KEY, JSON.stringify(list));
    } catch (_) {}
}

function _loadDiscoverRecentSearches() {
    const section = document.getElementById('dss-recent-section');
    const listEl  = document.getElementById('dss-recent-list');
    if (!section || !listEl) return;
    try {
        const list = JSON.parse(localStorage.getItem(_DSS_KEY) || '[]');
        if (list.length === 0) { section.style.display = 'none'; return; }
        section.style.display = '';
        listEl.innerHTML = list.map((q, i) => `
            <div class="dss-recent-item" onclick="_runDiscoverRecentTap(${i})">
                <span class="dss-recent-icon">🕐</span>
                <span class="dss-recent-text">${escapeHtml(q)}</span>
                <button class="dss-recent-del" onclick="event.stopPropagation();_deleteDiscoverRecent(${i})">✕</button>
            </div>`).join('');
    } catch (_) { section.style.display = 'none'; }
}

function _runDiscoverRecentTap(idx) {
    try {
        const list = JSON.parse(localStorage.getItem(_DSS_KEY) || '[]');
        const q = list[idx]; if (!q) return;
        const input = document.getElementById('discover-search-input');
        if (input) input.value = q;
        const clearBtn = document.getElementById('discover-search-clear');
        if (clearBtn) clearBtn.style.display = '';
        _hideDiscoverSuggestions();
        runDiscoverSearch(q);
    } catch (_) {}
}

function _deleteDiscoverRecent(idx) {
    try {
        let list = JSON.parse(localStorage.getItem(_DSS_KEY) || '[]');
        list.splice(idx, 1);
        localStorage.setItem(_DSS_KEY, JSON.stringify(list));
        _loadDiscoverRecentSearches();
    } catch (_) {}
}

function clearDiscoverRecentSearches() {
    try { localStorage.removeItem(_DSS_KEY); } catch (_) {}
    const s = document.getElementById('dss-recent-section');
    if (s) s.style.display = 'none';
}

function runDiscoverPill(label) {
    const input = document.getElementById('discover-search-input');
    if (input) input.value = label;
    const clearBtn = document.getElementById('discover-search-clear');
    if (clearBtn) clearBtn.style.display = '';
    _hideDiscoverSuggestions();
    runDiscoverSearch(label);
}

async function runDiscoverNearMe() {
    const input = document.getElementById('discover-search-input');
    if (input) input.value = 'Near Me';
    const clearBtn = document.getElementById('discover-search-clear');
    if (clearBtn) clearBtn.style.display = '';
    _hideDiscoverSuggestions();
    showDiscoverResults();

    const listEl  = document.getElementById('discover-results-list');
    const emptyEl = document.getElementById('discover-results-empty');
    if (!listEl) return;
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.innerHTML = '<p style="padding:16px;color:var(--hint-color);text-align:center">📍 Finding places near you...</p>';

    if (!userLocation?.lat) await requestUserLocation();
    if (!userLocation?.lat) {
        listEl.innerHTML = '<p style="padding:16px;color:var(--hint-color);text-align:center">Location not available. Please enable location access.</p>';
        return;
    }

    _saveDiscoverRecentSearch('Near Me');
    try {
        const dbParams = new URLSearchParams({ q: 'restaurant', lat: userLocation.lat, lng: userLocation.lng });
        const gParams  = new URLSearchParams({ q: 'restaurant', lat: userLocation.lat, lng: userLocation.lng, max_results: 10 });

        const [dbRes, gRes] = await Promise.allSettled([
            fetch(`${API_URL}/api/places/discover-search?${dbParams}`, { headers: getAuthHeaders() }),
            fetch(`${API_URL}/api/search?${gParams}`, { headers: getAuthHeaders() }),
        ]);

        let dbResults = [];
        if (dbRes.status === 'fulfilled' && dbRes.value.ok)
            dbResults = (await dbRes.value.json()).results || [];
        let gResults = [];
        if (gRes.status === 'fulfilled' && gRes.value.ok)
            gResults = ((await gRes.value.json()).results || []).map(r => ({ ...r, friends_count: 0 }));

        const seen = new Set(dbResults.map(r => r.google_place_id).filter(Boolean));
        const merged = [...dbResults];
        for (const gr of gResults) {
            if (!gr.google_place_id || !seen.has(gr.google_place_id)) {
                merged.push(gr); if (gr.google_place_id) seen.add(gr.google_place_id);
            }
        }

        if (merged.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            listEl.innerHTML = '';
            return;
        }
        let html = `<div class="drc-section-header">📍 Near you</div>`;
        html += merged.slice(0, 10).map(r => createDiscoverResultCard(r)).join('');
        listEl.innerHTML = html;
    } catch (err) {
        console.error('runDiscoverNearMe error:', err);
        listEl.innerHTML = '';
    }
}
// ─────────────────────────────────────────────────────────────────────────────

async function runDiscoverSearch(query) {
    _saveDiscoverRecentSearch(query);
    showDiscoverResults();
    const listEl  = document.getElementById('discover-results-list');
    const emptyEl = document.getElementById('discover-results-empty');
    if (!listEl) return;

    listEl.innerHTML = '<p style="padding:16px;color:var(--hint-color);text-align:center">Searching...</p>';
    if (emptyEl) emptyEl.style.display = 'none';

    try {
        const params  = new URLSearchParams({ q: query });
        const gParams = new URLSearchParams({ q: query, max_results: 8 });
        if (typeof userLocation !== 'undefined' && userLocation?.lat) {
            params.set('lat', userLocation.lat);
            params.set('lng', userLocation.lng);
            gParams.set('lat', userLocation.lat);
            gParams.set('lng', userLocation.lng);
        }

        // Fire DB + Google Places + user search in parallel — always, no gating
        const [dbRes, gRes, userRes] = await Promise.allSettled([
            fetch(`${API_URL}/api/places/discover-search?${params}`, { headers: getAuthHeaders() }),
            fetch(`${API_URL}/api/search?${gParams}`, { headers: getAuthHeaders() }),
            fetch(`${API_URL}/api/users/search?q=${encodeURIComponent(query)}`, { headers: getAuthHeaders() }),
        ]);

        let dbResults = [];
        if (dbRes.status === 'fulfilled' && dbRes.value.ok) {
            dbResults = (await dbRes.value.json()).results || [];
        }
        let gResults = [];
        if (gRes.status === 'fulfilled' && gRes.value.ok) {
            const gData = await gRes.value.json();
            gResults = (gData.results || []).map(r => ({ ...r, friends_count: 0 }));
        }
        let users = [];
        if (userRes.status === 'fulfilled' && userRes.value.ok) {
            users = (await userRes.value.json()).users || [];
        }

        // Merge places: DB first (social context), then Google deduped
        const seen = new Set(dbResults.map(r => r.google_place_id).filter(Boolean));
        const merged = [...dbResults];
        for (const gr of gResults) {
            if (!gr.google_place_id || !seen.has(gr.google_place_id)) {
                merged.push(gr);
                if (gr.google_place_id) seen.add(gr.google_place_id);
            }
        }

        listEl.innerHTML = '';
        if (users.length === 0 && merged.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            return;
        }

        // People section (max 3) then Places section
        let html = '';
        if (users.length > 0) {
            html += `<div class="drc-section-header">People</div>`;
            html += users.slice(0, 3).map(u => createDiscoverUserCard(u)).join('');
            if (merged.length > 0) html += `<div class="drc-section-header">Places</div>`;
        }
        html += merged.slice(0, 10).map(r => createDiscoverResultCard(r)).join('');
        listEl.innerHTML = html;
    } catch (err) {
        console.error('runDiscoverSearch error:', err);
        listEl.innerHTML = '';
    }
}

function createDiscoverUserCard(user) {
    const name    = escapeHtml(user.display_name || user.first_name || 'User');
    const handle  = user.username ? `@${escapeHtml(user.username)}` : '';
    const initials = name.replace(/[^a-zA-Z ]/g, '').split(' ').filter(Boolean).map(w => w[0]).join('').slice(0,2).toUpperCase() || '?';
    const avatarInner = user.avatar_url
        ? `<img src="${escapeHtml(user.avatar_url)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
        : initials;
    const st = user.friendship_status;
    const btnLabel = st === 'accepted' ? 'Friends ✓'
        : st === 'pending' ? 'Requested'
        : st === 'incoming_request' ? 'Accept'
        : '+ Add';
    const disabled = st ? 'disabled' : '';
    return `<div class="drc-user-card" onclick="openUserProfile(${user.id})">
        <div class="drc-user-avatar">${avatarInner}</div>
        <div class="drc-user-info">
            <p class="drc-user-name">${name}</p>
            ${handle ? `<p class="drc-user-handle">${handle}</p>` : ''}
        </div>
        <button class="drc-user-add-btn" ${disabled}
            onclick="event.stopPropagation();handleDiscoverUserAction(${user.id},'${st||''}',this)">
            ${escapeHtml(btnLabel)}
        </button>
    </div>`;
}

function handleDiscoverUserAction(userId, status, btn) {
    if (!status) {
        sendFriendRequest(userId, btn);
    } else if (status === 'incoming_request') {
        openUserProfile(userId);
    }
}

function createDiscoverResultCard(place) {
    const name      = escapeHtml(place.name || 'Unknown');
    const address   = place.address || '';
    const area      = escapeHtml(address.split(',')[0] || '');
    const firstType = (place.place_types || '').split(',')[0].trim();
    const typeInfo  = (typeof PLACE_TYPE_DISCOVER_MAP !== 'undefined' && PLACE_TYPE_DISCOVER_MAP[firstType]) || null;
    const cuisineLabel = typeInfo?.label || '';

    // Chip row: cuisine · price · ⭐ rating (count) · distance
    const chips = [];
    if (cuisineLabel) chips.push(`<span class="drc-chip">${escapeHtml(cuisineLabel)}</span>`);
    const priceLevel = parseInt(place.place_price_level) || 0;
    if (priceLevel > 0) chips.push(`<span class="drc-chip">${'$'.repeat(priceLevel)}</span>`);
    if (place.place_rating) {
        const cnt = place.place_rating_count
            ? ` <span class="drc-chip-count">(${Number(place.place_rating_count).toLocaleString()})</span>` : '';
        chips.push(`<span class="drc-chip drc-chip--rating">⭐ ${place.place_rating}${cnt}</span>`);
    }
    const drcDist = getPlaceDistance(place);
    if (drcDist !== null) chips.push(`<span class="drc-chip">📍 ${formatDistance(drcDist)}</span>`);

    const friends = place.friends_count > 0
        ? `<div class="drc-friends">👥 ${place.friends_count} friend${place.friends_count > 1 ? 's' : ''} been here</div>`
        : '';

    const placeJson    = escapeHtml(JSON.stringify(place));
    const gid          = escapeHtml(place.google_place_id || '');
    const alreadySaved = places?.find(p => p.google_place_id && p.google_place_id === place.google_place_id);
    const isVisited    = !!alreadySaved?.is_visited;

    let stateBadge;
    if (!alreadySaved) {
        stateBadge = `<button class="drc-save-btn" onclick="event.stopPropagation();saveDiscoverPlace(${placeJson},this)">＋ Save</button>`;
    } else if (isVisited) {
        stateBadge = `<span class="drc-saved-badge drc-saved-badge--visited">✓ Visited</span>`;
    } else {
        stateBadge = `<span class="drc-saved-badge">🔖 Saved</span>`;
    }

    return `
        <div class="discover-result-card" onclick="onDiscoverResultTap('${gid}', ${placeJson})">
            <div class="drc-body">
                <p class="drc-name">${name}</p>
                ${chips.length ? `<div class="drc-chips-row">${chips.join('')}</div>` : ''}
                ${area ? `<p class="drc-area">${area}</p>` : ''}
                ${friends}
            </div>
            ${stateBadge}
        </div>`;
}

function onDiscoverResultTap(googlePlaceId, place) {
    const own = googlePlaceId && places?.find(p => p.google_place_id === googlePlaceId);
    if (own) {
        openRestaurantCard(own.id);
    } else {
        openRestaurantCardFromSearch(place);
    }
}

async function saveDiscoverPlace(place, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    try {
        const res = await fetch(`${API_URL}/api/places`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: place.name,
                address: place.address || '',
                latitude: place.latitude || 0,
                longitude: place.longitude || 0,
                google_place_id: place.google_place_id,
                place_types: place.place_types,
                place_rating: place.place_rating,
                place_price_level: place.place_price_level,
                country_code: place.country_code,
                city: place.city,
                neighborhood: place.neighborhood,
                primary_cuisine: place.primary_cuisine,
            })
        });
        if (!res.ok) throw new Error('Save failed');
        const saved = await res.json();
        if (saved.place && !places.find(p => p.google_place_id === saved.place.google_place_id)) {
            places.push(saved.place);
            applyFilters();
            displayPlacesOnMap(false);
        }
        if (btn) btn.outerHTML = `<span class="drc-saved-badge">🔖 Saved</span>`;
        showToast('Saved to your list!');
        fetchPlaces(); // background full sync
    } catch (err) {
        console.error('saveDiscoverPlace error:', err);
        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
}

function openRestaurantCardFromSearch(place) {
    openRestaurantCardGuest({
        name:               place.name               || '',
        address:            place.address            || '',
        google_place_id:    place.google_place_id    || '',
        latitude:           place.latitude           || 0,
        longitude:          place.longitude          || 0,
        place_rating:       place.place_rating,
        place_rating_count: place.place_rating_count,
        place_price_level:  place.place_price_level,
        place_types:        place.place_types,
    });
}

// ========== FEED ==========

function _renderFeedActivities(list, empty, activities) {
    const valid = activities.filter(a => a.place_name_resolved);
    if (valid.length === 0) {
        list.innerHTML = '';
        if (empty) { empty.style.display = ''; populateFeedEmptyChips(); }
        return;
    }
    if (empty) empty.style.display = 'none';
    feedActivitiesMap = {};
    valid.forEach(a => { feedActivitiesMap[a.id] = a; });
    list.innerHTML = valid.map(a => createFeedCard(a)).join('');
}

async function loadFeed() {
    const list = document.getElementById('feed-list');
    const loading = document.getElementById('feed-loading');
    const empty = document.getElementById('feed-empty');
    if (!list) return;

    const now = Date.now();
    const isCacheFresh = _feedCache && (now - _feedCache.ts) < FEED_CACHE_TTL_MS;

    if (_feedCache) {
        // Render cached data immediately (stale-while-revalidate)
        if (loading) loading.style.display = 'none';
        _renderFeedActivities(list, empty, _feedCache.data);
        if (isCacheFresh) return;
        // Cache stale — continue to fetch silently in background
    } else {
        // First load — show skeletons while fetching
        if (loading) loading.style.display = 'none';
        showFeedSkeletons(4);
        if (empty) empty.style.display = 'none';
    }

    try {
        const res = await fetch('/api/feed', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error('Failed to load feed');
        const data = await res.json();
        const activities = data.activities || [];

        _feedCache = { data: activities, ts: Date.now() };

        // Only re-render if user is still on home tab (avoid jarring update if they switched away)
        if (document.getElementById('feed-list')) {
            _renderFeedActivities(list, empty, activities);
        }
    } catch (err) {
        console.error('loadFeed error:', err);
        clearFeedSkeletons();
        // Keep showing stale cache if available; only show error on first load
        if (!_feedCache && list) {
            list.innerHTML = '<p style="padding:16px;color:var(--hint-color)">Could not load feed.</p>';
        }
    }
}

// SVG icons for feed card actions — same stroke style as bottom nav
const FC_ICON_HEART = `<svg class="fc-btn-icon fc-heart-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
const FC_ICON_COMMENT = `<svg class="fc-btn-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

// Route to the right card type
function createFeedCard(activity) {
    return activity.activity_type === 'saved'
        ? createSavedRow(activity)
        : createVisitedCard(activity);
}

// ── Saved: slim notification row (no card box) ──────────────────────────────
function createSavedRow(activity) {
    const meta      = activity.metadata || {};
    const actor     = activity.is_own ? 'You' : (activity.actor_name || activity.actor_username || 'Friend');
    const initials  = actor.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
    const placeName = activity.place_name_resolved || meta.place_name || 'a place';
    const address   = activity.place_address_resolved || meta.address || '';
    const timeAgo   = formatTimeAgo(activity.created_at);
    const gid       = activity.place_google_id || meta.google_place_id || '';
    const state     = activity.user_place_state || {};

    const avatarUrl = activity.actor_avatar_url || null;
    const avatarHtml = avatarUrl
        ? `<div class="fc-notif-avatar" style="background-image:url('${avatarUrl}');background-size:cover;background-position:center;" onclick="event.stopPropagation();openUserProfile(${activity.user_id})"></div>`
        : `<div class="fc-notif-avatar" onclick="event.stopPropagation();openUserProfile(${activity.user_id})">${initials}</div>`;

    // Badge below place name — visited or saved
    let stateBadge = '';
    if (state.visited) {
        const d = state.visited_at ? ` · ${formatShortDate(state.visited_at)}` : '';
        stateBadge = `<span class="fc-state-badge fc-state-visited">✓ You visited${d}</span>`;
    } else if (state.saved) {
        const d = state.saved_at ? ` · ${formatShortDate(state.saved_at)}` : '';
        stateBadge = `<span class="fc-state-badge fc-state-saved">🔖 In your list${d}</span>`;
    }

    // Right CTA: only show Save button for unsaved places; badges live below now
    const rowCta = (!state.visited && !state.saved)
        ? `<button class="fc-notif-save" onclick="event.stopPropagation();fcQuickSave('${activity.id}','${gid}')">+ Save</button>`
        : '';

    const snDist = (userLocation && activity.place_lat && activity.place_lng)
        ? calculateDistance(userLocation.lat, userLocation.lng, activity.place_lat, activity.place_lng)
        : null;
    const snAddrParts = [address ? escapeHtml(address) : '', snDist !== null ? `📍 ${formatDistance(snDist)}` : ''].filter(Boolean);
    const snAddrHtml = snAddrParts.length ? `<div class="fc-notif-addr">${snAddrParts.join(' · ')}</div>` : '';

    return `
        <div class="fc-notif" id="fc-${activity.id}" onclick="onFeedCardTap('${activity.id}', '${gid}')">
            ${avatarHtml}
            <div class="fc-notif-body">
                <div class="fc-notif-text">
                    <span class="fc-notif-actor" onclick="event.stopPropagation();openUserProfile(${activity.user_id})">${escapeHtml(actor)}</span>
                    <span class="fc-notif-verb"> saved </span>
                    <span class="fc-notif-place">${escapeHtml(placeName)}</span>
                </div>
                ${stateBadge}
                ${snAddrHtml}
            </div>
            <div class="fc-notif-right">
                <span class="fc-notif-time">${timeAgo}</span>
                ${rowCta}
            </div>
        </div>`;
}

// ── Visited/Reviewed: discovery-first social card ───────────────────────────
function createVisitedCard(activity) {
    const meta          = activity.metadata || {};
    const review        = activity.review   || null;
    const actor         = activity.is_own ? 'You' : (activity.actor_name || activity.actor_username || 'Friend');
    const initials      = actor.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
    const placeName     = activity.place_name_resolved || meta.place_name || 'a place';
    const address       = activity.place_address_resolved || meta.address || '';
    const sentiment     = review?.sentiment || null;
    const caption       = review?.caption  || meta.remarks || '';
    const timeAgo       = formatTimeAgo(activity.created_at);
    const gid           = activity.place_google_id || meta.google_place_id || '';
    const likesCount     = activity.likes_count    || 0;
    const commentsCount  = activity.comments_count || 0;
    const userLiked      = activity.user_liked  || false;
    const latestComment  = activity.latest_comment || null;
    const state         = activity.user_place_state || {};
    const photos        = activity.review_photos || [];
    const dishes        = activity.review_dishes || [];
    const aid           = activity.id;

    // Avatar
    const avatarUrl = activity.actor_avatar_url || null;
    const avatarHtml = avatarUrl
        ? `<div class="fc-avatar" style="background-image:url('${avatarUrl}');background-size:cover;background-position:center;" onclick="event.stopPropagation();openUserProfile(${activity.user_id})"></div>`
        : `<div class="fc-avatar" onclick="event.stopPropagation();openUserProfile(${activity.user_id})">${initials}</div>`;

    // Area + cuisine label + distance
    const areaLabel = address ? address.split(',')[0] : '';
    const firstType = (activity.place_types || '').split(',')[0].trim();
    const cuisineLabel = (typeof PLACE_TYPE_DISCOVER_MAP !== 'undefined' && PLACE_TYPE_DISCOVER_MAP[firstType]?.label) || '';
    const fcDist = (userLocation && activity.place_lat && activity.place_lng)
        ? calculateDistance(userLocation.lat, userLocation.lng, activity.place_lat, activity.place_lng)
        : null;
    const fcDistStr = fcDist !== null ? `📍 ${formatDistance(fcDist)}` : '';
    const placeAreaStr = [cuisineLabel, areaLabel, fcDistStr].filter(Boolean).join(' · ');

    // Photos — carousel (multiple) or single image, full-bleed
    let mediaHtml = '';
    if (photos.length === 1) {
        mediaHtml = `<div class="fc-media-wrap" onclick="onFeedCardTap('${aid}','${gid}')">
            <img class="fc-media-img" src="${escapeHtml(photos[0].file_url)}" alt="" loading="lazy" onclick="openImgViewer(this.src);event.stopPropagation()">
        </div>`;
    } else if (photos.length > 1) {
        const slides = photos.map(p =>
            `<div class="fc-slide"><img class="fc-media-img" src="${escapeHtml(p.file_url)}" alt="" loading="lazy" onclick="openImgViewer(this.src);event.stopPropagation()"></div>`
        ).join('');
        const dots = photos.map((_, i) =>
            `<span class="fc-dot${i === 0 ? ' active' : ''}"></span>`
        ).join('');
        mediaHtml = `<div class="fc-media-wrap">
            <div class="fc-carousel" id="fcc-${aid}"
                onscroll="updateFcDots('${aid}',${photos.length},this)"
                onclick="onFeedCardTap('${aid}','${gid}')">${slides}</div>
            <div class="fc-dots" id="fcd-${aid}">${dots}</div>
        </div>`;
    }

    // Sentiment chip + overall score
    const SENT = {
        loved: { emoji: '🔥', label: 'Loved it' },
        okay:  { emoji: '😊', label: 'Pretty good' },
        meh:   { emoji: '😑', label: 'It was alright' },
    };
    const fs = review?.food_score ?? null;
    const vs = review?.vibe_score ?? null;
    const ls = review?.value_score ?? null;
    const band = sentiment && SENT[sentiment] ? SENT[sentiment] : null;
    const scores = [fs, vs, ls].filter(s => s != null);
    const overall = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;
    const sentHtml = band
        ? `<div class="fc-sent-row">
               <span class="fc-sent-chip ${sentiment}">${band.emoji} ${band.label}</span>
               ${overall ? `<span class="fc-sent-overall ${parseFloat(overall) >= 8 ? 'score-high' : parseFloat(overall) >= 6 ? 'score-mid' : 'score-low'}">${overall}</span>` : ''}
           </div>`
        : '';

    // Score chips
    const mkChip = (s, label) => s != null
        ? `<span class="fc-score-chip">${label} <b>${s}</b></span>` : '';
    const scoresHtml = (fs != null || vs != null || ls != null)
        ? `<div class="fc-score-chips">${mkChip(fs,'🍽 Food')}${mkChip(vs,'🎵 Vibe')}${mkChip(ls,'💰 Value')}</div>`
        : '';

    // Dish chips — max 3 + overflow
    let dishesHtml = '';
    if (dishes.length > 0) {
        const shown = dishes.slice(0, 3);
        const overflow = dishes.length > 3
            ? `<span class="fc-dish-chip fc-dish-chip--more">+${dishes.length - 3}</span>` : '';
        dishesHtml = `<div class="fc-dish-chips">${shown.map(d => {
            const sc = d.rating != null ? (d.rating >= 8 ? 'dish-high' : d.rating >= 5 ? 'dish-mid' : 'dish-low') : '';
            return `<span class="fc-dish-chip ${sc}">${escapeHtml(d.dish_name)}${d.rating != null ? `<span class="fc-dish-score ${sc}"> ${d.rating}</span>` : ''}</span>`;
        }).join('')}${overflow}</div>`;
    }

    // Caption — 3-line clamp with "more" toggle
    const captionHtml = caption
        ? `<div class="fc-caption-block" id="fca-${aid}"><span class="fc-caption-actor">${escapeHtml(actor)}</span> <span class="fc-caption-text">${escapeHtml(caption)}</span><span class="fc-caption-more" onclick="event.stopPropagation();toggleFcCaption('${aid}')">more</span></div>`
        : '';

    // State badge below place name in header; action row only shows Save button for unsaved
    let userStateBadge = '';
    if (state.visited) {
        const d = state.visited_at ? ` · ${formatShortDate(state.visited_at)}` : '';
        userStateBadge = `<span class="fc-state-badge fc-state-visited">✓ You visited${d}</span>`;
    } else if (state.saved) {
        const d = state.saved_at ? ` · ${formatShortDate(state.saved_at)}` : '';
        userStateBadge = `<span class="fc-state-badge fc-state-saved">🔖 In your list${d}</span>`;
    }
    const stateCta = (!state.visited && !state.saved)
        ? `<button class="fc-quick-save" onclick="fcQuickSave('${aid}','${gid}')" aria-label="Save place">+ Save</button>`
        : '';

    return `
        <div class="fc" id="fc-${aid}">
            <div class="fc-header" onclick="onFeedCardTap('${aid}','${gid}')">
                ${avatarHtml}
                <div class="fc-actor-block">
                    <div class="fc-actor-line">
                        <span class="fc-actor" onclick="event.stopPropagation();openUserProfile(${activity.user_id})">${escapeHtml(actor)}</span>
                        <span class="fc-meta">reviewed this</span>
                    </div>
                    <span class="fc-place-name">${escapeHtml(placeName)}</span>
                    ${placeAreaStr ? `<span class="fc-place-area">${escapeHtml(placeAreaStr)}</span>` : ''}
                    ${userStateBadge}
                </div>
                <span class="fc-timestamp">${timeAgo}</span>
            </div>

            ${mediaHtml}

            <div class="fc-body${mediaHtml ? '' : ' fc-body--no-media'}" onclick="onFeedCardTap('${aid}','${gid}')">
                ${sentHtml}
                ${captionHtml}
                ${scoresHtml}
                ${dishesHtml}

                <div class="fc-action-row">
                    <div class="fc-action-left">
                        <button class="fc-like-btn ${userLiked ? 'liked' : ''}"
                            data-liked="${userLiked}"
                            onclick="event.stopPropagation();likeActivity('${aid}', this)"
                            aria-label="Like">
                            ${FC_ICON_HEART}
                            ${likesCount > 0 ? `<span class="fc-action-count fc-likes-count" onclick="event.stopPropagation();showLikersSheet('${aid}')">${likesCount}</span>` : ''}
                        </button>
                        <button class="fc-comment-btn" onclick="event.stopPropagation();onFcCommentBtnClick('${aid}')" aria-label="Comment">
                            ${FC_ICON_COMMENT}
                            ${commentsCount > 0 ? `<span class="fc-action-count">${commentsCount}</span>` : ''}
                        </button>
                    </div>
                    ${stateCta}
                </div>

                ${latestComment ? `
                <div class="fc-preview-comment" id="fcp-prev-${aid}" onclick="event.stopPropagation()">
                    <span class="fc-preview-author">${escapeHtml(latestComment.display_name || 'User')}</span>
                    <span class="fc-preview-body">${escapeHtml(latestComment.body || '')}</span>
                </div>
                ${commentsCount > 1 ? `<div class="fc-more-link" id="fcp-more-${aid}" onclick="event.stopPropagation();loadFcComments('${aid}')">View ${commentsCount - 1} more comment${commentsCount - 1 !== 1 ? 's' : ''}</div>` : ''}
                ` : ''}

                <div class="fc-comments-list" id="fcl-${aid}"></div>

                <div class="fc-comment-row" style="display:none">
                    <div class="fc-mini-avatar">${initials[0]}</div>
                    <input class="fc-comment-input" id="fci-${aid}"
                        placeholder="Add a comment…"
                        onclick="event.stopPropagation()"
                        oninput="toggleFcPostBtn('${aid}', this.value)"
                        onkeydown="if(event.key==='Enter'&&!event.shiftKey){submitFcComment('${aid}');event.preventDefault()}">
                    <button class="fc-comment-post" id="fcp-${aid}"
                        style="display:none"
                        onclick="event.stopPropagation();submitFcComment('${aid}')">Post</button>
                </div>
            </div>
        </div>`;
}

// ── Feed card helpers ────────────────────────────────────────────────────────

function updateFcDots(activityId, total, carouselEl) {
    const idx = Math.round(carouselEl.scrollLeft / carouselEl.offsetWidth);
    const dotsEl = document.getElementById(`fcd-${activityId}`);
    if (!dotsEl) return;
    dotsEl.querySelectorAll('.fc-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
}

function toggleFcPostBtn(activityId, value) {
    const btn = document.getElementById(`fcp-${activityId}`);
    if (btn) btn.style.display = value.trim() ? '' : 'none';
}

function toggleFcCaption(aid) {
    const el = document.getElementById(`fca-${aid}`);
    if (!el) return;
    el.classList.toggle('fc-caption-expanded');
    const more = el.querySelector('.fc-caption-more');
    if (more) more.textContent = el.classList.contains('fc-caption-expanded') ? 'less' : 'more';
}

function focusFcComment(activityId) {
    const row = document.querySelector(`#fc-${activityId} .fc-comment-row`);
    if (row) row.style.display = 'flex';
    const input = document.getElementById(`fci-${activityId}`);
    if (input) { input.focus(); toggleFcPostBtn(activityId, input.value); }
}

async function loadFcComments(activityId) {
    if (typeof event !== 'undefined') event.stopPropagation();
    // Hide preview + "View more" while expanded
    const prevEl = document.getElementById(`fcp-prev-${activityId}`);
    if (prevEl) prevEl.style.display = 'none';
    const moreEl = document.getElementById(`fcp-more-${activityId}`);
    if (moreEl) moreEl.style.display = 'none';
    const listEl = document.getElementById(`fcl-${activityId}`);
    if (listEl) listEl.innerHTML = '<div class="fc-comments-loading">···</div>';
    try {
        const res = await fetch(`${API_URL}/api/activities/${activityId}/comments`, {
            headers: getAuthHeaders()
        });
        const data = await res.json();
        const comments = data.comments || [];
        if (listEl) {
            const commentRows = comments.map(c => {
                const name = escapeHtml(c.display_name || 'User');
                const rawName = c.display_name || 'User';
                const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
                const time = formatTimeAgo(c.created_at);
                const body = escapeHtml(c.body || '');
                const av = c.avatar_url
                    ? `<div class="fc-mini-avatar" style="background-image:url('${escapeHtml(c.avatar_url)}');background-size:cover;background-position:center;"></div>`
                    : `<div class="fc-mini-avatar">${initials}</div>`;
                return `<div class="fc-comment-item" onclick="event.stopPropagation()">${av}<div class="fc-comment-content"><span class="fc-comment-author">${name}</span><span class="fc-comment-time">${time}</span><div class="fc-comment-body">${body}</div><button class="fc-reply-btn" onclick="event.stopPropagation();replyToFcComment('${activityId}','${rawName.replace(/'/g,"\\'")}')">Reply</button></div></div>`;
            }).join('');
            listEl.innerHTML = `${commentRows}<button class="fc-collapse-btn" onclick="event.stopPropagation();collapseFcComments('${activityId}')">▲ Hide comments</button>`;
        }
    } catch (e) {
        if (listEl) listEl.innerHTML = '';
        if (prevEl) prevEl.style.display = '';
    }
    focusFcComment(activityId);
}

function collapseFcComments(activityId) {
    if (typeof event !== 'undefined') event.stopPropagation();
    const listEl = document.getElementById(`fcl-${activityId}`);
    if (listEl) listEl.innerHTML = '';
    const prevEl = document.getElementById(`fcp-prev-${activityId}`);
    if (prevEl) prevEl.style.display = '';
    const moreEl = document.getElementById(`fcp-more-${activityId}`);
    if (moreEl) moreEl.style.display = '';
    const row = document.querySelector(`#fc-${activityId} .fc-comment-row`);
    if (row) row.style.display = 'none';
    const input = document.getElementById(`fci-${activityId}`);
    if (input) input.value = '';
    const postBtn = document.getElementById(`fcp-${activityId}`);
    if (postBtn) postBtn.style.display = 'none';
}

function onFcCommentBtnClick(activityId) {
    const listEl = document.getElementById(`fcl-${activityId}`);
    if (listEl && listEl.children.length > 0) {
        collapseFcComments(activityId);
    } else {
        focusFcComment(activityId);
    }
}

function replyToFcComment(activityId, authorName) {
    focusFcComment(activityId);
    const input = document.getElementById(`fci-${activityId}`);
    if (input) {
        input.value = `@${authorName} `;
        input.focus();
        toggleFcPostBtn(activityId, input.value);
    }
}

async function fcQuickSave(aid, gid) {
    event.stopPropagation();
    const activity = feedActivitiesMap[aid];
    if (!activity) return;
    const btn = document.querySelector(`#fc-${aid} .fc-quick-save, #fc-${aid} .fc-notif-save`);
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const res = await fetch(`${API_URL}/api/places`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                google_place_id:    gid                              || null,
                name:               activity.place_name_resolved     || '',
                address:            activity.place_address_resolved  || '',
                latitude:           activity.place_lat               || 0,
                longitude:          activity.place_lng               || 0,
                source_url:         activity.place_source_url        || null,
                place_types:        activity.place_types             || null,
                place_rating:       activity.place_rating            || null,
                place_rating_count: activity.place_rating_count      || null,
                place_price_level:  activity.place_price_level       || null,
            }),
        });
        if (!res.ok) throw new Error('save failed');
        const saved = await res.json();
        if (saved.place && !places.find(p => p.google_place_id === gid)) {
            places.push(saved.place);
            applyFilters();
            displayPlacesOnMap(false);
        }
        // Update DOM: remove right-side CTA, add "In your list · date" badge below place name
        const savedDate = ` · ${formatShortDate(new Date().toISOString())}`;
        const savedBadgeHtml = `<span class="fc-state-badge fc-state-saved">🔖 In your list${savedDate}</span>`;
        const cardEl = document.getElementById(`fc-${aid}`);
        if (cardEl) {
            cardEl.querySelector('.fc-quick-save')?.remove();
            cardEl.querySelector('.fc-notif-save')?.remove();
            if (!cardEl.querySelector('.fc-state-badge')) {
                cardEl.querySelector('.fc-actor-block')?.insertAdjacentHTML('beforeend', savedBadgeHtml);
                cardEl.querySelector('.fc-notif-body')?.insertAdjacentHTML('beforeend', savedBadgeHtml);
            }
        }
        if (activity.user_place_state) activity.user_place_state.saved = true;
        _feedCache = null;  // saved place will generate new activity — invalidate feed cache
        showToast('Saved to your list!');
    } catch(e) {
        console.error('fcQuickSave error:', e);
        if (btn) { btn.disabled = false; btn.textContent = '+ Save'; }
        showToast('Could not save. Try again.');
    }
}

async function submitFcComment(activityId) {
    const input  = document.getElementById(`fci-${activityId}`);
    const postBtn = document.getElementById(`fcp-${activityId}`);
    const body = input?.value.trim();
    if (!body) return;
    postBtn.disabled = true;
    try {
        const res = await fetch(`${API_URL}/api/activities/${activityId}/comments`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
        });
        if (!res.ok) throw new Error('Failed');
        input.value = '';
        postBtn.style.display = 'none';
        // Increment count in feedActivitiesMap + update DOM
        const activity = feedActivitiesMap[activityId];
        if (activity) {
            activity.comments_count = (activity.comments_count || 0) + 1;
            const count = activity.comments_count;
            // Update comment button count
            const countEl = document.querySelector(`#fc-${activityId} .fc-comment-btn .fc-action-count`);
            if (countEl) {
                countEl.textContent = count;
            } else {
                const btn = document.querySelector(`#fc-${activityId} .fc-comment-btn`);
                if (btn) btn.innerHTML += `<span class="fc-action-count">${count}</span>`;
            }
            // Update preview comment (latest is what the user just posted)
            const myName = window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name || 'You';
            const prevEl = document.getElementById(`fcp-prev-${activityId}`);
            if (prevEl) {
                prevEl.querySelector('.fc-preview-author').textContent = myName;
                prevEl.querySelector('.fc-preview-body').textContent = body;
                const moreLink = prevEl.querySelector('.fc-more-link');
                if (count > 1) {
                    if (moreLink) {
                        moreLink.textContent = `View ${count - 1} more`;
                        moreLink.onclick = (e) => { e.stopPropagation(); loadFcComments(activityId); };
                    } else {
                        const span = document.createElement('span');
                        span.className = 'fc-more-link';
                        span.textContent = `View ${count - 1} more`;
                        span.onclick = (e) => { e.stopPropagation(); loadFcComments(activityId); };
                        prevEl.appendChild(span);
                    }
                }
                prevEl.style.display = '';
            } else {
                // First comment — create preview row
                const listEl = document.getElementById(`fcl-${activityId}`);
                const newPrev = document.createElement('div');
                newPrev.className = 'fc-preview-comment';
                newPrev.id = `fcp-prev-${activityId}`;
                newPrev.setAttribute('onclick', 'event.stopPropagation()');
                newPrev.innerHTML = `<span class="fc-preview-author">${escapeHtml(myName)}</span><span class="fc-preview-body">${escapeHtml(body)}</span>`;
                if (listEl) listEl.before(newPrev);
            }
        }
    } catch (e) {
        console.error('submitFcComment error:', e);
    } finally {
        if (postBtn) postBtn.disabled = false;
    }
}

function formatTimeAgo(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7)  return `${days}d ago`;
    // same calendar year → "Aug 5", older → "Aug 5, 2024"
    const now = new Date();
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-SG', opts);
}

// ========== OTHER USER PROFILE ==========

// ── Friend profile sheet state ──────────────────────────────────
let _upFriendshipId = null;
let _upUserId       = null;
let _upLeafletMap   = null;
let _upFriendPlaces = [];
let _upCalVisited   = [];
let _upCalMonthOffset = 0;

async function openUserProfile(userId) {
    if (!userId) return;
    const myId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    if (myId && Number(userId) === Number(myId)) {
        switchTab('profile');
        return;
    }
    const overlay = document.getElementById('user-profile-overlay');
    if (overlay) overlay.style.display = 'flex';
    const sheet = document.getElementById('user-profile-sheet');
    if (sheet) sheet.classList.add('rc-open');

    // Clear previous content
    ['up-name','up-username','up-bio','up-member-since'].forEach(id => {
        const el = document.getElementById(id); if (el) el.textContent = '';
    });
    const avatarEl = document.getElementById('up-avatar');
    if (avatarEl) { avatarEl.style.backgroundImage = ''; avatarEl.textContent = ''; }
    document.getElementById('up-action-area').innerHTML = '';
    document.getElementById('up-friend-content').style.display = 'none';
    document.getElementById('up-stranger-content').style.display = 'none';
    document.getElementById('up-stats-row').style.display = 'none';
    document.getElementById('up-insight-card').style.display = 'none';
    document.getElementById('up-food-story-btn').style.display = 'none';

    try {
        const res = await fetch(`${API_URL}/api/users/${userId}/profile`, { headers: getAuthHeaders() });
        if (!res.ok) throw new Error('Profile not found');
        renderUserProfileSheet(await res.json());
    } catch (err) {
        console.error('openUserProfile error:', err);
        closeUserProfileSheet();
    }
}

function closeUserProfileSheet() {
    const overlay = document.getElementById('user-profile-overlay');
    if (overlay) overlay.style.display = 'none';
    const sheet = document.getElementById('user-profile-sheet');
    if (sheet) sheet.classList.remove('rc-open');
    if (_upLeafletMap) { _upLeafletMap.remove(); _upLeafletMap = null; }
    _upFriendshipId = null; _upUserId = null; _upFriendPlaces = [];
    closeUpFoodStory();
}

function renderUserProfileSheet(data) {
    const profile  = data.profile || {};
    const status   = data.friendship_status;
    const isFriend = status === 'accepted';
    _upFriendshipId = data.friendship_id || null;
    _upUserId       = profile.id;

    // Avatar (circle with green ring)
    const avatarEl = document.getElementById('up-avatar');
    if (avatarEl) {
        const initials = (profile.display_name || profile.first_name || '?')
            .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        if (profile.avatar_url) {
            avatarEl.style.backgroundImage = `url('${escapeHtml(profile.avatar_url)}')`;
            avatarEl.textContent = '';
        } else {
            avatarEl.style.backgroundImage = '';
            avatarEl.textContent = initials;
        }
    }

    // Name / handle / bio / member since
    const nameEl = document.getElementById('up-name');
    if (nameEl) nameEl.textContent = profile.display_name || profile.first_name || 'User';
    const userEl = document.getElementById('up-username');
    if (userEl) userEl.textContent = profile.username ? `@${profile.username}` : '';
    const bioEl = document.getElementById('up-bio');
    if (bioEl) bioEl.textContent = profile.bio || '';
    const sinceEl = document.getElementById('up-member-since');
    if (sinceEl && profile.created_at) {
        const since = new Date(profile.created_at).toLocaleDateString('en-SG', { month: 'short', year: 'numeric' });
        sinceEl.textContent = `🌱 Since ${since}`;
    }

    // Inline action button
    const actionEl = document.getElementById('up-action-area');
    if (actionEl) {
        if (status === 'accepted') {
            actionEl.innerHTML = `<button class="up-action-btn up-unfriend" onclick="removeFriendById()">Friends ✓</button>`;
        } else if (status === 'pending') {
            actionEl.innerHTML = `<button class="up-action-btn up-pending" disabled>Requested</button>`;
        } else if (status === 'incoming_request') {
            actionEl.innerHTML = `<button class="up-action-btn up-accept" onclick="acceptIncomingRequest()">Accept</button>`;
        } else {
            actionEl.innerHTML = `<button class="up-action-btn up-add" onclick="sendFriendRequest(${profile.id}, this)">+ Add</button>`;
        }
    }

    // Stats row — show for everyone if teaser/stats data available
    const statsRow = document.getElementById('up-stats-row');
    const statsData = data.stats || data.teaser || {};
    if (statsRow && (statsData.visited_count != null || statsData.places_visited != null)) {
        document.getElementById('up-stat-visited').textContent = statsData.visited_count ?? statsData.places_visited ?? '—';
        document.getElementById('up-stat-saved').textContent   = statsData.saved_count ?? '—';
        if (isFriend) {
            const visitedFpForStreak = (data.friend_places || []).filter(p => p.is_visited && p.visited_at);
            const streak = _computeUpStreak(visitedFpForStreak);
            const streakEl = document.getElementById('up-stat-streak');
            const streakLblEl = document.getElementById('up-stat-streak-label');
            if (streakEl) streakEl.textContent = streak;
            if (streakLblEl) streakLblEl.textContent = streak >= 2 ? 'wk streak 🔥' : 'wk streak';
        }
        statsRow.style.display = 'flex';
    }

    // Insight card + food story button — visible to everyone with visited places
    const fp = data.friend_places || [];
    const visitedFp = fp.filter(p => p.is_visited);
    const teaserVisited = (data.teaser || {}).places_visited || 0;
    if (visitedFp.length > 0 || teaserVisited > 0) {
        if (visitedFp.length > 0) renderUpInsightCard(visitedFp, profile);
        document.getElementById('up-food-story-btn').style.display = '';
    }

    if (isFriend) {
        document.getElementById('up-friend-content').style.display = '';
        document.getElementById('up-stranger-content').style.display = 'none';
        if (_upLeafletMap) { _upLeafletMap.remove(); _upLeafletMap = null; }
        renderUpPhotoGrid(fp);
        renderUpCalendar(fp);
        switchUpView('grid');
    } else {
        document.getElementById('up-friend-content').style.display = 'none';
        document.getElementById('up-stranger-content').style.display = '';
        const lockedSub = document.getElementById('up-locked-sub');
        if (lockedSub) {
            const t = data.teaser || {};
            const parts = [];
            if (t.places_visited > 0) parts.push(`${t.places_visited} places visited`);
            if (t.reviews_count  > 0) parts.push(`${t.reviews_count} reviews`);
            lockedSub.textContent = parts.join(' · ') || '';
        }
    }
}

function switchUpView(view) {
    ['grid','cal','map'].forEach(v => {
        const viewEl = document.getElementById(`up-${v}-view`);
        if (viewEl) viewEl.style.display = (v === view) ? '' : 'none';
        const btn = document.getElementById(`up-toggle-${v}`);
        if (btn) btn.classList.toggle('up-view-btn--active', v === view);
    });
    if (view === 'map' && !_upLeafletMap) {
        renderUpMap(_upFriendPlaces);
    }
}

function renderUpInsightCard(places, profile) {
    const el = document.getElementById('up-insight-card');
    if (!el) return;
    if (places.length === 0) { el.style.display = 'none'; return; }

    const since = profile?.created_at
        ? new Date(profile.created_at).toLocaleDateString('en-SG', { month: 'short', year: 'numeric' })
        : null;

    // Top cuisine from place_types
    const freq = {};
    places.forEach(p => {
        if (!p.place_types) return;
        p.place_types.split(',').forEach(t => {
            const label = t.trim().replace(/_/g, ' ').toLowerCase();
            if (!label || _STATS_GENERIC_TYPES.has(label)) return;
            freq[label] = (freq[label] || 0) + 1;
        });
    });
    const topEntry = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
    const topCuisineLabel = topEntry ? topEntry[0].charAt(0).toUpperCase() + topEntry[0].slice(1) : null;

    // Pick personalized insight (same pattern as own profile)
    const candidates = [];
    if (places.length >= 10) candidates.push({ title: `${places.length} places visited 📍`, desc: 'They\'ve been getting out there a lot.' });
    if (topCuisineLabel && places.length >= 3) candidates.push({ title: `${topCuisineLabel} lover 🍽️`, desc: 'It\'s their most explored cuisine.' });
    if (since && places.length >= 5) candidates.push({ title: 'Seasoned explorer 🗺️', desc: `Sprout since ${since} — they know the scene.` });
    if (places.length >= 3 && places.length < 10) candidates.push({ title: `${places.length} spots visited 📍`, desc: 'Building their food story.' });
    if (places.length === 1) candidates.push({ title: 'Just getting started 🌱', desc: 'Their food journey is beginning.' });
    const fallback = { title: 'Food explorer 🌱', desc: since ? `Sprout since ${since}.` : 'Discovering great places.' };
    const pick = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : fallback;

    // Write directly into el (el already has featured-insight-card class in HTML)
    el.innerHTML = `<p class="featured-insight-title">${escapeHtml(pick.title)}</p><p class="featured-insight-desc">${escapeHtml(pick.desc)}</p>`;
    el.style.display = '';
}

function _computeUpStreak(visitedPlaces) {
    // Mon-anchored weekly buckets, same logic as own profile
    const now = new Date();
    const msPerWeek = 7 * 24 * 3600 * 1000;
    // Find start of current Mon-anchored week
    const dayOfWeek = (now.getDay() + 6) % 7; // Mon=0
    const weekStart = new Date(now - dayOfWeek * 86400000);
    weekStart.setHours(0, 0, 0, 0);

    const buckets = new Array(12).fill(0);
    visitedPlaces.forEach(p => {
        if (!p.visited_at) return;
        const d = new Date(p.visited_at);
        const diff = weekStart - d;
        const weeksAgo = Math.floor(diff / msPerWeek);
        const idx = 11 - weeksAgo;
        if (idx >= 0 && idx < 12) buckets[idx]++;
    });

    let streak = 0;
    for (let i = 11; i >= 0; i--) {
        if (buckets[i] > 0) streak++;
        else break;
    }
    return streak;
}

const _UP_CUISINE_EMOJI = {
    'restaurant': '🍽️', 'cafe': '☕', 'bar': '🍺', 'bakery': '🥐',
    'sushi restaurant': '🍣', 'pizza restaurant': '🍕', 'ramen restaurant': '🍜',
    'chinese restaurant': '🥢', 'japanese restaurant': '🍱', 'italian restaurant': '🍝',
    'korean restaurant': '🥘', 'dessert restaurant': '🍰', 'seafood restaurant': '🦞',
    'fast food restaurant': '🍔', 'thai restaurant': '🌶️', 'indian restaurant': '🍛',
    'mexican restaurant': '🌮',
};

function _upTileEmoji(place) {
    if (!place.place_types) return '🍽️';
    const types = place.place_types.split(',').map(t => t.trim().replace(/_/g, ' ').toLowerCase());
    for (const t of types) { if (_UP_CUISINE_EMOJI[t]) return _UP_CUISINE_EMOJI[t]; }
    return '🍽️';
}

function renderUpPhotoGrid(places) {
    _upFriendPlaces = places;  // store ALL places (visited + unvisited) for map
    const el = document.getElementById('up-photo-grid');
    if (!el) return;
    const visited = places.filter(p => p.is_visited);
    if (visited.length === 0) {
        el.innerHTML = '<p style="color:var(--hint-color);font-size:0.85rem;padding:16px 0;grid-column:1/-1">No visited places yet.</p>';
        return;
    }
    el.innerHTML = visited.slice(0, 9).map(p => {
        const gid = escapeHtml(p.google_place_id || '');
        const pJson = escapeHtml(JSON.stringify(p));
        const safeName = escapeHtml(p.name || '');
        const emoji = _upTileEmoji(p);
        return `<div class="vg-tile vg-tile--emoji" onclick="onDiscoverResultTap('${gid}',${pJson})">
            <span class="vg-tile-emoji">${emoji}</span>
            <div class="vg-tile-overlay"><span class="vg-tile-name">${safeName}</span></div>
        </div>`;
    }).join('');
}

function renderUpCalendar(places) {
    _upCalVisited     = places.filter(p => p.is_visited);
    _upCalMonthOffset = 0;
    _renderUpCalendarForOffset(0);
}

function navigateUpCalendar(delta) {
    _upCalMonthOffset += delta;
    _renderUpCalendarForOffset(_upCalMonthOffset);
}

function _renderUpCalendarForOffset(offset) {
    const calEl = document.getElementById('up-calendar');
    if (!calEl || !_upCalVisited) return;

    const now    = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const year   = target.getFullYear();
    const month  = target.getMonth();
    const isCurrentMonth = offset === 0;

    const dayMap = {};
    _upCalVisited.forEach(p => {
        if (!p.visited_at) return;
        const d = new Date(p.visited_at);
        if (d.getFullYear() !== year || d.getMonth() !== month) return;
        const key = `${year}-${String(month+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        if (!dayMap[key]) dayMap[key] = [];
        dayMap[key].push(p);
    });

    const firstDay   = new Date(year, month, 1);
    const totalDays  = new Date(year, month + 1, 0).getDate();
    const startOffset = (firstDay.getDay() + 6) % 7;
    const monthName  = firstDay.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });

    const oldestVisit = _upCalVisited.reduce((min, p) => {
        if (!p.visited_at) return min;
        const t = new Date(p.visited_at).getTime();
        return t < min ? t : min;
    }, Infinity);
    const oldestDate = isFinite(oldestVisit) ? new Date(oldestVisit) : now;
    const minOffset  = (oldestDate.getFullYear() - now.getFullYear()) * 12 + (oldestDate.getMonth() - now.getMonth());
    const canGoPrev  = offset > minOffset;
    const canGoNext  = offset < 0;

    let html = `
        <div class="cal-nav">
            <button class="cal-nav-btn" onclick="navigateUpCalendar(-1)" ${!canGoPrev ? 'disabled' : ''}>‹</button>
            <span class="cal-header">${monthName}</span>
            <button class="cal-nav-btn" onclick="navigateUpCalendar(1)" ${!canGoNext ? 'disabled' : ''}>›</button>
        </div>
        <div class="cal-grid">`;
    ['M','T','W','T','F','S','S'].forEach(d => { html += `<div class="cal-dow">${d}</div>`; });
    for (let i = 0; i < startOffset; i++) html += `<div class="cal-cell"></div>`;
    for (let day = 1; day <= totalDays; day++) {
        const key     = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const hasVisit = !!dayMap[key];
        const todayClass = (isCurrentMonth && day === now.getDate()) ? ' cal-cell--today' : '';
        html += hasVisit
            ? `<div class="cal-cell cal-cell--visited${todayClass}">${day}</div>`
            : `<div class="cal-cell${todayClass}">${day}</div>`;
    }
    html += `</div>`;
    calEl.innerHTML = html;
}

function _upViewPlace(idx) {
    const p = _upFriendPlaces[idx];
    if (!p) return;
    onDiscoverResultTap(p.google_place_id || '', p);
}

function _upGetMarkerIcon(zoom, place) {
    const isVisited = place.is_visited;
    const embeddedReview = (place.food_score != null || place.vibe_score != null || place.value_score != null || place.sentiment)
        ? { food_score: place.food_score, vibe_score: place.vibe_score, value_score: place.value_score, sentiment: place.sentiment, overall_rating: place.overall_rating }
        : null;
    const score = isVisited ? computePlaceScore(embeddedReview) : null;

    if (zoom < 10) {
        const bg = !isVisited ? '#1E3A2B' : (score !== null ? scoreMarkerColor(score) : '#7CB98E');
        return L.divIcon({
            className: '',
            html: `<div class="marker-dot" style="background:${bg};border:2px solid ${bg};box-sizing:border-box"></div>`,
            iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6],
        });
    }

    const sz = zoom < 15 ? 30 : zoom < 18 ? 40 : 52;
    if (score !== null) {
        const bg = scoreMarkerColor(score);
        const fs = zoom < 15 ? 11 : zoom < 18 ? 14 : 17;
        return L.divIcon({
            className: '',
            html: `<div class="score-marker" style="width:${sz}px;height:${sz}px;background:${bg};font-size:${fs}px">${score.toFixed(1)}</div>`,
            iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2], popupAnchor: [0, -(sz / 2 + 2)],
        });
    }

    const iconSz = zoom < 15 ? 9 : zoom < 18 ? 12 : 15;
    if (isVisited) {
        const innerHtml = `<div class="score-marker-dot" style="width:${sz}px;height:${sz}px;background:#7CB98E;border:2px solid #5a9a70;box-sizing:border-box;display:flex;align-items:center;justify-content:center;">
            <svg width="${iconSz}" height="${iconSz}" viewBox="0 0 10 10" fill="none">
                <polyline points="2,5 4.5,7.5 8,3" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>`;
        return L.divIcon({
            className: '',
            html: innerHtml,
            iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2], popupAnchor: [0, -(sz / 2 + 2)],
        });
    } else {
        const usz = zoom < 15 ? 26 : zoom < 18 ? 35 : 46;
        const emojiFontSz = Math.round(usz * 0.55);
        const innerHtml = `<div class="score-marker-dot" style="width:${usz}px;height:${usz}px;background:white;border:2px solid #A8D58A;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:${emojiFontSz}px;line-height:1;">🌱</div>`;
        return L.divIcon({
            className: '',
            html: innerHtml,
            iconSize: [usz, usz], iconAnchor: [usz / 2, usz / 2], popupAnchor: [0, -(usz / 2 + 2)],
        });
    }
}

function createUpPopupContent(p, idx) {
    const isVisited = p.is_visited;
    const embeddedReview = (p.food_score != null || p.vibe_score != null || p.value_score != null || p.sentiment)
        ? { food_score: p.food_score, vibe_score: p.vibe_score, value_score: p.value_score, sentiment: p.sentiment }
        : null;
    const score = isVisited ? computePlaceScore(embeddedReview) : null;

    let html = `<div class="place-popup ${isVisited ? 'place-popup--reviewed' : 'place-popup--new'}" data-place-id="${p.id || ''}">`;
    html += `<div class="popup-body">`;
    html += `<div class="place-popup-name">${escapeHtml(p.name || '')}</div>`;

    const revTypes = formatPlaceTypes(p.place_types);
    const revPrice = p.place_price_level && PLACE_PRICE_LABELS?.[p.place_price_level] ? PLACE_PRICE_LABELS[p.place_price_level] : '';

    if (isVisited) {
        // ── VISITED: matches createPopupContent visited branch ──────────────
        const revDate = p.visited_at ? formatShortDate(p.visited_at) : '';
        const subtitle = [revTypes, revPrice, revDate].filter(Boolean).join(' · ');
        if (subtitle) html += `<div class="popup-info-row popup-info-muted">${escapeHtml(subtitle)}</div>`;

        // Sentiment chip + overall score badge
        if (embeddedReview) {
            const pfs = embeddedReview.food_score, pvs = embeddedReview.vibe_score, pls = embeddedReview.value_score;
            const pScores = [pfs, pvs, pls].filter(v => v != null);
            const pOverall = pScores.length ? (pScores.reduce((a,b)=>a+b,0)/pScores.length).toFixed(1) : null;
            const pScClass = pOverall ? (parseFloat(pOverall) >= 8 ? 'score-high' : parseFloat(pOverall) >= 6 ? 'score-mid' : 'score-low') : '';
            const sentEmoji = SENTIMENT_EMOJI?.[embeddedReview.sentiment] || '';
            const sentLabel = { loved: 'Loved it', okay: 'It was okay', meh: 'Meh' }[embeddedReview.sentiment] || '';
            if (sentLabel || pOverall) {
                html += `<div class="popup-sentiment-row">${sentLabel ? `<span class="popup-sent-chip ${embeddedReview.sentiment}">${sentEmoji} ${sentLabel}</span>` : ''}${pOverall ? `<span class="popup-sent-overall ${pScClass}">${pOverall}</span>` : ''}</div>`;
            }
            // Sub-scores
            if (pfs != null || pvs != null || pls != null) {
                html += `<div class="popup-scores">`;
                if (pfs != null) html += `<span class="popup-score-chip">🍽 Food <b>${pfs}</b></span>`;
                if (pvs != null) html += `<span class="popup-score-chip">🎵 Vibe <b>${pvs}</b></span>`;
                if (pls != null) html += `<span class="popup-score-chip">💰 Value <b>${pls}</b></span>`;
                html += `</div>`;
            }
            // Caption
            if (p.caption) html += `<div class="popup-caption">"${escapeHtml(p.caption)}"</div>`;
        } else {
            html += `<div class="popup-sentiment-row"><span class="popup-sent-chip loved">✓ Visited</span></div>`;
        }

        html += `<button class="popup-primary-btn" onclick="_upViewPlace(${idx})">View</button>`;

    } else {
        // ── SAVED / WANT TO GO: matches createPopupContent unvisited branch ─
        const subtitle = [revTypes, revPrice].filter(Boolean).join(' · ');
        if (subtitle) html += `<div class="popup-info-row popup-info-muted">${escapeHtml(subtitle)}</div>`;
        if (p.place_rating) {
            const cnt = p.place_rating_count ? ` (${Number(p.place_rating_count).toLocaleString()})` : '';
            html += `<div class="popup-info-row popup-info-muted">⭐ ${p.place_rating}${cnt}</div>`;
        }
        if (p.place_description) html += `<div class="popup-caption">${escapeHtml(p.place_description)}</div>`;
        html += buildPopupHoursHtml(p);
    }

    // Maps link (no Reel, no Delete for friend places)
    const secParts = [];
    if (p.google_place_id) {
        secParts.push(`<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name||'')}&query_place_id=${p.google_place_id}" target="_blank" class="popup-sec-btn">📍 Maps</a>`);
    } else if (p.latitude && p.longitude) {
        secParts.push(`<a href="https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}" target="_blank" class="popup-sec-btn">📍 Maps</a>`);
    }
    if (secParts.length) html += `<div class="popup-secondary-actions">${secParts.join('')}</div>`;

    html += `</div></div>`;
    return html;
}

function renderUpMap(places) {
    const container = document.getElementById('up-map-inner');
    if (!container) return;
    if (_upLeafletMap) { _upLeafletMap.remove(); _upLeafletMap = null; }

    const withCoords = places.filter(p => p.latitude && p.longitude);
    if (withCoords.length === 0) {
        container.innerHTML = '<p style="padding:20px;color:var(--hint-color);text-align:center">No location data available.</p>';
        return;
    }

    const upMap = L.map(container, { zoomControl: false, attributionControl: false });
    L.tileLayer('https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=cb1_2dip_1_a547affd6e732c636841df27', {
        maxZoom: 20
    }).addTo(upMap);
    _upLeafletMap = upMap;

    const bounds = [];
    withCoords.forEach(p => {
        const idx = _upFriendPlaces.indexOf(p);
        const marker = L.marker([p.latitude, p.longitude], {
            icon: _upGetMarkerIcon(upMap.getZoom(), p),
        }).addTo(upMap);
        marker.bindPopup(() => createUpPopupContent(p, idx), { maxWidth: 280, className: 'custom-popup' });
        upMap.on('zoomend', () => marker.setIcon(_upGetMarkerIcon(upMap.getZoom(), p)));
        bounds.push([p.latitude, p.longitude]);
    });

    if (bounds.length === 1) {
        upMap.setView(bounds[0], 14);
    } else {
        upMap.fitBounds(bounds, { padding: [30, 30] });
    }
}

function openUpFoodStory() {
    const overlay = document.getElementById('up-food-story-overlay');
    const sheet   = document.getElementById('up-food-story-sheet');
    if (!overlay || !sheet) return;

    const friendName = document.getElementById('up-name')?.textContent || 'Friend';
    const titleEl = document.getElementById('up-food-story-title');
    if (titleEl) titleEl.textContent = `${friendName}'s Food Story`;

    const visited  = (_upFriendPlaces || []).filter(p => p.is_visited);
    const reviewed = visited.filter(p => p.food_score != null || p.vibe_score != null || p.value_score != null || p.sentiment);

    // Non-friend: no place data — show teaser prompt
    if (visited.length === 0) {
        const body = document.getElementById('up-food-story-body');
        if (body) body.innerHTML = `<div style="padding:32px 20px;text-align:center;color:var(--hint-color)">
            <div style="font-size:2rem;margin-bottom:12px">🌱</div>
            <p style="font-weight:600;color:var(--text-color);margin-bottom:6px">Add ${escapeHtml(friendName)} as a friend</p>
            <p style="font-size:0.85rem">to see their full food story and reviews</p>
        </div>`;
        overlay.style.display = 'flex';
        sheet.classList.add('rc-open');
        return;
    }

    function _upSHd(name, meta) {
        return `<div class="stats-section-hd"><h4 class="stats-section-name">${escapeHtml(name)}</h4>${meta ? `<span class="stats-section-meta">${escapeHtml(meta)}</span>` : ''}</div>`;
    }
    function _upRankRow(num, name, sub, scoreStr, tapFn) {
        const hasTap = !!tapFn;
        return `<div class="stats-rank-row${hasTap ? '' : ' stats-rank-row--no-tap'}"${hasTap ? ` onclick="${tapFn}"` : ''}>
            <span class="stats-rank-num">${escapeHtml(String(num))}</span>
            <div class="stats-rank-main">
                <p class="stats-rank-name">${escapeHtml(name)}</p>
                ${sub ? `<p class="stats-rank-sub">${escapeHtml(sub)}</p>` : ''}
            </div>
            ${scoreStr != null ? `<span class="stats-rank-score">${escapeHtml(String(scoreStr))}</span>` : ''}
        </div>`;
    }

    let html = '';

    // ── 1. Review mix ──
    if (reviewed.length >= 1) {
        const loved = reviewed.filter(p => p.sentiment === 'loved').length;
        const okay  = reviewed.filter(p => p.sentiment === 'okay').length;
        const meh   = reviewed.length - loved - okay;
        const lovedPct = Math.round(loved / reviewed.length * 100);
        const okayPct  = Math.round(okay  / reviewed.length * 100);
        const mehPct   = Math.max(0, 100 - lovedPct - okayPct);
        html += _upSHd('Review mix', `${reviewed.length} review${reviewed.length !== 1 ? 's' : ''}`);
        html += `<div class="sentiment-bar">
            <div class="sentiment-seg-meh"   style="width:${mehPct}%"></div>
            <div class="sentiment-seg-okay"  style="width:${okayPct}%"></div>
            <div class="sentiment-seg-loved" style="width:${lovedPct}%"></div>
        </div>
        <div class="sentiment-legend">
            <span class="sentiment-legend-item"><span class="sentiment-dot" style="background:var(--border-color)"></span>Meh ${mehPct}%</span>
            <span class="sentiment-legend-item"><span class="sentiment-dot" style="background:#A8D5B8"></span>Okay ${okayPct}%</span>
            <span class="sentiment-legend-item"><span class="sentiment-dot" style="background:var(--sprout-forest)"></span>Loved ${lovedPct}%</span>
        </div>`;
    }

    // ── 2. Score averages ──
    const scoredPlaces = reviewed.filter(p => p.food_score != null || p.vibe_score != null || p.value_score != null);
    if (scoredPlaces.length >= 2) {
        const avg = (dim) => {
            const vals = scoredPlaces.map(p => p[dim]).filter(v => v != null);
            return vals.length ? Math.round(vals.reduce((a,b) => a+b, 0) / vals.length * 10) / 10 : null;
        };
        const dims = [
            { label: 'Food',  avg: avg('food_score'),  count: scoredPlaces.filter(p => p.food_score != null).length },
            { label: 'Vibe',  avg: avg('vibe_score'),  count: scoredPlaces.filter(p => p.vibe_score != null).length },
            { label: 'Value', avg: avg('value_score'), count: scoredPlaces.filter(p => p.value_score != null).length },
        ].filter(d => d.avg !== null);
        if (dims.length > 0) {
            const maxCount = Math.max(...dims.map(d => d.count));
            html += _upSHd('What they look for', `${maxCount} review${maxCount !== 1 ? 's' : ''}`);
            html += `<div class="score-avg-list">`;
            dims.forEach(d => {
                const pct = Math.round(d.avg / 10 * 100);
                html += `<div class="score-avg-row">
                    <span class="score-avg-lbl">${escapeHtml(d.label)}</span>
                    <div class="score-avg-bar-bg"><div class="score-avg-bar-fill" style="width:${pct}%"></div></div>
                    <span class="score-avg-val">${d.avg}</span>
                </div>`;
            });
            html += `</div>`;
        }
    }

    // ── 3. Top restaurants ──
    const scoredRestaurants = visited
        .map(p => {
            const rv = (p.food_score != null || p.vibe_score != null || p.value_score != null || p.sentiment)
                ? { food_score: p.food_score, vibe_score: p.vibe_score, value_score: p.value_score, sentiment: p.sentiment }
                : null;
            return { place: p, score: computePlaceScore(rv) };
        })
        .filter(x => x.score !== null)
        .sort((a, b) => b.score - a.score);
    if (scoredRestaurants.length >= 1) {
        html += _upSHd('Top restaurants', `${visited.length} visited`);
        html += `<div class="stats-rank-list">`;
        scoredRestaurants.slice(0, 3).forEach((x, i) => {
            const cuisine = x.place.place_types
                ? x.place.place_types.split(',').map(t => t.trim().replace(/_/g,' ')).find(t => !_STATS_GENERIC_TYPES.has(t.toLowerCase()))
                : null;
            html += _upRankRow(i + 1, x.place.name, cuisine || '', x.score.toFixed(1), `_upViewPlace(${_upFriendPlaces.indexOf(x.place)})`);
        });
        html += `</div>`;
    }

    // ── 4. Cuisines explored ──
    const cuisineMap = {};
    visited.forEach(p => {
        if (!p.place_types) return;
        const rv = (p.food_score != null || p.vibe_score != null || p.value_score != null || p.sentiment)
            ? { food_score: p.food_score, vibe_score: p.vibe_score, value_score: p.value_score, sentiment: p.sentiment }
            : null;
        const score = computePlaceScore(rv);
        p.place_types.split(',').forEach(t => {
            const label = t.trim().replace(/_/g,' ').toLowerCase();
            if (!label || _STATS_GENERIC_TYPES.has(label)) return;
            if (!cuisineMap[label]) cuisineMap[label] = { count: 0, scores: [] };
            cuisineMap[label].count++;
            if (score !== null) cuisineMap[label].scores.push(score);
        });
    });
    const allCuisines = Object.entries(cuisineMap)
        .map(([label, d]) => ({
            label: label.charAt(0).toUpperCase() + label.slice(1),
            count: d.count,
            avgScore: d.scores.length ? Math.round(d.scores.reduce((a,b) => a+b, 0) / d.scores.length * 10) / 10 : null,
        }))
        .sort((a, b) => b.count - a.count);
    if (allCuisines.length >= 1 && visited.length >= 2) {
        html += _upSHd('Cuisines explored', `${allCuisines.length} type${allCuisines.length !== 1 ? 's' : ''}`);
        html += `<div class="stats-rank-list">`;
        allCuisines.slice(0, 3).forEach((c, i) => {
            const sub = c.avgScore !== null
                ? `${c.count} visit${c.count !== 1 ? 's' : ''} · ${c.avgScore} avg`
                : `${c.count} visit${c.count !== 1 ? 's' : ''}`;
            html += _upRankRow(i + 1, c.label, sub, null, '');
        });
        html += `</div>`;
    }

    // ── 5. Discovery habits ──
    const visitedWithDate = visited.filter(p => p.visited_at);
    if (visitedWithDate.length >= 3) {
        const dayCounts = {};
        visitedWithDate.forEach(p => {
            const d = new Date(p.visited_at);
            const day = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
            dayCounts[day] = (dayCounts[day] || 0) + 1;
        });
        const topDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
        const dayEmoji = { Monday:'📅', Tuesday:'📅', Wednesday:'📅', Thursday:'🌆', Friday:'🎉', Saturday:'🎊', Sunday:'🌞' };
        if (topDay) {
            html += _upSHd('Discovery habits');
            html += `<div class="stats-rank-list">`;
            html += _upRankRow(dayEmoji[topDay[0]] || '📅', `Eats out most on ${topDay[0]}s`, '', null, '');
            html += `</div>`;
        }
    }

    if (!html) html = `<p style="color:var(--hint-color);font-size:0.85rem">Not enough data yet.</p>`;

    const content = document.getElementById('up-food-story-content');
    if (content) content.innerHTML = html;

    overlay.style.display = 'flex';
    sheet.classList.add('rc-open');
}

function closeUpFoodStory() {
    const overlay = document.getElementById('up-food-story-overlay');
    const sheet   = document.getElementById('up-food-story-sheet');
    if (overlay) overlay.style.display = 'none';
    if (sheet) sheet.classList.remove('rc-open');
}

// Implement previously-undefined friend action functions
async function acceptIncomingRequest() {
    if (!_upFriendshipId || !_upUserId) return;
    try {
        const res = await fetch(`${API_URL}/api/friends/${_upFriendshipId}/accept`, {
            method: 'POST', headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error('accept failed');
        openUserProfile(_upUserId);
        loadFriendRequests();
        loadFriends();
    } catch (err) { console.error('acceptIncomingRequest error:', err); }
}

async function removeFriendById() {
    if (!_upFriendshipId || !_upUserId) return;
    try {
        const res = await fetch(`${API_URL}/api/friends/${_upFriendshipId}`, {
            method: 'DELETE', headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error('remove failed');
        openUserProfile(_upUserId);
        _friendsCache = null;
        loadFriends();
    } catch (err) { console.error('removeFriendById error:', err); }
}

// ========== PROFILE ==========

let profileData = null;

async function loadProfile() {
    try {
        const now = Date.now();
        if (_profileCache && (now - _profileCache.ts) < PROFILE_CACHE_TTL_MS) {
            profileData = _profileCache.data;
            renderProfile(profileData);
            await Promise.all([loadFriends(), loadFriendRequests()]);
            return;
        }
        showProfileSkeleton();
        const res = await fetch('/api/me', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error('Failed to load profile');
        const raw = await res.json();
        profileData = raw.profile || raw;   // unwrap {profile: ...} wrapper
        _profileCache = { data: profileData, ts: Date.now() };
        clearProfileSkeleton();
        renderProfile(profileData);
        await Promise.all([loadFriends(), loadFriendRequests()]);
    } catch (err) {
        console.error('loadProfile error:', err);
    }
}

function renderProfile(data) {
    const displayName = data.display_name || data.first_name || 'You';
    const nameEl = document.getElementById('profile-display-name');
    const userEl = document.getElementById('profile-username');
    const bioEl = document.getElementById('profile-bio');
    const avatarEl = document.getElementById('profile-avatar-circle');

    if (nameEl) nameEl.textContent = displayName;
    if (userEl) userEl.textContent = data.username ? `@${data.username}` : '';
    if (bioEl) bioEl.textContent = data.bio || '';
    if (avatarEl) {
        const photoUrl = data.avatar_url
            || window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url
            || null;
        if (photoUrl) {
            avatarEl.innerHTML = '';
            avatarEl.style.backgroundImage = `url(${photoUrl})`;
            avatarEl.style.backgroundSize = 'cover';
            avatarEl.style.backgroundPosition = 'center';
            avatarEl.textContent = '';
        } else {
            avatarEl.style.backgroundImage = '';
            const initials = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            avatarEl.textContent = initials;
        }
    }

    const stats = data.stats || {};
    const savedEl = document.getElementById('stat-saved');
    const visitedEl = document.getElementById('stat-visited');
    if (savedEl) savedEl.textContent = stats.places_saved ?? stats.saved ?? '—';
    if (visitedEl) visitedEl.textContent = stats.places_visited ?? stats.visited ?? '—';

    renderStatsCard(null);
    loadSocialStats().then(social => renderStatsCard(social));
    renderMyVisits();
}

// ── Stats Card ──────────────────────────────────────────────────────────────

const _STATS_GENERIC_TYPES = new Set([
    'point of interest', 'establishment', 'food', 'store', 'health',
    'premise', 'route', 'locality', 'political', 'sublocality',
    'sublocality level 1', 'country', 'administrative area level 1',
    'administrative area level 2', 'neighborhood', 'colloquial area',
    'natural feature', 'place of worship', 'general contractor',
]);

// ── P1 Compute Helpers ───────────────────────────────────────────────────────

function computeScoreAverages() {
    const food = [], vibe = [], value = [];
    (allReviews || []).forEach(r => {
        if (r.food_score != null) food.push(r.food_score);
        if (r.vibe_score != null) vibe.push(r.vibe_score);
        if (r.value_score != null) value.push(r.value_score);
    });
    const avg = arr => arr.length >= 2
        ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10
        : null;
    return {
        food:  { avg: avg(food),  count: food.length  },
        vibe:  { avg: avg(vibe),  count: vibe.length  },
        value: { avg: avg(value), count: value.length },
    };
}

function computeTopRestaurants() {
    return (places || [])
        .filter(p => p.is_visited)
        .map(p => {
            const r = getPlaceReview(p.id);
            return {
                place: p, review: r,
                score: computePlaceScore(r),
                food:  r?.food_score  ?? null,
                vibe:  r?.vibe_score  ?? null,
                value: r?.value_score ?? null,
            };
        })
        .filter(x => x.score !== null);
}

function computeTopCuisines() {
    const freq = {}, scoreMap = {};
    (places || []).filter(p => p.is_visited && p.place_types).forEach(p => {
        const r = getPlaceReview(p.id);
        const score = computePlaceScore(r);
        p.place_types.split(',').forEach(t => {
            const label = t.trim().replace(/_/g, ' ').toLowerCase();
            if (!label || _STATS_GENERIC_TYPES.has(label)) return;
            freq[label] = (freq[label] || 0) + 1;
            if (score !== null) {
                scoreMap[label] = scoreMap[label] || [];
                scoreMap[label].push(score);
            }
        });
    });
    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => {
            const scores = scoreMap[label] || [];
            return {
                label: label.charAt(0).toUpperCase() + label.slice(1),
                count,
                avgScore: scores.length >= 2
                    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
                    : null,
                reviewCount: scores.length,
            };
        });
}

function computeTopDishes() {
    const out = [];
    (allReviews || []).forEach(r => {
        const place = (places || []).find(p => p.id === r.place_id);
        if (!place) return;
        (r.dishes || []).filter(d => d.rating != null).forEach(d => {
            out.push({ dish: d, place, review: r });
        });
    });
    return out.sort((a, b) => b.dish.rating - a.dish.rating);
}

function computeProfileStats() {
    const allPlaces = places || [];
    const visited = allPlaces.filter(p => p.is_visited);
    const totalSaved = allPlaces.length;
    const totalVisited = visited.length;

    // Conversion rate
    const conversionRate = totalSaved > 0 ? Math.round((totalVisited / totalSaved) * 100) : 0;
    let conversionPersona = '';
    if (totalSaved >= 3) {
        if (conversionRate >= 70) conversionPersona = 'Decisive ✅';
        else if (conversionRate >= 30) conversionPersona = 'Explorer 🗺️';
        else conversionPersona = 'The Collector 📌';
    }

    // Avg days save → visit
    const dayDiffs = visited
        .filter(p => p.created_at && p.visited_at)
        .map(p => Math.round((new Date(p.visited_at) - new Date(p.created_at)) / 86400000))
        .filter(d => d >= 0);
    let avgDays = null;
    let avgDaysPersona = '';
    if (dayDiffs.length > 0) {
        avgDays = Math.round(dayDiffs.reduce((a, b) => a + b, 0) / dayDiffs.length);
        if (avgDays <= 3) avgDaysPersona = 'Spontaneous ⚡';
        else if (avgDays <= 14) avgDaysPersona = 'Decisive ✅';
        else if (avgDays <= 45) avgDaysPersona = 'Planner 📋';
        else avgDaysPersona = 'The Collector 📌';
    }

    // Top cuisine
    const typeCounts = {};
    visited.forEach(p => {
        if (!p.place_types) return;
        p.place_types.split(',').forEach(t => {
            const label = t.trim().replace(/_/g, ' ').toLowerCase();
            if (!label || _STATS_GENERIC_TYPES.has(label)) return;
            typeCounts[label] = (typeCounts[label] || 0) + 1;
        });
    });
    const topCuisineEntry = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
    const topCuisineLabel = topCuisineEntry
        ? topCuisineEntry[0].charAt(0).toUpperCase() + topCuisineEntry[0].slice(1)
        : null;

    // Love rate
    const sentimentCounts = { loved: 0, okay: 0, meh: 0 };
    (allReviews || []).forEach(r => {
        if (r.sentiment && sentimentCounts[r.sentiment] !== undefined) sentimentCounts[r.sentiment]++;
    });
    const totalRated = sentimentCounts.loved + sentimentCounts.okay + sentimentCounts.meh;
    const loveRate = totalRated > 0 ? Math.round((sentimentCounts.loved / totalRated) * 100) : null;

    // Activity streak (12 weekly Mon-anchored buckets)
    const activityDates = [];
    allPlaces.forEach(p => {
        if (p.visited_at) activityDates.push(new Date(p.visited_at));
        if (p.created_at) activityDates.push(new Date(p.created_at));
    });
    (allReviews || []).forEach(r => {
        if (r.created_at) activityDates.push(new Date(r.created_at));
    });
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dow);
    weekStart.setHours(0, 0, 0, 0);
    const buckets = new Array(12).fill(0);
    activityDates.forEach(d => {
        const weeksFromStart = Math.floor((d - weekStart) / (7 * 86400000));
        const idx = 11 + weeksFromStart;
        if (idx >= 0 && idx <= 11) buckets[idx]++;
    });
    // Streak: if current week is empty (week just started), count from last week
    let streak = 0;
    let streakStart = buckets[11] > 0 ? 11 : 10;
    for (let i = streakStart; i >= 0; i--) {
        if (buckets[i] > 0) streak++;
        else break;
    }

    // Most active day of week
    const dayCounts = [0, 0, 0, 0, 0, 0, 0];
    visited.forEach(p => { if (p.visited_at) dayCounts[new Date(p.visited_at).getDay()]++; });
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const DAY_EMOJI = ['☀️', '📅', '🌿', '🌊', '⚡', '🍻', '🌙'];
    const topDayIdx = dayCounts.indexOf(Math.max(...dayCounts));
    // topDay: just the name (emoji goes in the row icon slot)
    const topDay = totalVisited >= 3 ? DAY_NAMES[topDayIdx] : null;
    const topDayEmoji = totalVisited >= 3 ? DAY_EMOJI[topDayIdx] : null;

    // Member since
    const allDates = allPlaces.map(p => p.created_at).filter(Boolean).map(d => new Date(d));
    const earliest = allDates.length > 0 ? new Date(Math.min(...allDates)) : null;
    const memberSince = earliest
        ? earliest.toLocaleDateString('en-SG', { month: 'short', year: 'numeric' })
        : null;

    // Total reviews with any sentiment
    const totalReviews = totalRated;

    // Average score across visited places with any score
    const scoredReviews = (allReviews || [])
        .map(r => computePlaceScore(r))
        .filter(sc => sc !== null);
    const avgScore = scoredReviews.length > 0
        ? Math.round(scoredReviews.reduce((a, b) => a + b, 0) / scoredReviews.length * 10) / 10
        : null;

    return {
        totalSaved, totalVisited,
        conversionRate, conversionPersona,
        avgDays, avgDaysPersona,
        topCuisineLabel,
        loveRate, totalReviews,
        streak, buckets, activityDates,
        topDay, topDayEmoji,
        memberSince, avgScore,
    };
}

async function loadSocialStats() {
    try {
        const res = await fetch('/api/me/stats/social', { headers: getAuthHeaders() });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

function renderStatsCard(socialStats) {
    const section = document.getElementById('stats-card-section');
    if (!section) return;

    const s = computeProfileStats();
    const trendCount = socialStats?.trendsetter_count || 0;
    const sharedCount = socialStats?.shared_count || 0;

    // Compute memberSince from profile account creation date (most reliable)
    const profileCreatedAt = profileData?.created_at;
    const memberSince = profileCreatedAt
        ? new Date(profileCreatedAt).toLocaleDateString('en-SG', { month: 'short', year: 'numeric' })
        : s.memberSince;

    // ── Zone 1: Member since note (below bio) ──
    const memberSinceEl = document.getElementById('profile-member-since');
    if (memberSinceEl) memberSinceEl.textContent = memberSince ? `🌱 Since ${memberSince}` : '';

    // ── Zone 2: Streak ──
    const streakEl = document.getElementById('stat-streak');
    const streakLabelEl = document.getElementById('stat-streak-label');
    if (streakEl) streakEl.textContent = s.streak;
    if (streakLabelEl) streakLabelEl.textContent = s.streak >= 2 ? 'wk streak 🔥' : 'wk streak';

    // ── Zone 3: Featured insight card ──
    renderFeaturedInsight(s, socialStats);

    // ── Stats sheet: mirror saved/visited + since note ──
    const savedVal = document.getElementById('stat-saved')?.textContent || '—';
    const visitedVal = document.getElementById('stat-visited')?.textContent || '—';
    const sheetSaved = document.getElementById('stats-sheet-saved');
    const sheetVisited = document.getElementById('stats-sheet-visited');
    const sheetStreakEl = document.getElementById('stats-sheet-streak');
    const sheetStreakLblEl = document.getElementById('stats-sheet-streak-label');
    const sheetSinceNote = document.getElementById('stats-sheet-since-note');
    if (sheetSaved) sheetSaved.textContent = savedVal;
    if (sheetVisited) sheetVisited.textContent = visitedVal;
    if (sheetStreakEl) sheetStreakEl.textContent = s.streak;
    if (sheetStreakLblEl) sheetStreakLblEl.textContent = s.streak >= 2 ? 'wk streak 🔥' : 'wk streak';
    if (sheetSinceNote) sheetSinceNote.textContent = memberSince ? `🌱 Sprout since ${memberSince}` : '';

    // ── Full food story content ──
    renderFoodStoryContent(s, socialStats);
}

// ── renderFeaturedInsight ────────────────────────────────────────────────────
function renderFeaturedInsight(s, socialStats) {
    const card = document.getElementById('featured-insight-card');
    if (!card) return;
    const trendCount = socialStats?.trendsetter_count || 0;

    // Build all satisfied insights — pick one randomly each render
    const candidates = [];

    if (s.totalSaved >= 3 && s.conversionPersona) {
        if (s.conversionRate >= 70) {
            candidates.push({ title: 'You\'re Decisive ✅', desc: `You visit ${s.conversionRate}% of the places you save.` });
        } else if (s.conversionRate >= 30) {
            candidates.push({ title: 'You\'re an Explorer 🗺️', desc: `You've visited ${s.conversionRate}% of places you saved.` });
        } else {
            candidates.push({ title: 'You\'re a Collector 📌', desc: `You've saved ${s.totalSaved} places — try visiting some!` });
        }
    }
    if (s.loveRate !== null && s.loveRate >= 60 && s.totalReviews >= 3) {
        candidates.push({ title: `${s.loveRate}% loved ❤️`, desc: 'You\'ve loved the majority of places you\'ve reviewed.' });
    }
    if (s.streak >= 3) {
        candidates.push({ title: `${s.streak}-week streak 🔥`, desc: 'You\'ve been exploring consistently — keep it up!' });
    }
    if (trendCount >= 2) {
        candidates.push({ title: 'Trendsetter 🌟', desc: `You've introduced ${trendCount} places to your friends.` });
    }
    if (s.topCuisineLabel && s.totalVisited >= 3) {
        candidates.push({ title: `${s.topCuisineLabel} lover 🍽️`, desc: 'It\'s your most explored cuisine.' });
    }
    if (s.totalVisited >= 10) {
        candidates.push({ title: `${s.totalVisited} places visited 📍`, desc: 'You\'ve been getting out there — nice work!' });
    }
    if (s.totalReviews >= 5 && s.avgScore !== null) {
        candidates.push({ title: `Avg score ${s.avgScore} ⭐`, desc: `Across ${s.totalReviews} reviewed places.` });
    }

    const fallback = { title: 'Start exploring 🌱', desc: 'Visit a few places to unlock your food personality.' };
    const pick = candidates.length > 0
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : fallback;

    card.innerHTML = `<p class="featured-insight-title">${escapeHtml(pick.title)}</p><p class="featured-insight-desc">${escapeHtml(pick.desc)}</p>`;
}

// ── renderFoodStoryContent ───────────────────────────────────────────────────
function renderFoodStoryContent(s, socialStats) {
    const el = document.getElementById('stats-full-content');
    if (!el) return;

    const trendCount = socialStats?.trendsetter_count || 0;
    const sharedCount = socialStats?.shared_count || 0;

    // Section header helper
    function sHd(name, meta) {
        return `<div class="stats-section-hd"><h4 class="stats-section-name">${escapeHtml(name)}</h4>${meta ? `<span class="stats-section-meta">${escapeHtml(meta)}</span>` : ''}</div>`;
    }

    // Rank row helper (num can be a string like "1" or an emoji)
    function rankRow(num, name, sub, scoreStr, tapFn) {
        const hasTap = !!tapFn;
        return `<div class="stats-rank-row${hasTap ? '' : ' stats-rank-row--no-tap'}"${hasTap ? ` onclick="${tapFn}"` : ''}>
            <span class="stats-rank-num">${escapeHtml(String(num))}</span>
            <div class="stats-rank-main">
                <p class="stats-rank-name">${escapeHtml(name)}</p>
                ${sub ? `<p class="stats-rank-sub">${escapeHtml(sub)}</p>` : ''}
            </div>
            ${scoreStr != null ? `<span class="stats-rank-score">${escapeHtml(String(scoreStr))}</span>` : ''}
        </div>`;
    }

    let html = '';

    // ── 1. Sentiment distribution ──
    const totalReviews = (allReviews || []).length;
    if (totalReviews >= 1) {
        const loved = s.loveRate !== null
            ? Math.round((allReviews || []).filter(r => r.sentiment === 'loved').length / totalReviews * 100)
            : 0;
        const okay = Math.round((allReviews || []).filter(r => r.sentiment === 'okay').length / totalReviews * 100);
        const meh = Math.max(0, 100 - loved - okay);
        html += sHd('Review mix', `${totalReviews} review${totalReviews !== 1 ? 's' : ''}`);
        html += `<div class="sentiment-bar">
            <div class="sentiment-seg-meh" style="width:${meh}%"></div>
            <div class="sentiment-seg-okay" style="width:${okay}%"></div>
            <div class="sentiment-seg-loved" style="width:${loved}%"></div>
        </div>
        <div class="sentiment-legend">
            <span class="sentiment-legend-item"><span class="sentiment-dot" style="background:var(--border-color)"></span>Meh ${meh}%</span>
            <span class="sentiment-legend-item"><span class="sentiment-dot" style="background:#A8D5B8"></span>Okay ${okay}%</span>
            <span class="sentiment-legend-item"><span class="sentiment-dot" style="background:var(--sprout-forest)"></span>Loved ${loved}%</span>
        </div>`;
    }

    // ── 2. Score averages ──
    const avgs = computeScoreAverages();
    const maxCount = Math.max(avgs.food.count, avgs.vibe.count, avgs.value.count);
    if (maxCount >= 2) {
        const dims = [
            { label: 'Food', data: avgs.food },
            { label: 'Vibe', data: avgs.vibe },
            { label: 'Value', data: avgs.value },
        ].filter(d => d.data.avg !== null);
        if (dims.length > 0) {
            html += sHd('What you look for', `${maxCount} review${maxCount !== 1 ? 's' : ''}`);
            html += `<div class="score-avg-list">`;
            dims.forEach(d => {
                const pct = Math.round(d.data.avg / 10 * 100);
                html += `<div class="score-avg-row">
                    <span class="score-avg-lbl">${escapeHtml(d.label)}</span>
                    <div class="score-avg-bar-bg"><div class="score-avg-bar-fill" style="width:${pct}%"></div></div>
                    <span class="score-avg-val">${d.data.avg}</span>
                </div>`;
            });
            html += `</div>`;
            // Derived insight
            if (dims.length === 3) {
                const sorted = [...dims].sort((a, b) => b.data.avg - a.data.avg);
                const highest = sorted[0];
                const lowest = sorted[sorted.length - 1];
                const diff = Math.round((highest.data.avg - lowest.data.avg) * 10) / 10;
                if (diff >= 0.5) {
                    html += `<p class="score-avg-note">${escapeHtml(highest.label)} is your highest-rated dimension — ${diff.toFixed(1)} above ${escapeHtml(lowest.label.toLowerCase())}.</p>`;
                }
            }
        }
    } else if (totalReviews >= 1 && maxCount < 2) {
        html += sHd('What you look for');
        html += `<p class="stats-progress-note">Add scores to your next 2 reviews to unlock average ratings.</p>`;
    }

    // ── 3. Top restaurants ──
    const allRestaurants = computeTopRestaurants();
    if (allRestaurants.length >= 1) {
        const top3 = allRestaurants.slice(0, 3);
        html += sHd('Top restaurants', `${allRestaurants.length} visited`);
        html += `<div class="stats-rank-list">`;
        top3.forEach((x, i) => {
            const cuisine = x.place.place_types
                ? x.place.place_types.split(',').map(t => t.trim().replace(/_/g,' ')).find(t => !_STATS_GENERIC_TYPES.has(t.toLowerCase()))
                : null;
            html += rankRow(i + 1, x.place.name, cuisine || '', x.score, `openRestaurantCard(${x.place.id})`);
        });
        html += `</div>`;
        if (allRestaurants.length > 3) {
            html += `<button class="stats-see-all-btn" onclick="openRestaurantsDrilldown()">See all ${allRestaurants.length} →</button>`;
        }
    }

    // ── 4. Top cuisines ──
    const allCuisines = computeTopCuisines();
    const totalVisitedWithType = (places || []).filter(p => p.is_visited && p.place_types).length;
    if (allCuisines.length >= 1 && totalVisitedWithType >= 3) {
        const top3c = allCuisines.slice(0, 3);
        const uniqueCount = allCuisines.length;
        html += sHd('Cuisines explored', `${uniqueCount} type${uniqueCount !== 1 ? 's' : ''}`);
        html += `<div class="stats-rank-list">`;
        top3c.forEach((c, i) => {
            const sub = c.avgScore !== null
                ? `${c.count} visit${c.count !== 1 ? 's' : ''} · ${c.avgScore} avg`
                : `${c.count} visit${c.count !== 1 ? 's' : ''}`;
            html += rankRow(i + 1, c.label, sub, null, '');
        });
        html += `</div>`;
        if (allCuisines.length > 3) {
            html += `<button class="stats-see-all-btn" onclick="openCuisinesDrilldown()">See all ${allCuisines.length} →</button>`;
        }
    }

    // ── 5. Top dishes ──
    const allDishes = computeTopDishes();
    if (allDishes.length >= 1) {
        const top3d = allDishes.slice(0, 3);
        html += sHd('Top dishes', `${allDishes.length} rated`);
        html += `<div class="stats-rank-list">`;
        top3d.forEach((x, i) => {
            html += rankRow(i + 1, x.dish.name, `from ${x.place.name}`, `★ ${x.dish.rating}`, `openRestaurantCard(${x.place.id})`);
        });
        html += `</div>`;
        if (allDishes.length > 3) {
            html += `<button class="stats-see-all-btn" onclick="openDishesDrilldown()">See all ${allDishes.length} →</button>`;
        }
    }

    // ── 6. Discovery habits ──
    if (s.avgDays !== null || s.topDay) {
        html += sHd('Discovery habits');
        html += `<div class="stats-rank-list">`;
        if (s.avgDays !== null) {
            html += rankRow('⏱️', `${s.avgDays}d avg save → visit`, s.avgDaysPersona || '', null, '');
        }
        if (s.topDay) {
            html += rankRow(s.topDayEmoji, `You eat out most on ${s.topDay}s`, '', null, '');
        }
        html += `</div>`;
    }

    // ── 7. Social ──
    if (sharedCount > 0 || trendCount > 0) {
        html += sHd('Social');
        html += `<div class="stats-rank-list">`;
        if (trendCount > 0) html += rankRow('🌟', `${trendCount} place${trendCount !== 1 ? 's' : ''} you intro'd to friends`, '', null, '');
        if (sharedCount > 0) html += rankRow('👫', `${sharedCount} place${sharedCount !== 1 ? 's' : ''} shared with friends`, '', null, '');
        html += `</div>`;
    }

    // ── 8. Activity heatmap ──
    html += `<div class="stats-heatmap-section">
        <div class="stats-section-hd"><h4 class="stats-section-name">Activity</h4><span class="stats-section-meta">last 16 weeks</span></div>
        <div id="heatmap-grid" class="heatmap-grid"></div>
        <p id="heatmap-stat-line" class="heatmap-stat-line"></p>
    </div>`;

    el.innerHTML = html;

    // Call after innerHTML set so heatmap-grid exists in DOM
    renderActivityHeatmap();
}

// ── Stats sheet open/close (with accessibility) ──────────────────────────────
let _statsSheetTrigger = null;

function openStatsSheet() {
    const overlay = document.getElementById('stats-sheet-overlay');
    const sheet = document.getElementById('stats-sheet');
    if (!overlay || !sheet) return;
    _statsSheetTrigger = document.activeElement;
    const nameEl = document.getElementById('profile-display-name');
    const name = nameEl ? nameEl.textContent.trim() : '';
    const titleEl = document.getElementById('stats-sheet-title');
    if (titleEl) titleEl.textContent = name ? `${name}'s Food Story` : 'Your Food Story';
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
        sheet.classList.add('rc-open');
        sheet.querySelector('.rc-close-btn')?.focus();
    });
}

function closeStatsSheet() {
    const overlay = document.getElementById('stats-sheet-overlay');
    const sheet = document.getElementById('stats-sheet');
    if (!sheet || !overlay) return;
    sheet.classList.remove('rc-open');
    document.body.style.overflow = '';
    setTimeout(() => {
        overlay.style.display = 'none';
        _statsSheetTrigger?.focus();
        _statsSheetTrigger = null;
    }, 280);
}

// ── Drill-down sheet ─────────────────────────────────────────────────────────
function openStatsDrilldown(title, html) {
    const overlay = document.getElementById('stats-drilldown-overlay');
    const sheet = document.getElementById('stats-drilldown');
    if (!overlay || !sheet) return;
    document.getElementById('stats-drilldown-title').textContent = title;
    document.getElementById('stats-drilldown-body').innerHTML = html;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => sheet.classList.add('rc-open'));
}

function closeStatsDrilldown() {
    const overlay = document.getElementById('stats-drilldown-overlay');
    const sheet = document.getElementById('stats-drilldown');
    if (!sheet || !overlay) return;
    sheet.classList.remove('rc-open');
    setTimeout(() => { overlay.style.display = 'none'; }, 280);
}

function _buildRankListHtml(items) {
    if (!items.length) return '<p class="stats-progress-note">Not enough data yet.</p>';
    function rankRow(num, name, sub, scoreStr, tapFn) {
        const hasTap = !!tapFn;
        return `<div class="stats-rank-row${hasTap ? '' : ' stats-rank-row--no-tap'}"${hasTap ? ` onclick="${tapFn}"` : ''}>
            <span class="stats-rank-num">${escapeHtml(String(num))}</span>
            <div class="stats-rank-main">
                <p class="stats-rank-name">${escapeHtml(name)}</p>
                ${sub ? `<p class="stats-rank-sub">${escapeHtml(sub)}</p>` : ''}
            </div>
            ${scoreStr != null ? `<span class="stats-rank-score">${escapeHtml(String(scoreStr))}</span>` : ''}
        </div>`;
    }
    return `<div class="stats-rank-list" id="drilldown-rank-list">${items.map((x, i) => rankRow(i + 1, x.name, x.sub, x.score, x.tap)).join('')}</div>`;
}

function _restaurantTabItems(allRestaurants, tab) {
    let sorted;
    if (tab === 'food') sorted = [...allRestaurants].filter(x => x.food != null).sort((a, b) => b.food - a.food);
    else if (tab === 'vibe') sorted = [...allRestaurants].filter(x => x.vibe != null).sort((a, b) => b.vibe - a.vibe);
    else if (tab === 'value') sorted = [...allRestaurants].filter(x => x.value != null).sort((a, b) => b.value - a.value);
    else sorted = [...allRestaurants].sort((a, b) => b.score - a.score);

    return sorted.slice(0, 10).map(x => {
        const cuisine = x.place.place_types
            ? x.place.place_types.split(',').map(t => t.trim().replace(/_/g,' ')).find(t => !_STATS_GENERIC_TYPES.has(t.toLowerCase()))
            : null;
        const scoreVal = tab === 'food' ? x.food : tab === 'vibe' ? x.vibe : tab === 'value' ? x.value : x.score;
        return { name: x.place.name, sub: cuisine || '', score: scoreVal, tap: `openRestaurantCard(${x.place.id})` };
    });
}

function openRestaurantsDrilldown() {
    const all = computeTopRestaurants();
    if (!all.length) return;

    function buildTabsHtml(activeTab) {
        return ['all', 'food', 'vibe', 'value'].map(t =>
            `<button class="drilldown-tab${t === activeTab ? ' active' : ''}" onclick="switchRestaurantTab('${t}')">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`
        ).join('');
    }

    const initialItems = _restaurantTabItems(all, 'all');
    const html = `<div class="drilldown-tabs" id="restaurant-tabs">${buildTabsHtml('all')}</div>${_buildRankListHtml(initialItems)}`;
    openStatsDrilldown('Top Restaurants', html);
    // Store data for tab switching
    document.getElementById('stats-drilldown-body')._allRestaurants = all;
}

function switchRestaurantTab(tab) {
    const body = document.getElementById('stats-drilldown-body');
    const all = body._allRestaurants;
    if (!all) return;
    body.querySelectorAll('.drilldown-tab').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.toLowerCase() === tab);
    });
    const items = _restaurantTabItems(all, tab);
    const existing = body.querySelector('#drilldown-rank-list');
    if (existing) existing.outerHTML = _buildRankListHtml(items);
}

function openCuisinesDrilldown() {
    const all = computeTopCuisines();
    if (!all.length) return;

    function buildItems(tab) {
        let sorted = tab === 'rating'
            ? [...all].filter(c => c.avgScore !== null).sort((a, b) => b.avgScore - a.avgScore)
            : all;
        return sorted.slice(0, 10).map(c => ({
            name: c.label,
            sub: c.avgScore !== null
                ? `${c.count} visit${c.count !== 1 ? 's' : ''} · ${c.avgScore} avg`
                : `${c.count} visit${c.count !== 1 ? 's' : ''}`,
            score: tab === 'rating' ? c.avgScore : c.count,
            tap: '',
        }));
    }

    const tabsHtml = `<div class="drilldown-tabs">
        <button class="drilldown-tab active" onclick="switchCuisineTab(this,'visits')">By Visits</button>
        <button class="drilldown-tab" onclick="switchCuisineTab(this,'rating')">By Rating</button>
    </div>`;
    openStatsDrilldown('Cuisines Explored', tabsHtml + _buildRankListHtml(buildItems('visits')));
    document.getElementById('stats-drilldown-body')._allCuisines = all;
}

function switchCuisineTab(btn, tab) {
    const body = document.getElementById('stats-drilldown-body');
    const all = body._allCuisines;
    if (!all) return;
    body.querySelectorAll('.drilldown-tab').forEach(b => b.classList.toggle('active', b === btn));
    let sorted = tab === 'rating'
        ? [...all].filter(c => c.avgScore !== null).sort((a, b) => b.avgScore - a.avgScore)
        : all;
    const items = sorted.slice(0, 10).map(c => ({
        name: c.label,
        sub: c.avgScore !== null ? `${c.count} visit${c.count !== 1 ? 's' : ''} · ${c.avgScore} avg` : `${c.count} visit${c.count !== 1 ? 's' : ''}`,
        score: tab === 'rating' ? c.avgScore : c.count,
        tap: '',
    }));
    const existing = body.querySelector('#drilldown-rank-list');
    if (existing) existing.outerHTML = _buildRankListHtml(items);
}

function openDishesDrilldown() {
    const all = computeTopDishes();
    if (!all.length) return;
    const items = all.slice(0, 10).map(x => ({
        name: x.dish.name,
        sub: `from ${x.place.name}`,
        score: `★ ${x.dish.rating}`,
        tap: `openRestaurantCard(${x.place.id})`,
    }));
    openStatsDrilldown('Top Dishes', _buildRankListHtml(items));
}

// Escape key handler for stats modals
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const dl = document.getElementById('stats-drilldown-overlay');
    const sl = document.getElementById('stats-sheet-overlay');
    if (dl && dl.style.display !== 'none') closeStatsDrilldown();
    else if (sl && sl.style.display !== 'none') closeStatsSheet();
});

function renderActivityHeatmap() {
    const grid = document.getElementById('heatmap-grid');
    const statLine = document.getElementById('heatmap-stat-line');
    if (!grid) return;

    // Only count actual visits (not saves or reviews)
    const visitDates = (places || []).filter(p => p.visited_at).map(p => new Date(p.visited_at));

    if (visitDates.length === 0) {
        grid.innerHTML = '';
        if (statLine) statLine.textContent = '';
        return;
    }

    // 16 weekly buckets: w0 = 15 weeks ago, w15 = current week (Mon-anchored)
    const NUM_WEEKS = 16;
    const now = new Date();
    const dow = (now.getDay() + 6) % 7; // Mon=0
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dow);
    weekStart.setHours(0, 0, 0, 0);

    const buckets = new Array(NUM_WEEKS).fill(0);
    visitDates.forEach(d => {
        const weeksFromStart = Math.floor((d - weekStart) / (7 * 86400000));
        const idx = (NUM_WEEKS - 1) + weeksFromStart;
        if (idx >= 0 && idx < NUM_WEEKS) buckets[idx]++;
    });

    function intensityClass(n) {
        if (n === 0) return 'heat-0';
        if (n === 1) return 'heat-1';
        if (n <= 3) return 'heat-2';
        return 'heat-3';
    }

    // Group weeks into months for headers
    const groups = [];
    for (let i = 0; i < NUM_WEEKS; i++) {
        const weeksAgo = (NUM_WEEKS - 1) - i;
        const d = new Date(weekStart);
        d.setDate(weekStart.getDate() - weeksAgo * 7);
        const mo = d.toLocaleDateString('en-SG', { month: 'short' });
        const last = groups[groups.length - 1];
        if (!last || last.name !== mo) groups.push({ name: mo, cells: [] });
        groups[groups.length - 1].cells.push({ n: buckets[i] });
    }

    const groupsHtml = groups.map(g =>
        `<div class="heatmap-month-group">
            <span class="heatmap-month-lbl">${g.name}</span>
            <div class="heatmap-weeks-row">
                ${g.cells.map(c => `<div class="heatmap-cell ${intensityClass(c.n)}" title="${c.n} visit${c.n !== 1 ? 's' : ''}"></div>`).join('')}
            </div>
        </div>`
    ).join('');

    grid.innerHTML = `
        <div class="heatmap-groups">${groupsHtml}</div>
        <div class="heatmap-legend"><span>less</span><div class="heat-0 heatmap-legend-cell"></div><div class="heat-1 heatmap-legend-cell"></div><div class="heat-2 heatmap-legend-cell"></div><div class="heat-3 heatmap-legend-cell"></div><span>more</span></div>
    `;

    // Streak in weeks (consecutive non-zero from current)
    let streak = 0;
    for (let i = NUM_WEEKS - 1; i >= 0; i--) {
        if (buckets[i] > 0) streak++; else break;
    }
    const thisMonthVisits = visitDates.filter(d =>
        d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    ).length;

    if (statLine) {
        if (streak >= 2) {
            statLine.textContent = `${streak}-week streak 🔥`;
        } else if (thisMonthVisits > 0) {
            statLine.textContent = `${thisMonthVisits} visit${thisMonthVisits !== 1 ? 's' : ''} this month`;
        } else {
            statLine.textContent = '';
        }
    }
}

function renderMyVisits() {
    const section = document.getElementById('my-visits-section');
    if (!section) return;

    const visited = (places || [])
        .filter(p => p.is_visited)
        .sort((a, b) => {
            const ta = a.visited_at ? new Date(a.visited_at).getTime() : 0;
            const tb = b.visited_at ? new Date(b.visited_at).getTime() : 0;
            return tb - ta;
        });

    if (visited.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';

    // Both views pre-rendered; active view controlled by switchVisitsView()
    renderVisitPhotoGrid(visited);
    renderVisitCalendar(visited);

    const seeAll = document.getElementById('visits-see-all');
    if (seeAll) {
        seeAll.textContent = `See all ${visited.length} visits →`;
        seeAll.style.display = visited.length > 9 ? '' : 'none';
    }

    // Reset full list state
    const listEl = document.getElementById('my-visits-list');
    if (listEl) { listEl.style.display = 'none'; listEl.innerHTML = ''; }

    // Default to grid view
    switchVisitsView('grid');
}

function switchVisitsView(view) {
    const gridView = document.getElementById('visits-grid-view');
    const calView = document.getElementById('visits-calendar-view');
    const gridBtn = document.getElementById('visits-toggle-grid');
    const calBtn = document.getElementById('visits-toggle-cal');
    if (!gridView || !calView) return;

    const isGrid = view === 'grid';
    gridView.style.display = isGrid ? '' : 'none';
    calView.style.display = isGrid ? 'none' : '';
    if (gridBtn) gridBtn.classList.toggle('active', isGrid);
    if (calBtn) calBtn.classList.toggle('active', !isGrid);
}

// Calendar navigation state: offset in months from current (0 = this month, -1 = last month, etc.)
let _calMonthOffset = 0;
// Cached visited list for calendar re-renders
let _calVisited = null;

function renderVisitCalendar(visited) {
    _calVisited = visited;
    _calMonthOffset = 0;
    _renderCalendarForOffset(0);
}

function _renderCalendarForOffset(offset) {
    const calEl = document.getElementById('visit-calendar');
    if (!calEl || !_calVisited) return;

    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const year = target.getFullYear();
    const month = target.getMonth();
    const isCurrentMonth = offset === 0;

    // Build dayMap for this month
    const dayMap = {};
    _calVisited.forEach(p => {
        if (!p.visited_at) return;
        const d = new Date(p.visited_at);
        if (d.getFullYear() !== year || d.getMonth() !== month) return;
        const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!dayMap[key]) dayMap[key] = [];
        dayMap[key].push(p);
    });

    calEl.style.display = '';

    const firstDay = new Date(year, month, 1);
    const totalDays = new Date(year, month + 1, 0).getDate();
    const startOffset = (firstDay.getDay() + 6) % 7;
    const monthName = firstDay.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });

    // Determine oldest month with visits for prev-button disable
    const oldestVisit = _calVisited.reduce((min, p) => {
        if (!p.visited_at) return min;
        const t = new Date(p.visited_at).getTime();
        return t < min ? t : min;
    }, Infinity);
    const oldestDate = isFinite(oldestVisit) ? new Date(oldestVisit) : now;
    const minOffset = (oldestDate.getFullYear() - now.getFullYear()) * 12 + (oldestDate.getMonth() - now.getMonth());
    const canGoPrev = offset > minOffset;
    const canGoNext = offset < 0;

    let html = `
        <div class="cal-nav">
            <button class="cal-nav-btn" onclick="navigateCalendar(-1)" ${!canGoPrev ? 'disabled' : ''}>‹</button>
            <span class="cal-header">${monthName}</span>
            <button class="cal-nav-btn" onclick="navigateCalendar(1)" ${!canGoNext ? 'disabled' : ''}>›</button>
        </div>
        <div class="cal-grid">`;
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(d => { html += `<div class="cal-dow">${d}</div>`; });
    for (let i = 0; i < startOffset; i++) html += `<div class="cal-cell"></div>`;
    for (let day = 1; day <= totalDays; day++) {
        const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const hasVisit = !!dayMap[key];
        const isToday = isCurrentMonth && day === now.getDate();

        if (hasVisit) {
            // Try to get photo from the latest visit on this day
            const latestPlace = dayMap[key][0];
            const review = getPlaceReview(latestPlace.id);
            const photoUrl = review?.overall_photos?.[0]?.url;
            const todayClass = isToday ? ' cal-cell--today' : '';
            const onclick = `onclick="showCalDayPopover('${key}', this)"`;

            if (photoUrl) {
                const safe = safeUrl(photoUrl);
                html += `<div class="cal-cell cal-cell--visited cal-cell--photo${todayClass}" ${onclick} style="background-image:url(${safe})">
                    <span class="cal-day-num">${day}</span>
                </div>`;
            } else {
                html += `<div class="cal-cell cal-cell--visited${todayClass}" ${onclick}>${day}</div>`;
            }
        } else {
            const isToday2 = isToday ? ' cal-cell--today' : '';
            html += `<div class="cal-cell${isToday2}">${day}</div>`;
        }
    }
    html += '</div>';

    if (Object.keys(dayMap).length === 0) {
        html += `<p class="cal-empty-month">No visits this month</p>`;
    }

    calEl.innerHTML = html;
    calEl._dayMap = dayMap;
}

function navigateCalendar(dir) {
    _calMonthOffset += dir;
    _renderCalendarForOffset(_calMonthOffset);
}

function showCalDayPopover(dateKey, cellEl) {
    document.querySelector('.cal-popover')?.remove();

    const calEl = document.getElementById('visit-calendar');
    const dayPlaces = calEl?._dayMap?.[dateKey] || [];
    if (dayPlaces.length === 0) return;

    const d = new Date(dateKey);
    const label = d.toLocaleDateString('en-SG', { weekday: 'short', month: 'short', day: 'numeric' });

    const popover = document.createElement('div');
    popover.className = 'cal-popover';
    popover.innerHTML = `<div class="cal-popover-header">${label}</div>` +
        dayPlaces.map(p => `<div class="cal-popover-item" onclick="openRestaurantCard(${p.id})">${escapeHtml(p.name)}</div>`).join('');

    // Position below cell, flip above if near viewport bottom
    const rect = cellEl.getBoundingClientRect();
    const calRect = calEl.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 160) {
        popover.style.bottom = `${calRect.bottom - rect.top}px`;
    } else {
        popover.style.top = `${rect.bottom - calRect.top + 4}px`;
    }
    popover.style.left = `${Math.max(0, Math.min(rect.left - calRect.left, calRect.width - 164))}px`;

    calEl.appendChild(popover);

    setTimeout(() => {
        document.addEventListener('click', function dismiss(e) {
            if (!popover.contains(e.target)) {
                popover.remove();
                document.removeEventListener('click', dismiss);
            }
        });
    }, 50);
}

function renderVisitPhotoGrid(visited) {
    const gridEl = document.getElementById('visit-photo-grid');
    if (!gridEl) return;

    const CUISINE_EMOJI = {
        'restaurant': '🍽️', 'cafe': '☕', 'bar': '🍺', 'bakery': '🥐',
        'sushi restaurant': '🍣', 'pizza restaurant': '🍕', 'ramen restaurant': '🍜',
        'chinese restaurant': '🥢', 'japanese restaurant': '🍱', 'italian restaurant': '🍝',
        'korean restaurant': '🥘', 'dessert restaurant': '🍰', 'seafood restaurant': '🦞',
        'fast food restaurant': '🍔', 'thai restaurant': '🌶️', 'indian restaurant': '🍛',
        'mexican restaurant': '🌮',
    };

    function getTileEmoji(place) {
        if (!place.place_types) return '🍽️';
        const types = place.place_types.split(',').map(t => t.trim().replace(/_/g, ' ').toLowerCase());
        for (const t of types) { if (CUISINE_EMOJI[t]) return CUISINE_EMOJI[t]; }
        return '🍽️';
    }

    gridEl.innerHTML = visited.slice(0, 9).map(place => {
        const review = getPlaceReview(place.id);
        const photoUrl = review?.overall_photos?.[0]?.url;
        const safeName = escapeHtml(place.name);
        if (photoUrl) {
            return `<div class="vg-tile" onclick="openRestaurantCard(${place.id})">
                <img class="vg-tile-img" src="${safeUrl(photoUrl)}" alt="${safeName}" loading="lazy">
                <div class="vg-tile-overlay"><span class="vg-tile-name">${safeName}</span></div>
            </div>`;
        }
        return `<div class="vg-tile vg-tile--emoji" onclick="openRestaurantCard(${place.id})">
            <span class="vg-tile-emoji">${getTileEmoji(place)}</span>
            <div class="vg-tile-overlay"><span class="vg-tile-name">${safeName}</span></div>
        </div>`;
    }).join('');
}

function openVisitsFullList() {
    const listEl = document.getElementById('my-visits-list');
    const seeAll = document.getElementById('visits-see-all');
    if (!listEl) return;

    const isOpen = listEl.style.display !== 'none';
    if (isOpen) {
        listEl.style.display = 'none';
        const total = (places || []).filter(p => p.is_visited).length;
        if (seeAll) seeAll.textContent = `See all ${total} visits →`;
        return;
    }

    const visited = (places || [])
        .filter(p => p.is_visited)
        .sort((a, b) => {
            const ta = a.visited_at ? new Date(a.visited_at).getTime() : 0;
            const tb = b.visited_at ? new Date(b.visited_at).getTime() : 0;
            return tb - ta;
        });

    listEl.innerHTML = visited.map(place => {
        const review = getPlaceReview(place.id);
        const sentiment = review?.sentiment || null;
        const caption = review?.caption || review?.overall_remarks || '';
        const dateStr = place.visited_at ? formatShortDate(place.visited_at) : '';
        const sentimentEmoji = sentiment ? SENTIMENT_EMOJI[sentiment] : '';
        const captionDisplay = caption ? caption.slice(0, 60) + (caption.length > 60 ? '…' : '') : place.address || '';
        return `<div class="visit-item" onclick="openRestaurantCard(${place.id})">
            <div class="visit-item-main">
                <p class="visit-item-name">${escapeHtml(place.name)}</p>
                <p class="visit-item-caption">${escapeHtml(captionDisplay)}</p>
            </div>
            <div class="visit-item-right">
                ${sentimentEmoji ? `<span class="visit-item-sentiment">${sentimentEmoji}</span>` : ''}
                ${dateStr ? `<span class="visit-item-date">${dateStr}</span>` : ''}
            </div>
        </div>`;
    }).join('');

    listEl.style.display = '';
    if (seeAll) seeAll.textContent = 'Hide list ↑';
}

// ========== FRIENDS ==========

function _renderFriends(listEl, fullListEl, emptyEl, countEl, seeAllBtn, friends) {
    if (countEl) countEl.textContent = friends.length > 0 ? friends.length : '';

    // Clear previous avatar buttons and full list
    listEl.querySelectorAll('.friend-avatar-btn').forEach(el => el.remove());
    if (fullListEl) fullListEl.innerHTML = '';

    if (friends.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        if (seeAllBtn) seeAllBtn.style.display = 'none';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    if (seeAllBtn) seeAllBtn.style.display = friends.length > 5 ? '' : 'none';

    // "+ Add" circle first
    const addBtn = document.createElement('div');
    addBtn.className = 'friend-avatar-btn';
    addBtn.innerHTML = `<div class="friend-avatar-circle friend-add-circle" onclick="openAddFriendModal()">+</div><span class="friend-avatar-name">Add</span>`;
    listEl.insertBefore(addBtn, emptyEl);

    // Avatar circles (max 5 shown in row)
    friends.slice(0, 5).forEach(f => {
        const name = f.display_name || f.first_name || 'Friend';
        const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const avatarStyle = f.avatar_url
            ? `style="background-image:url('${escapeHtml(f.avatar_url)}');background-size:cover;background-position:center"`
            : '';
        const avatarContent = f.avatar_url ? '' : initials;
        const btn = document.createElement('div');
        btn.className = 'friend-avatar-btn';
        btn.style.cursor = 'pointer';
        btn.innerHTML = `<div class="friend-avatar-circle" ${avatarStyle}>${avatarContent}</div><span class="friend-avatar-name">${escapeHtml(name.split(' ')[0])}</span>`;
        btn.addEventListener('click', () => openUserProfile(f.user_id));
        listEl.appendChild(btn);
    });

    // Full vertical list (expanded via "See all")
    if (fullListEl) {
        friends.forEach(f => {
            const name = f.display_name || f.first_name || 'Friend';
            const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const avatarStyle = f.avatar_url
                ? `style="background-image:url('${escapeHtml(f.avatar_url)}');background-size:cover;background-position:center"`
                : '';
            const avatarContent = f.avatar_url ? '' : initials;
            const card = document.createElement('div');
            card.className = 'friend-card';
            card.style.cursor = 'pointer';
            card.innerHTML = `
                <div class="friend-avatar-circle" ${avatarStyle}>${avatarContent}</div>
                <div class="friend-card-info">
                    <p class="friend-card-name">${escapeHtml(name)}</p>
                    ${f.username ? `<p class="friend-card-username">@${escapeHtml(f.username)}</p>` : ''}
                </div>
                <button class="btn-icon-sm btn-danger-sm" onclick="event.stopPropagation();removeFriend(${f.friendship_id})" aria-label="Remove friend">✕</button>`;
            card.addEventListener('click', () => openUserProfile(f.user_id));
            fullListEl.appendChild(card);
        });
    }
}

async function loadFriends() {
    const listEl = document.getElementById('friends-list');
    const fullListEl = document.getElementById('friends-full-list');
    const emptyEl = document.getElementById('friends-empty');
    const countEl = document.getElementById('friends-count');
    const seeAllBtn = document.getElementById('friends-see-all');
    if (!listEl) return;

    const now = Date.now();
    if (_friendsCache && (now - _friendsCache.ts) < FRIENDS_CACHE_TTL_MS) {
        _renderFriends(listEl, fullListEl, emptyEl, countEl, seeAllBtn, _friendsCache.data);
        return;
    }

    try {
        const res = await fetch('/api/friends', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const friends = data.friends || [];
        _friendsCache = { data: friends, ts: Date.now() };
        _renderFriends(listEl, fullListEl, emptyEl, countEl, seeAllBtn, friends);
    } catch (err) {
        console.error('loadFriends error:', err);
    }
}

function openFriendsFullList() {
    const fullListEl = document.getElementById('friends-full-list');
    const seeAll = document.getElementById('friends-see-all');
    if (!fullListEl) return;
    const isOpen = fullListEl.style.display !== 'none';
    fullListEl.style.display = isOpen ? 'none' : '';
    if (seeAll) seeAll.textContent = isOpen ? 'See all' : 'Hide';
}

async function loadFriendRequests() {
    try {
        const res = await fetch('/api/friends/requests', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const requests = data.requests || [];

        // Update badge on profile nav tab
        const badge = document.getElementById('nav-profile-badge');
        if (badge) {
            if (requests.length > 0) {
                badge.textContent = requests.length;
                badge.style.display = '';
            } else {
                badge.style.display = 'none';
            }
        }

        // Update banner in profile view — subtle count sentence
        const banner = document.getElementById('friend-requests-banner');
        if (banner) {
            if (requests.length > 0) {
                const n = requests.length;
                const label = n === 1 ? '1 new friend request' : `${n} new friend requests`;
                banner.innerHTML = `👤 ${label} — <span class="fr-banner-link" onclick="showFriendRequests()">View</span>`;
                banner.style.display = '';
            } else {
                banner.style.display = 'none';
            }
        }
    } catch (err) {
        console.error('loadFriendRequests error:', err);
    }
}

async function removeFriend(friendshipId) {
    if (!confirm('Remove this friend?')) return;
    try {
        await fetch(`/api/friends/${friendshipId}`, { method: 'DELETE', headers: getAuthHeaders() });
        _friendsCache = null;
        await loadFriends();
    } catch (err) {
        console.error('removeFriend error:', err);
    }
}

// ========== ADD FRIEND MODAL ==========

let friendSearchTimeout = null;

function renderFriendCard(u, showMutual = false) {
    const name = u.display_name || u.first_name || 'User';
    const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const avatarHtml = u.avatar_url
        ? `<div class="fr-avatar" style="background-image:url('${escapeHtml(u.avatar_url)}');background-size:cover;background-position:center"></div>`
        : `<div class="fr-avatar fr-avatar--initials">${initials}</div>`;
    const isFriend   = u.friendship_status === 'accepted';
    const isPending  = u.friendship_status === 'pending';
    const isIncoming = u.friendship_status === 'incoming_request';
    const btnLabel   = isFriend ? 'Friends' : isPending ? 'Requested' : isIncoming ? 'Accept' : '+ Add';
    const btnDisabled = (isFriend || isPending) ? 'disabled' : '';
    const btnOnclick = isIncoming
        ? `event.stopPropagation();acceptFriendRequest('${u.friendship_id}')`
        : `event.stopPropagation();sendFriendRequest(${u.id}, this)`;
    const subLine = showMutual && u.mutual_friends_count
        ? `<p class="friend-username">${u.mutual_friends_count} mutual friend${u.mutual_friends_count > 1 ? 's' : ''}</p>`
        : (u.username ? `<p class="friend-username">@${escapeHtml(u.username)}</p>` : '');
    return `
    <div class="friend-result-card" onclick="openUserProfile(${u.id})">
        ${avatarHtml}
        <div class="friend-info">
            <p class="friend-name">${escapeHtml(name)}</p>
            ${subLine}
        </div>
        <button class="btn-secondary-sm${isFriend ? ' btn-friends' : ''}" onclick="${btnOnclick}" ${btnDisabled}>
            ${btnLabel}
        </button>
    </div>`;
}

async function loadSuggestedFriends() {
    const section = document.getElementById('friend-suggestions-section');
    const container = document.getElementById('friend-suggestions');
    const emptyEl = document.getElementById('friend-suggestions-empty');
    if (!container) return;
    try {
        const res = await fetch('/api/users/suggestions', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const users = data.suggestions || [];
        if (users.length === 0) {
            container.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        container.innerHTML = users.map(u => renderFriendCard(u, true)).join('');
    } catch {
        if (section) section.style.display = 'none';
    }
}

function openAddFriendModal() {
    const modal = document.getElementById('add-friend-modal');
    if (modal) modal.style.display = 'flex';
    document.getElementById('friend-search-input')?.focus();
    loadPendingRequestsSection();
    loadSuggestedFriends();
}

function closeAddFriendModal() {
    const modal = document.getElementById('add-friend-modal');
    if (modal) modal.style.display = 'none';
    const input = document.getElementById('friend-search-input');
    if (input) input.value = '';
    const results = document.getElementById('friend-search-results');
    if (results) results.innerHTML = '';
    const emptyMsg = document.getElementById('friend-search-empty');
    if (emptyMsg) emptyMsg.style.display = 'none';
    const suggestions = document.getElementById('friend-suggestions');
    if (suggestions) suggestions.innerHTML = '';
    const section = document.getElementById('friend-suggestions-section');
    if (section) section.style.display = '';
    const pendingSection = document.getElementById('pending-requests-section');
    if (pendingSection) pendingSection.style.display = 'none';
}

function searchFriends(query) {
    clearTimeout(friendSearchTimeout);
    const section = document.getElementById('friend-suggestions-section');
    if (!query || query.trim().length < 2) {
        document.getElementById('friend-search-results').innerHTML = '';
        document.getElementById('friend-search-empty').style.display = 'none';
        if (section) section.style.display = '';
        return;
    }
    if (section) section.style.display = 'none';
    friendSearchTimeout = setTimeout(() => doSearchFriends(query.trim()), 400);
}

async function doSearchFriends(query) {
    const resultsEl = document.getElementById('friend-search-results');
    const emptyEl = document.getElementById('friend-search-empty');
    if (!resultsEl) return;

    try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`, { headers: getAuthHeaders() });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const users = data.users || [];

        if (users.length === 0) {
            resultsEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        resultsEl.innerHTML = users.map(u => renderFriendCard(u)).join('');
    } catch (err) {
        console.error('searchFriends error:', err);
    }
}

async function sendFriendRequest(userId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Sent'; }
    try {
        await fetch('/api/friends/request', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_user_id: userId })
        });
    } catch (err) {
        console.error('sendFriendRequest error:', err);
        if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
    }
}

// ========== UNIFIED PEOPLE MODAL ==========

function showFriendRequests() {
    openAddFriendModal();
}

function closeFriendRequestsModal() {
    closeAddFriendModal();
}

async function loadPendingRequestsSection() {
    const section = document.getElementById('pending-requests-section');
    const listEl = document.getElementById('pending-requests-list');
    if (!section || !listEl) return;

    try {
        const res = await fetch('/api/friends/requests', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const requests = data.requests || [];

        if (requests.length === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = '';
        listEl.innerHTML = requests.map(r => {
            const name = escapeHtml(r.display_name || r.first_name || 'User');
            const initials = (r.display_name || r.first_name || 'U').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const avatarHtml = r.avatar_url
                ? `<div class="fr-avatar" style="background-image:url('${escapeHtml(r.avatar_url)}');background-size:cover;background-position:center"></div>`
                : `<div class="fr-avatar fr-avatar--initials">${initials}</div>`;
            const subLine = r.mutual_friends_count
                ? `<p class="friend-username">${r.mutual_friends_count} mutual friend${r.mutual_friends_count > 1 ? 's' : ''}</p>`
                : (r.username ? `<p class="friend-username">@${escapeHtml(r.username)}</p>` : '');
            return `
            <div class="friend-request-card" id="req-${r.friendship_id}">
                <div class="fr-card-left" onclick="closeAddFriendModal();openUserProfile(${r.user_id})">
                    ${avatarHtml}
                    <div class="friend-info">
                        <p class="friend-name">${name}</p>
                        ${subLine}
                    </div>
                </div>
                <div class="request-actions">
                    <button class="btn-primary-sm" onclick="event.stopPropagation();acceptFriendRequest('${r.friendship_id}')">Accept</button>
                    <button class="btn-secondary-sm" onclick="event.stopPropagation();declineFriendRequest('${r.friendship_id}')">Decline</button>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        console.error('loadPendingRequestsSection error:', err);
    }
}

async function acceptFriendRequest(friendshipId) {
    try {
        await fetch(`/api/friends/${friendshipId}/accept`, { method: 'POST', headers: getAuthHeaders() });
        const card = document.getElementById(`req-${friendshipId}`);
        if (card) {
            const actions = card.querySelector('.request-actions');
            if (actions) actions.innerHTML = `<span class="fr-accepted-badge">✓ Friends</span>`;
            setTimeout(() => card.remove(), 1200);
        }
        _friendsCache = null;
        await loadFriends();
        await loadFriendRequests();
        // After card removal: hide section if empty, refresh suggestions with new mutual friends
        setTimeout(() => {
            const list = document.getElementById('pending-requests-list');
            const section = document.getElementById('pending-requests-section');
            if (list && section && !list.querySelector('.friend-request-card')) {
                section.style.display = 'none';
            }
            loadSuggestedFriends();
        }, 1300);
    } catch (err) {
        console.error('acceptFriendRequest error:', err);
    }
}

async function declineFriendRequest(friendshipId) {
    try {
        await fetch(`/api/friends/${friendshipId}`, { method: 'DELETE', headers: getAuthHeaders() });
        const card = document.getElementById(`req-${friendshipId}`);
        if (card) card.remove();
        const list = document.getElementById('pending-requests-list');
        const section = document.getElementById('pending-requests-section');
        if (list && section && !list.querySelector('.friend-request-card')) {
            section.style.display = 'none';
        }
        await loadFriendRequests();
    } catch (err) {
        console.error('declineFriendRequest error:', err);
    }
}

// ========== EDIT PROFILE ==========

// ========== AVATAR CHANGE ==========

function openAvatarSheet() {
    const sheet = document.getElementById('avatar-sheet');
    if (!sheet) return;
    // Show Telegram photo option only if a Telegram photo exists and differs from current avatar
    const tgPhoto = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url;
    const tgBtn = document.getElementById('avatar-telegram-btn');
    if (tgBtn) tgBtn.style.display = tgPhoto ? '' : 'none';
    sheet.style.display = 'flex';
}

function closeAvatarSheet(e) {
    if (e && e.target !== document.getElementById('avatar-sheet')) return;
    const sheet = document.getElementById('avatar-sheet');
    if (sheet) sheet.style.display = 'none';
}

async function onAvatarFileChosen(input) {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    closeAvatarSheet();
    openAvatarCropEditor(file);
}

async function uploadAvatarFile(file) {
    const avatarEl = document.getElementById('profile-avatar-circle');
    if (avatarEl) avatarEl.style.opacity = '0.5';
    const form = new FormData();
    form.append('file', file);
    try {
        const res = await fetch('/api/me/avatar', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: form,
        });
        if (!res.ok) throw new Error('Upload failed');
        const raw = await res.json();
        profileData = raw.profile || raw;
        _profileCache = null;  // invalidate — avatar changed
        renderProfile(profileData);
    } catch (err) {
        console.error('Avatar upload error:', err);
        alert('Could not upload photo. Please try again.');
    } finally {
        if (avatarEl) avatarEl.style.opacity = '';
    }
}

// ── Avatar crop editor state ──
let _cropImg = null;
let _cropScale = 1;
let _cropMinScale = 1;
let _cropOffsetX = 0;
let _cropOffsetY = 0;
let _cropIsDragging = false;
let _cropLastX = 0;
let _cropLastY = 0;
let _cropLastPinchDist = 0;
let _cropObjectUrl = null;

function openAvatarCropEditor(file) {
    _cropOffsetX = 0; _cropOffsetY = 0; _cropScale = 1;

    const overlay = document.getElementById('avatar-crop-overlay');
    overlay.style.display = 'flex';

    const canvas = document.getElementById('avatar-crop-canvas');
    const headerH = 52;
    const size = Math.min(window.innerWidth, window.innerHeight - headerH);
    canvas.width = size;
    canvas.height = size;

    if (_cropObjectUrl) URL.revokeObjectURL(_cropObjectUrl);
    _cropObjectUrl = URL.createObjectURL(file);

    const img = new Image();
    img.onload = () => {
        _cropImg = img;
        const r = size * 0.42;
        const minDim = Math.min(img.naturalWidth, img.naturalHeight);
        _cropScale = (r * 2) / minDim;
        _cropMinScale = _cropScale;
        setupCropEvents();
        renderCropCanvas();
    };
    img.src = _cropObjectUrl;
}

function renderCropCanvas() {
    const canvas = document.getElementById('avatar-crop-canvas');
    if (!canvas || !_cropImg) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.42;

    const imgW = _cropImg.naturalWidth * _cropScale;
    const imgH = _cropImg.naturalHeight * _cropScale;
    const drawX = cx + _cropOffsetX - imgW / 2;
    const drawY = cy + _cropOffsetY - imgH / 2;

    ctx.clearRect(0, 0, W, H);

    // 1. Full image
    ctx.drawImage(_cropImg, drawX, drawY, imgW, imgH);

    // 2. Dark overlay outside circle
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // 3. Redraw image inside circle (sharp, above overlay)
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(_cropImg, drawX, drawY, imgW, imgH);
    ctx.restore();

    // 4. White circle border
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
}

function setupCropEvents() {
    // Clone to clear any previous listeners
    const old = document.getElementById('avatar-crop-canvas');
    const fresh = old.cloneNode(true);
    old.parentNode.replaceChild(fresh, old);
    const c = document.getElementById('avatar-crop-canvas');

    // Mouse
    c.addEventListener('mousedown', e => {
        _cropIsDragging = true; _cropLastX = e.clientX; _cropLastY = e.clientY;
    });
    window.addEventListener('mousemove', e => {
        if (!_cropIsDragging) return;
        _cropOffsetX += e.clientX - _cropLastX;
        _cropOffsetY += e.clientY - _cropLastY;
        _cropLastX = e.clientX; _cropLastY = e.clientY;
        renderCropCanvas();
    });
    window.addEventListener('mouseup', () => { _cropIsDragging = false; });
    c.addEventListener('wheel', e => {
        e.preventDefault();
        _cropScale *= e.deltaY < 0 ? 1.05 : 0.95;
        _cropScale = Math.max(0.3, Math.min(8, _cropScale));
        renderCropCanvas();
    }, { passive: false });

    // Touch
    c.addEventListener('touchstart', e => {
        e.preventDefault();
        if (e.touches.length === 1) {
            _cropIsDragging = true;
            _cropLastX = e.touches[0].clientX; _cropLastY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            _cropIsDragging = false;
            _cropLastPinchDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
        }
    }, { passive: false });
    c.addEventListener('touchmove', e => {
        e.preventDefault();
        if (e.touches.length === 1 && _cropIsDragging) {
            _cropOffsetX += e.touches[0].clientX - _cropLastX;
            _cropOffsetY += e.touches[0].clientY - _cropLastY;
            _cropLastX = e.touches[0].clientX; _cropLastY = e.touches[0].clientY;
            renderCropCanvas();
        } else if (e.touches.length === 2) {
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            _cropScale *= dist / _cropLastPinchDist;
            _cropScale = Math.max(_cropMinScale, Math.min(8, _cropScale));
            _cropLastPinchDist = dist;
            renderCropCanvas();
        }
    }, { passive: false });
    c.addEventListener('touchend', () => { _cropIsDragging = false; });
}

function cancelAvatarCrop() {
    document.getElementById('avatar-crop-overlay').style.display = 'none';
    if (_cropObjectUrl) { URL.revokeObjectURL(_cropObjectUrl); _cropObjectUrl = null; }
    _cropImg = null;
}

function confirmAvatarCrop() {
    const canvas = document.getElementById('avatar-crop-canvas');
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.42;

    const outputSize = 400;
    const offscreen = document.createElement('canvas');
    offscreen.width = outputSize; offscreen.height = outputSize;
    const ctx = offscreen.getContext('2d');

    ctx.beginPath();
    ctx.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2);
    ctx.clip();

    const imgW = _cropImg.naturalWidth * _cropScale;
    const imgH = _cropImg.naturalHeight * _cropScale;
    const drawX = cx + _cropOffsetX - imgW / 2;
    const drawY = cy + _cropOffsetY - imgH / 2;
    const scale = outputSize / (r * 2);

    ctx.drawImage(
        _cropImg,
        (drawX - (cx - r)) * scale,
        (drawY - (cy - r)) * scale,
        imgW * scale,
        imgH * scale
    );

    offscreen.toBlob(blob => {
        cancelAvatarCrop();
        uploadAvatarFile(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
}

async function useAvatarTelegramPhoto() {
    closeAvatarSheet();
    const tgPhoto = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url;
    if (!tgPhoto) return;
    try {
        const res = await fetch('/api/me', {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: tgPhoto }),
        });
        if (!res.ok) throw new Error();
        const raw = await res.json();
        profileData = raw.profile || raw;
        renderProfile(profileData);
    } catch (err) {
        console.error('Telegram photo sync error:', err);
    }
}

async function removeAvatar() {
    closeAvatarSheet();
    try {
        const res = await fetch('/api/me', {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ clear_avatar: true }),
        });
        if (!res.ok) throw new Error();
        const raw = await res.json();
        profileData = raw.profile || raw;
        renderProfile(profileData);
    } catch (err) {
        console.error('Remove avatar error:', err);
    }
}

// ========== EDIT PROFILE ==========

function openEditProfile() {
    const modal = document.getElementById('edit-profile-modal');
    if (!modal) return;
    if (profileData) {
        const nameEl = document.getElementById('edit-display-name');
        const bioEl = document.getElementById('edit-bio');
        const notifyEl = document.getElementById('edit-notify-activity');
        if (nameEl) nameEl.value = profileData.display_name || '';
        if (bioEl) bioEl.value = profileData.bio || '';
        if (notifyEl) notifyEl.checked = profileData.notify_friend_activity !== false;
    }
    modal.style.display = 'flex';
}

function closeEditProfile() {
    const modal = document.getElementById('edit-profile-modal');
    if (modal) modal.style.display = 'none';
}

async function saveProfile() {
    const displayName = document.getElementById('edit-display-name')?.value.trim();
    const bio = document.getElementById('edit-bio')?.value.trim();
    const notifyActivity = document.getElementById('edit-notify-activity')?.checked ?? true;
    try {
        const res = await fetch('/api/me', {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ display_name: displayName, bio, is_public: true, notify_friend_activity: notifyActivity })
        });
        if (!res.ok) throw new Error('Failed to save');
        const raw = await res.json();
        profileData = raw.profile || raw;
        _profileCache = null;  // invalidate — profile changed
        renderProfile(profileData);
        closeEditProfile();
    } catch (err) {
        console.error('saveProfile error:', err);
        alert('Could not save profile. Please try again.');
    }
}

// ========== INVITE LINK ==========

async function shareInviteLink() {
    try {
        const res = await fetch('/api/invite-link', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const link = data.invite_link || data.link || 'https://t.me/sprout_eats_bot';

        const myName = document.getElementById('profile-display-name')?.textContent?.trim() || 'A friend';
        // Link embedded in text so WhatsApp/iMessage render it as a tappable link
        const shareText = `${myName} invited you to join Sprout 🌱\n\nDiscover & share your favourite restaurants with friends. Tap to join:\n${link}`;

        trackEvent('invite_sent', {
            entityType: 'invite',
            metadata: { method: navigator.share ? 'native' : 'copy' },
        });

        if (navigator.share) {
            // Opens native iOS/Android share sheet — WhatsApp, Telegram, Messages, etc.
            await navigator.share({ title: '🌱 Join me on Sprout!', text: shareText });
        } else {
            // Desktop fallback: copy text + link to clipboard
            await navigator.clipboard?.writeText(shareText);
            showToast('📋 Invite message copied!');
        }
    } catch (err) {
        // AbortError = user dismissed the share sheet — not a real error
        if (err?.name !== 'AbortError') console.error('shareInviteLink error:', err);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// RESTAURANT CARD
// ═══════════════════════════════════════════════════════════════════════

let rcCurrentPlaceId  = null;
let rcCurrentGoogleId = null;
let feedActivitiesMap = {};
let _guestPlaceData   = null;
let rcLoadedReviews   = [];   // NormalizedReview[] for all review rows in current RC
let rcActiveReviewIdx = -1;   // index into rcLoadedReviews of currently active row
let _rcAfterReview    = null; // placeId to reopen RC after review sheet closes

// ── Guest mode: undiscovered place (not in user's own list) ──────────────────
function openRestaurantCardGuest(placeData, { highlightUserId = null, activity = null } = {}) {
    _guestPlaceData   = placeData;
    rcCurrentPlaceId  = null;
    rcCurrentGoogleId = placeData.google_place_id || null;
    rcLoadedReviews   = [];
    rcActiveReviewIdx = -1;
    trackEvent('place_card_opened', {
        entityType: 'restaurant', entityId: placeData.google_place_id || undefined,
        metadata: { google_place_id: placeData.google_place_id, surface: activity ? 'discover' : 'search' },
    });

    // Push featured activity review first (idx 0) if available
    if (activity && activity.review) {
        rcLoadedReviews.push(normalizeActivityReview(activity));
    }

    const overlay = document.getElementById('restaurant-card-overlay');
    const sheet   = document.getElementById('restaurant-card');
    overlay.style.display = 'flex';
    requestAnimationFrame(() => sheet.classList.add('rc-open'));

    // Reset people list + chips
    const peopleList = document.getElementById('rc-people-list');
    if (peopleList) peopleList.innerHTML = '';
    const avgChipEl = document.getElementById('rc-friends-avg');
    if (avgChipEl) avgChipEl.style.display = 'none';

    // Basic info
    document.getElementById('rc-name').textContent    = placeData.name    || '';
    document.getElementById('rc-address').textContent = placeData.address || '';

    // Meta chips
    let meta = '';
    if (placeData.place_rating) {
        const cnt = placeData.place_rating_count ? ` (${Number(placeData.place_rating_count).toLocaleString()})` : '';
        meta += `<span class="rc-meta-chip">⭐ ${placeData.place_rating}${cnt}</span>`;
    } else {
        meta += `<span class="rc-meta-chip rc-meta-na">Rating N/A</span>`;
    }
    if (placeData.place_price_level && PLACE_PRICE_LABELS[placeData.place_price_level])
        meta += `<span class="rc-meta-chip">${PLACE_PRICE_LABELS[placeData.place_price_level]}</span>`;
    const types = formatPlaceTypes(placeData.place_types);
    if (types) {
        meta += `<span class="rc-meta-chip rc-type-chip">${types}</span>`;
    } else {
        meta += `<span class="rc-meta-chip rc-meta-na">Type N/A</span>`;
    }
    document.getElementById('rc-meta').innerHTML = meta;

    const hoursEl = document.getElementById('rc-hours');
    hoursEl.innerHTML = '<span class="rc-na-text">🕐 Hours not available</span>';
    hoursEl.style.display = '';
    const descEl = document.getElementById('rc-description');
    descEl.innerHTML = '<span class="rc-na-text">No description available</span>';
    descEl.style.display = '';
    document.getElementById('rc-notes').style.display = 'none';

    // Hero carousel: will be set by selectRcReview; clear it for now
    const heroEl = document.getElementById('rc-hero-strip');
    renderRcHeroCarousel(heroEl, []);

    // Action buttons: Maps always present, Reel if source_url available
    const actionsEl = document.getElementById('rc-actions');
    const actionBtns = [];
    if (placeData.google_place_id) {
        actionBtns.push(`<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(placeData.name)}&query_place_id=${placeData.google_place_id}" target="_blank" class="rc-action-btn">📍 Maps</a>`);
    } else {
        const q = encodeURIComponent((placeData.name || '') + ' ' + (placeData.address || ''));
        actionBtns.push(`<a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" class="rc-action-btn">📍 Maps</a>`);
    }
    if (placeData.source_url) {
        actionBtns.push(`<a href="${safeUrl(placeData.source_url)}" target="_blank" class="rc-action-btn">▶️ Reel</a>`);
    }

    // Determine own save/review state before building action buttons
    const alreadySaved = placeData.google_place_id
        ? places.find(p => p.google_place_id === placeData.google_place_id) : null;
    const ownReview = alreadySaved ? getPlaceReview(alreadySaved.id) : null;

    // If place is in user's list, expose its id so the 3-dot menu (rename/delete) works
    if (alreadySaved) rcCurrentPlaceId = alreadySaved.id;

    // Show/hide 3-dot menu based on whether place is saved
    const moreBtn = document.getElementById('rc-more-btn') || document.querySelector('.rc-more-btn');
    if (moreBtn) moreBtn.style.display = alreadySaved ? '' : 'none';

    if (alreadySaved && !ownReview) {
        actionBtns.push(`<button class="rc-action-btn rc-action-btn--cta" style="margin-left:auto" onclick="openReviewFromRc(${alreadySaved.id})">✏️ Add review</button>`);
    } else if (!alreadySaved) {
        actionBtns.push(`<button class="rc-action-btn rc-action-btn--cta" style="margin-left:auto" onclick="guestRcSave(this)">＋ Save place</button>`);
    }

    actionsEl.innerHTML = actionBtns.join('');
    actionsEl.style.display = '';

    // Hide edit icon (guest mode)
    const editIconBtn = document.getElementById('rc-edit-icon-btn');
    if (editIconBtn) editIconBtn.style.display = 'none';

    // Featured review section: hidden initially, shown by selectRcReview
    const featSec = document.getElementById('rc-featured-section');
    const featDiv = document.getElementById('rc-featured-divider');
    if (featSec) featSec.style.display = 'none';
    if (featDiv) featDiv.style.display = 'none';

    // People section: always visible
    const peopleSection = document.getElementById('rc-people-section');
    if (peopleSection) peopleSection.style.display = '';

    // Own pill — only if has a review
    if (alreadySaved && ownReview) {
        const ownIdx = rcLoadedReviews.length;
        rcLoadedReviews.push(normalizeOwnReview(alreadySaved, ownReview));
        if (peopleList) peopleList.innerHTML += renderPersonPill({
            name: 'You', userId: null, isOwn: true,
            idx: ownIdx, score: computePlaceScore(ownReview), photoUrl: null,
        });
    }

    // Activate idx 0 synchronously (sets hero + featured section)
    if (rcLoadedReviews.length > 0) selectRcReview(0);

    // Load friend reviews asynchronously
    if (placeData.google_place_id) {
        loadRcFriendReviews(placeData.google_place_id, highlightUserId, {
            suppressYourReview: !!ownReview,
            initialHighlightIdx: rcLoadedReviews.length > 0 ? 0 : null,
        });
    }
}

async function guestRcSave(btn) {
    if (!_guestPlaceData) return;
    btn.disabled    = true;
    btn.textContent = 'Saving…';
    try {
        const d = _guestPlaceData;
        const res = await fetch(`${API_URL}/api/places`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name:               d.name    || '',
                address:            d.address || '',
                latitude:           d.latitude  || d.lat  || 0,
                longitude:          d.longitude || d.lng  || 0,
                google_place_id:    d.google_place_id    || null,
                source_url:         d.source_url         || null,
                place_types:        d.place_types        || null,
                place_rating:       d.place_rating       || null,
                place_rating_count: d.place_rating_count || null,
                place_price_level:  d.place_price_level  || null,
                country_code:       d.country_code       || null,
                city:               d.city               || null,
                neighborhood:       d.neighborhood       || null,
                primary_cuisine:    d.primary_cuisine    || null,
            }),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        if (data.place) {
            places.push(data.place);
            applyFilters();
            displayPlacesOnMap(false);
            showToast('Saved to your list!');
            closeRestaurantCard();
            openRestaurantCard(data.place.id);
            fetchPlaces(); // background refresh so saved tab is fully in sync
        }
    } catch (e) {
        console.error('guestRcSave error:', e);
        btn.disabled    = false;
        btn.textContent = '＋ Save place';
    }
}

async function openRestaurantCard(placeId, { highlightUserId = null, featuredActivity = null } = {}) {
    rcCurrentPlaceId  = placeId;
    _guestPlaceData   = null;
    rcLoadedReviews   = [];
    rcActiveReviewIdx = -1;
    const analyticsPlace = places.find(p => p.id === placeId);
    trackEvent('place_card_opened', {
        entityType: 'place', entityId: placeId,
        metadata: { google_place_id: analyticsPlace?.google_place_id, surface: featuredActivity ? 'discover' : 'saved' },
    });

    const overlay = document.getElementById('restaurant-card-overlay');
    const sheet   = document.getElementById('restaurant-card');
    overlay.style.display = 'flex';
    sheet.classList.add('rc-open');

    // Always show 3-dot menu for own RC
    const moreBtn = document.getElementById('rc-more-btn') || document.querySelector('.rc-more-btn');
    if (moreBtn) moreBtn.style.display = '';

    // Featured review section: hidden initially, shown by selectRcReview
    const featSec = document.getElementById('rc-featured-section');
    const featDiv = document.getElementById('rc-featured-divider');
    if (featSec) featSec.style.display = 'none';
    if (featDiv) featDiv.style.display = 'none';

    // Reset people list + chips
    const peopleListOwn = document.getElementById('rc-people-list');
    if (peopleListOwn) peopleListOwn.innerHTML = '';
    const avgChipEl = document.getElementById('rc-friends-avg');
    if (avgChipEl) avgChipEl.style.display = 'none';

    // Render immediately from local state — no network round-trip needed
    const place = places.find(p => p.id === placeId);
    const review = getPlaceReview(placeId);

    function _injectOwnPill(p, r) {
        if (r) {
            rcLoadedReviews.push(normalizeOwnReview(p, r));
            if (peopleListOwn) peopleListOwn.innerHTML += renderPersonPill({
                name: 'You', userId: null, isOwn: true,
                idx: rcLoadedReviews.length - 1, score: computePlaceScore(r), photoUrl: null,
            });
            selectRcReview(rcLoadedReviews.length - 1);
        }
        // No review: "Add review" CTA lives in the actions row (added by renderRestaurantCard)
    }

    if (place) {
        try {
            renderRestaurantCard(place, review);
        } catch (e) {
            console.error('renderRestaurantCard error:', e);
        }
        _injectOwnPill(place, review);
        rcCurrentGoogleId = place.google_place_id || null;
        if (place.google_place_id) {
            loadRcFriendReviews(place.google_place_id, highlightUserId, { initialHighlightIdx: null });
        }
    } else {
        // Fallback: place not in local cache, fetch it
        document.getElementById('rc-name').textContent = '…';
        try {
            const [placeRes, reviewRes] = await Promise.all([
                fetch(`${API_URL}/api/places/${placeId}`, { headers: getAuthHeaders() }),
                fetch(`${API_URL}/api/places/${placeId}/review`, { headers: getAuthHeaders() }),
            ]);
            if (!placeRes.ok) throw new Error('Not found');
            const data = await placeRes.json();
            const fetchedPlace = data.place || data;
            const fetchedReview = reviewRes.ok ? (await reviewRes.json()).review : null;
            renderRestaurantCard(fetchedPlace, fetchedReview);
            _injectOwnPill(fetchedPlace, fetchedReview);
            rcCurrentGoogleId = fetchedPlace.google_place_id || null;
            if (fetchedPlace.google_place_id) {
                loadRcFriendReviews(fetchedPlace.google_place_id, highlightUserId, { initialHighlightIdx: null });
            }
        } catch (e) {
            document.getElementById('rc-name').textContent = 'Error loading';
        }
    }
}

function renderRestaurantCard(place, review) {
    document.getElementById('rc-name').textContent = place.name || '';
    document.getElementById('rc-address').textContent = place.address || '';

    // Hero photo carousel (full-bleed, scroll-snap)
    const heroEl = document.getElementById('rc-hero-strip');
    const heroPhotos = review ? [
        ...(review.overall_photos || []),
        ...((review.dishes || []).flatMap(d => d.photos || []))
    ] : [];
    renderRcHeroCarousel(heroEl, heroPhotos);

    // Meta row: rating (count) · price · type
    let meta = '';
    if (place.place_rating) {
        const cnt = place.place_rating_count ? ` (${Number(place.place_rating_count).toLocaleString()})` : '';
        meta += `<span class="rc-meta-chip">⭐ ${place.place_rating}${cnt}</span>`;
    } else {
        meta += `<span class="rc-meta-chip rc-meta-na">Rating N/A</span>`;
    }
    if (place.place_price_level && PLACE_PRICE_LABELS[place.place_price_level]) {
        meta += `<span class="rc-meta-chip">${PLACE_PRICE_LABELS[place.place_price_level]}</span>`;
    }
    const types = formatPlaceTypes(place.place_types);
    if (types) {
        meta += `<span class="rc-meta-chip rc-type-chip">${types}</span>`;
    } else {
        meta += `<span class="rc-meta-chip rc-meta-na">Type N/A</span>`;
    }
    document.getElementById('rc-meta').innerHTML = meta;

    // Opening hours (inline in top info)
    const hoursEl = document.getElementById('rc-hours');
    hoursEl.className = 'rc-hours';
    if (!place.place_opening_hours) {
        hoursEl.innerHTML = '<span class="rc-na-text">🕐 Hours not available</span>';
        hoursEl.style.display = '';
    } else {
        const hoursHtml = buildHoursHtml(place, 'rc');
        if (hoursHtml) {
            hoursEl.innerHTML = hoursHtml;
            hoursEl.style.display = '';
        } else {
            hoursEl.style.display = 'none';
        }
    }

    // Editorial description
    const descEl = document.getElementById('rc-description');
    if (place.place_description) {
        descEl.textContent = place.place_description;
        descEl.style.display = '';
    } else {
        descEl.innerHTML = '<span class="rc-na-text">No description available</span>';
        descEl.style.display = '';
    }

    // Personal notes
    const notesEl = document.getElementById('rc-notes');
    if (place.notes) {
        notesEl.innerHTML = `<span class="rc-notes-icon">📝</span><span class="rc-notes-text">${escapeHtml(place.notes)}</span>`;
        notesEl.style.display = '';
    } else {
        notesEl.style.display = 'none';
    }

    // Action buttons: 🗺 Maps + 🎬 Reel — side by side pill buttons
    const actionsEl = document.getElementById('rc-actions');
    const actionBtns = [];
    if (place.google_place_id) {
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${place.google_place_id}`;
        actionBtns.push(`<a href="${mapsUrl}" target="_blank" class="rc-action-btn">📍 Maps</a>`);
    } else if (place.latitude && place.longitude) {
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}`;
        actionBtns.push(`<a href="${mapsUrl}" target="_blank" class="rc-action-btn">📍 Maps</a>`);
    }
    if (place.source_url) {
        actionBtns.push(`<a href="${safeUrl(place.source_url)}" target="_blank" class="rc-action-btn">▶️ Reel</a>`);
    }
    actionBtns.push(`<button class="rc-action-btn" onclick="openAddToCollectionSheet(${place.id})">＋ Collect</button>`);
    actionBtns.push(`<button class="rc-action-btn" onclick="sharePlace(${place.id})">↗ Share</button>`);
    if (!review) {
        actionBtns.push(`<button class="rc-action-btn rc-action-btn--cta" onclick="openReviewFromRc(${place.id})">✏️ Add review</button>`);
    }
    if (actionBtns.length) {
        actionsEl.innerHTML = actionBtns.join('');
        actionsEl.style.display = '';
    } else {
        actionsEl.style.display = 'none';
    }

    // Edit icon in header — always hidden (edit lives in featured section now)
    const editIconBtn = document.getElementById('rc-edit-icon-btn');
    if (editIconBtn) editIconBtn.style.display = 'none';

    // People section — hide on share/group maps
    const peopleSection = document.getElementById('rc-people-section');
    if (peopleSection) {
        peopleSection.style.display = (IS_SHARE_MAP || IS_GROUP_MAP) ? 'none' : '';
    }
}

function renderRcYourVisit(place, review) {
    const el = document.getElementById('rc-your-visit');

    if (!place.is_visited) {
        el.innerHTML = `
            <div class="rc-visit-cta">
                <p class="rc-visit-cta-text">Haven't been here yet?</p>
                <button class="rc-log-btn" onclick="openLogVisit(${place.id}, false)">
                    Been here? Add a review →
                </button>
            </div>`;
        return;
    }

    const visitDate = place.visited_at
        ? new Date(place.visited_at).toLocaleDateString('en-SG', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';

    const score = computePlaceScore(review);
    const scoreBadge = score !== null
        ? `<span class="rc-score-badge" style="background:${scoreMarkerColor(score)}">${score.toFixed(1)}</span>`
        : '';

    let html = '';

    // Photos rendered as hero strip at top of card (see renderRestaurantCard)

    // Visit header: check + date, score badge
    html += `<div class="rc-visit-header">
        <span class="rc-visit-check">✓ Visited${visitDate ? ` · <span class="rc-visit-date">${visitDate}</span>` : ''}</span>
        ${scoreBadge}
    </div>`;

    if (review) {
        const BANDS = {
            loved: { emoji: '🔥', label: 'Loved it' },
            okay:  { emoji: '😊', label: 'Pretty good' },
            meh:   { emoji: '😑', label: 'It was alright' },
        };

        // Sentiment chip — same palette as feed card / RC friend reviews
        const band = review.sentiment && BANDS[review.sentiment];
        if (band) {
            html += `<div class="rcfr-sentiment ${review.sentiment}" style="margin-bottom:12px;">${band.emoji} ${band.label}</div>`;
        }

        // Sub-scores — 3-col progress bar layout (same as feed card)
        const fs = review.food_score, vs = review.vibe_score, ls = review.value_score;
        const mkCol = (s, label) => s != null
            ? `<div class="fc-score-col">
                   <div class="fc-score-num">${s}</div>
                   <div class="fc-score-bar-track"><div class="fc-score-bar-fill" style="width:${s * 10}%"></div></div>
                   <div class="fc-score-label">${label}</div>
               </div>` : '';
        if (fs != null || vs != null || ls != null) {
            html += `<div class="fc-scores-grid" style="margin-bottom:12px;">${mkCol(fs,'Food')}${mkCol(vs,'Vibe')}${mkCol(ls,'Value')}</div>`;
        }

        // Dishes — horizontal scrollable pills (same as feed card)
        const dishes = review.dishes || [];
        if (dishes.length > 0) {
            html += `<div class="fc-dishes" style="margin-bottom:4px;">${dishes.map(d =>
                `<div class="fc-dish-pill">
                    <span class="fc-dish-name">${escapeHtml(d.name)}</span>
                    ${d.rating != null ? `<span class="fc-dish-score">${d.rating}</span>` : ''}
                </div>`
            ).join('')}</div>`;
        }

        // Caption
        const caption = review.caption || review.overall_remarks || '';
        if (caption) {
            html += `<p class="rc-visit-remarks">"${escapeHtml(caption)}"</p>`;
        }
    }

    el.innerHTML = html;
}

// Shared helper: render hero carousel into a container element
function renderRcHeroCarousel(containerEl, photos) {
    if (!containerEl) return;
    if (!photos || photos.length === 0) {
        containerEl.innerHTML = '';
        containerEl.style.display = 'none';
        return;
    }
    const slides = photos.map((p, i) =>
        `<div class="rc-hero-slide"><img class="rc-hero-slide-img" src="${safeUrl(p.url)}" alt="" loading="lazy" data-idx="${i}" onclick="openImgViewer(this.src)"></div>`
    ).join('');
    const dotsHtml = photos.length > 1
        ? `<div class="rc-dots">${photos.map((_, i) => `<span class="rc-dot${i === 0 ? ' active' : ''}"></span>`).join('')}</div>`
        : '';
    containerEl.innerHTML = `<div class="rc-hero-carousel">${slides}</div>${dotsHtml}`;
    containerEl.style.display = '';
    if (photos.length > 1) {
        const carousel = containerEl.querySelector('.rc-hero-carousel');
        const dots = containerEl.querySelectorAll('.rc-dot');
        carousel.addEventListener('scroll', () => {
            const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
            dots.forEach((d, i) => d.classList.toggle('active', i === idx));
        }, { passive: true });
    }
}

// ── RC review normalizers ────────────────────────────────────────────────────

function normalizeActivityReview(activity) {
    const review = activity.review || {};
    return {
        reviewerName: activity.is_own ? 'You' : (activity.actor_name || activity.actor_username || 'Friend'),
        isOwn:        activity.is_own || false,
        userId:       activity.user_id || null,
        avatarUrl:    null,
        sentiment:    review.sentiment   || null,
        foodScore:    review.food_score  ?? null,
        vibeScore:    review.vibe_score  ?? null,
        valueScore:   review.value_score ?? null,
        caption:      review.caption || review.overall_remarks || '',
        dishes:       activity.review_dishes || review.dishes || [],
        visitedAt:    activity.created_at || null,
        createdAt:    activity.created_at || null,
        photos:       (activity.review_photos || []).map(p => ({ url: p.file_url || p.url || p })),
    };
}

function normalizeOwnReview(place, review) {
    const allPhotos = [
        ...(review.overall_photos || []),
        ...((review.dishes || []).flatMap(d => d.photos || [])),
    ];
    return {
        reviewerName: 'You',
        isOwn:        true,
        userId:       null,
        avatarUrl:    null,
        sentiment:    review.sentiment   || null,
        foodScore:    review.food_score  ?? null,
        vibeScore:    review.vibe_score  ?? null,
        valueScore:   review.value_score ?? null,
        caption:      review.caption || review.overall_remarks || '',
        dishes:       review.dishes || [],
        visitedAt:    place.visited_at  || review.created_at || null,
        createdAt:    review.created_at || null,
        photos:       allPhotos.map(p => ({ url: p.file_url || p.url || p })),
    };
}

function normalizeApiReview(r) {
    return {
        reviewerName: r.reviewer_name || r.display_name || r.first_name || 'Friend',
        isOwn:        false,
        userId:       r.user_id || null,
        avatarUrl:    r.photo_url || null,
        sentiment:    r.sentiment   || null,
        foodScore:    r.food_score  ?? null,
        vibeScore:    r.vibe_score  ?? null,
        valueScore:   r.value_score ?? null,
        caption:      r.caption || r.overall_remarks || '',
        dishes:       r.dishes || [],
        visitedAt:    r.created_at || null,
        createdAt:    r.created_at || null,
        photos:       (r.photos || []).map(p => ({ url: p.file_url || p.url || p })),
    };
}

// Switch active review: updates hero carousel, featured section, and active border
function selectRcReview(idx) {
    if (idx < 0 || idx >= rcLoadedReviews.length) return;
    const reviewData = rcLoadedReviews[idx];
    // Scroll RC sheet to top so featured section is visible (instant, not smooth)
    const rcScrollEl = document.querySelector('#restaurant-card .rc-scroll');
    if (rcScrollEl) rcScrollEl.scrollTop = 0;
    // Update hero
    const heroEl = document.getElementById('rc-hero-strip');
    renderRcHeroCarousel(heroEl, reviewData.photos);
    // Update featured section title + edit button + content
    const titleEl = document.getElementById('rc-featured-title');
    if (titleEl) titleEl.textContent = reviewData.isOwn ? 'Your Review' : `${reviewData.reviewerName}'s Review`;
    const editReviewBtn = document.getElementById('rc-edit-review-btn');
    if (editReviewBtn) editReviewBtn.style.display = (reviewData.isOwn && rcCurrentPlaceId) ? '' : 'none';
    renderRcActiveReview(reviewData);
    // Show featured section
    const featSec = document.getElementById('rc-featured-section');
    const featDiv = document.getElementById('rc-featured-divider');
    if (featSec) featSec.style.display = '';
    if (featDiv) featDiv.style.display = '';
    // Move active border
    document.querySelectorAll('[data-rc-idx]').forEach(el => el.classList.remove('rc-person-pill--active'));
    const activeEl = document.querySelector(`[data-rc-idx="${idx}"]`);
    if (activeEl) activeEl.classList.add('rc-person-pill--active');
    rcActiveReviewIdx = idx;
}

// Render a normalized review into #rc-featured-review using rcfr-* classes
function renderRcActiveReview(reviewData) {
    const el = document.getElementById('rc-featured-review');
    if (!el) return;
    const BANDS = {
        loved: { emoji: '🔥', label: 'Loved it' },
        okay:  { emoji: '😊', label: 'Pretty good' },
        meh:   { emoji: '😑', label: 'It was alright' },
    };
    const { sentiment, foodScore, vibeScore, valueScore, caption, dishes, visitedAt } = reviewData;
    const scores = [foodScore, vibeScore, valueScore].filter(s => s != null);
    const overall = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;
    const scClass = overall ? (parseFloat(overall) >= 8 ? 'score-high' : parseFloat(overall) >= 6 ? 'score-mid' : 'score-low') : '';
    const visitDate = visitedAt
        ? new Date(visitedAt).toLocaleDateString('en-SG', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';
    let html = '';
    if (visitDate || overall) {
        html += `<div class="rc-visit-header">
            <span class="rc-visit-check">✓ Visited${visitDate ? ` · <span class="rc-visit-date">${visitDate}</span>` : ''}</span>
            ${overall ? `<span class="rc-score-badge ${scClass}" style="background:${scoreMarkerColor(parseFloat(overall))}">${overall}</span>` : ''}
        </div>`;
    }
    const band = sentiment && BANDS[sentiment];
    if (band) html += `<div class="rcfr-sentiment ${sentiment}" style="margin-bottom:12px;">${band.emoji} ${band.label}</div>`;
    const mkScore = (s, label) => s != null
        ? `<div class="rcfr-score-col">
               <div class="rcfr-score-num">${s}</div>
               <div class="rcfr-score-bar"><div class="rcfr-score-fill" style="width:${s * 10}%"></div></div>
               <div class="rcfr-score-lbl">${label}</div>
           </div>` : '';
    if (foodScore != null || vibeScore != null || valueScore != null) {
        html += `<div class="rcfr-scores" style="margin-bottom:12px;">${mkScore(foodScore,'Food')}${mkScore(vibeScore,'Vibe')}${mkScore(valueScore,'Value')}</div>`;
    }
    if (dishes && dishes.length > 0) {
        html += `<div class="rcfr-dishes" style="margin-bottom:8px;">${dishes.map(d => {
            const name = d.dish_name || d.name || '';
            const rating = d.rating ?? null;
            const sc = rating != null ? (rating >= 8 ? 'dish-high' : rating >= 5 ? 'dish-mid' : 'dish-low') : '';
            return `<span class="rcfr-dish ${sc}">${escapeHtml(name)}${rating != null ? `<span class="rcfr-dish-score ${sc}"> ${rating}</span>` : ''}</span>`;
        }).join('')}</div>`;
    }
    if (caption) html += `<p class="rcfr-caption">"${escapeHtml(caption)}"</p>`;
    el.innerHTML = html;
}

// Render a horizontal pill for a person in the "People Who've Been" list
function renderPersonPill({ name, userId, isOwn, idx, score, photoUrl }) {
    const overall = score !== null && score !== undefined ? score.toFixed(1) : null;
    const avatarStyle = photoUrl
        ? `background-image:url('${escapeHtml(photoUrl)}');background-size:cover;background-position:center;`
        : '';
    const avatarContent = photoUrl ? '' : name[0].toUpperCase();
    const youClass = isOwn ? ' rc-person-pill-you' : '';
    const avatarClick = (!isOwn && userId)
        ? `onclick="event.stopPropagation();openUserProfile(${userId})"` : '';
    const scoreBadge = overall !== null
        ? `<span class="rc-score-badge" style="background:${scoreMarkerColor(parseFloat(overall))}">${overall}</span>` : '';
    return `<div class="rc-person-pill" data-rc-idx="${idx}" onclick="selectRcReview(${idx})">
        <div class="rc-person-pill-avatar${youClass}" style="${avatarStyle}" ${avatarClick}>${avatarContent}</div>
        <span class="rc-person-pill-name">${escapeHtml(name)}</span>
        ${scoreBadge}
    </div>`;
}


async function loadRcFriendReviews(googlePlaceId, highlightUserId = null, { suppressYourReview = false, initialHighlightIdx = null } = {}) {
    const capturedGid = googlePlaceId;
    const listEl = document.getElementById('rc-people-list');
    try {
        const res = await fetch(`${API_URL}/api/restaurant/${googlePlaceId}/friend-reviews`, { headers: getAuthHeaders() });
        // Guard: discard if user navigated to a different RC while loading
        if (rcCurrentGoogleId !== capturedGid) return;
        if (!res.ok) return;
        const data = await res.json();
        const reviews = data.reviews || [];

        if (reviews.length === 0 && listEl && listEl.children.length === 0) {
            listEl.innerHTML = '<p class="rc-people-empty">No one\'s been here yet.</p>';
        }

        const startIdx = rcLoadedReviews.length;
        reviews.forEach(r => rcLoadedReviews.push(normalizeApiReview(r)));

        if (listEl) {
            listEl.innerHTML += reviews.map((r, i) => {
                const idx = startIdx + i;
                const name = r.reviewer_name || r.display_name || r.first_name || 'Friend';
                const scores = [r.food_score, r.vibe_score, r.value_score].filter(s => s != null);
                const overall = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
                return renderPersonPill({ name, userId: r.user_id, isOwn: false, idx, score: overall, photoUrl: r.photo_url });
            }).join('');
        }

        // Apply active border to initialHighlightIdx row now that its DOM element exists
        if (initialHighlightIdx !== null) {
            const el = document.querySelector(`[data-rc-idx="${initialHighlightIdx}"]`);
            if (el && !el.classList.contains('rc-person-pill--active')) el.classList.add('rc-person-pill--active');
        } else if (rcActiveReviewIdx === -1 && rcLoadedReviews.length > 0) {
            selectRcReview(0);
        }

        // Compute community average from all loaded reviews (yours + friends)
        const scoredReviews = rcLoadedReviews.filter(r => [r.foodScore, r.vibeScore, r.valueScore].some(s => s != null));
        const avgEl = document.getElementById('rc-friends-avg');
        if (scoredReviews.length > 0) {
            const totals = scoredReviews.map(r => {
                const vals = [r.foodScore, r.vibeScore, r.valueScore].filter(s => s != null);
                return vals.reduce((a, b) => a + b, 0) / vals.length;
            });
            const communityAvg = (totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(1);
            if (avgEl) {
                const color = scoreMarkerColor(parseFloat(communityAvg));
                avgEl.style.background = color;
                avgEl.style.color = '#fff';
                avgEl.textContent = communityAvg;
                avgEl.style.display = '';
            }
        } else {
            if (avgEl) avgEl.style.display = 'none';
        }
    } catch (e) {
        console.error('loadRcFriendReviews error:', e);
    }
}

function closeRestaurantCard() {
    const sheet = document.getElementById('restaurant-card');
    const overlay = document.getElementById('restaurant-card-overlay');
    sheet.classList.remove('rc-open');
    overlay.style.display = 'none';
    rcCurrentPlaceId  = null;
    rcCurrentGoogleId = null;
    rcLoadedReviews   = [];
    rcActiveReviewIdx = -1;
    const pl = document.getElementById('rc-people-list');
    if (pl) pl.innerHTML = '';
    const avgChipClose = document.getElementById('rc-friends-avg');
    if (avgChipClose) avgChipClose.style.display = 'none';

    // Restore map view to pre-zoom-in position (map view only)
    if (map && currentView === 'map' && _mapViewBeforeRc) {
        map.setView(_mapViewBeforeRc.center, _mapViewBeforeRc.zoom, { animate: true });
        _mapViewBeforeRc = null;
    }
}

function openRcMenu() {
    // Route into the unified place-menu
    if (!rcCurrentPlaceId) return;
    const place = places.find(p => p.id === rcCurrentPlaceId);
    openPlaceMenu(rcCurrentPlaceId, place?.name || '');
}

// ═══════════════════════════════════════════════════════════════════════
// LOG VISIT SHEET
// ═══════════════════════════════════════════════════════════════════════

let lvPlaceId = null;
let lvRating = 0;

function openLogVisit(placeId, isEdit = false) {
    lvPlaceId = placeId;
    lvRating = 0;

    const place = places.find(p => p.id === placeId);
    document.getElementById('lv-place-name').textContent = place?.name || '';

    // Pre-fill if editing
    const review = getPlaceReview(placeId);
    if (isEdit && review) {
        setVisitRating(review.overall_rating || 0);
        document.getElementById('lv-review-text').value = review.overall_remarks || '';
    } else {
        setVisitRating(0);
        document.getElementById('lv-review-text').value = '';
    }

    document.getElementById('log-visit-overlay').style.display = 'flex';
    document.getElementById('log-visit-sheet').classList.add('rc-open');
}

function closeLogVisit() {
    const sheet = document.getElementById('log-visit-sheet');
    sheet.classList.remove('rc-open');
    document.getElementById('log-visit-overlay').style.display = 'none';
    lvPlaceId = null;
}

function setVisitRating(val) {
    lvRating = val;
    document.querySelectorAll('#lv-stars .lv-star').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.val) <= val);
    });
}

async function submitLogVisit() {
    if (!lvPlaceId) return;
    const text = document.getElementById('lv-review-text').value.trim();
    const btn = document.getElementById('lv-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
        const res = await fetch(`${API_URL}/api/places/${lvPlaceId}/log-visit`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating: lvRating || null, review_text: text || null }),
        });
        if (!res.ok) throw new Error('Failed');

        // Update local state
        const place = places.find(p => p.id === lvPlaceId);
        if (place) {
            place.is_visited = true;
            place.visited_at = new Date().toISOString();
        }
        // Update local reviews cache so popup immediately shows visited state
        const existing = getPlaceReview(lvPlaceId);
        if (existing) {
            if (lvRating) existing.overall_rating = lvRating;
            if (text) existing.overall_remarks = text;
        } else {
            allReviews.push({ place_id: lvPlaceId, overall_rating: lvRating || null, overall_remarks: text || null });
        }

        closeLogVisit();
        // Refresh restaurant card if open
        if (rcCurrentPlaceId === lvPlaceId) {
            openRestaurantCard(lvPlaceId);
        }
        // Re-render list
        applyFilters();
        displayPlacesOnMap(false);

    } catch (e) {
        console.error('submitLogVisit error:', e);
        btn.textContent = 'Error — try again';
    } finally {
        btn.disabled = false;
        if (btn.textContent === 'Saving…') btn.textContent = 'Save Visit';
    }
}

// Helper: get current filtered+sorted list (needed after local state changes)
function applyFiltersToList(allPlaces) {
    // reuse existing applyFilters chain
    let filtered = allPlaces;
    if (typeof applyFilters === 'function') {
        // applyFilters() re-renders internally; we need to get the filtered array
        // Use the existing filter state vars
        filtered = filterByVisited(filtered);
        filtered = filterByCategory(filtered);
        filtered = filterByCountry(filtered);
        filtered = filterByRating(filtered);
        filtered = filterByPriceLevel(filtered);
        filtered = filterByOpenNow(filtered);
        filtered = filterBySearch(filtered);
        filtered = sortPlaces(filtered);
    }
    return filtered;
}

// Feed like/unlike
async function likeActivity(activityId, btn) {
    const liked = btn.dataset.liked === 'true';
    let countEl = btn.querySelector('.fc-action-count');
    const currentCount = parseInt(countEl?.textContent || '0');
    const newCount = liked ? currentCount - 1 : currentCount + 1;

    // Optimistic update
    btn.dataset.liked = liked ? 'false' : 'true';
    btn.classList.toggle('liked', !liked);
    if (newCount > 0) {
        if (!countEl) {
            countEl = document.createElement('span');
            countEl.className = 'fc-action-count';
            btn.appendChild(countEl);
        }
        countEl.textContent = newCount;
    } else if (countEl) {
        countEl.textContent = '';
    }

    try {
        const method = liked ? 'DELETE' : 'POST';
        await fetch(`${API_URL}/api/activities/${activityId}/like`, {
            method, headers: getAuthHeaders()
        });
    } catch (e) {
        // Revert on error
        btn.dataset.liked = liked ? 'true' : 'false';
        btn.classList.toggle('liked', liked);
        if (countEl) countEl.textContent = currentCount > 0 ? currentCount : '';
    }
}

async function showLikersSheet(activityId) {
    const overlay = document.getElementById('likers-overlay');
    const list = document.getElementById('likers-list');
    list.innerHTML = '<div class="likers-empty">Loading...</div>';
    overlay.style.display = 'flex';
    try {
        const res = await fetch(`${API_URL}/api/activities/${activityId}/likers`, { headers: getAuthHeaders() });
        const data = await res.json();
        const likers = data.likers || [];
        if (likers.length === 0) {
            list.innerHTML = '<div class="likers-empty">No likes yet</div>';
            return;
        }
        list.innerHTML = likers.map(u => `
            <div class="likers-item">
                <img class="likers-avatar" src="${u.avatar_url || ''}" alt="" onerror="this.style.display='none'">
                <span class="likers-name">${escapeHtml(u.display_name || 'Sprout user')}</span>
            </div>
        `).join('');
    } catch (e) {
        list.innerHTML = '<div class="likers-empty">Couldn\'t load likes</div>';
    }
}

function closeLikersSheet(e) {
    if (e && e.target !== document.getElementById('likers-overlay')) return;
    document.getElementById('likers-overlay').style.display = 'none';
}

function onFeedCardTap(activityId, googlePlaceId) {
    const activity = feedActivitiesMap[activityId];
    const isVisit = activity && (activity.activity_type === 'visited' || activity.activity_type === 'reviewed');
    const gid = googlePlaceId || activity?.place_google_id || (activity?.metadata||{}).google_place_id || '';
    const own = gid ? places.find(p => p.google_place_id === gid) : null;

    if (isVisit) {
        // Always open guest RC for friend review posts — shows featured review section
        // If user also has the place saved, their own review appears as compact card below
        openSharedRestaurant(activityId);
    } else {
        // Saved bookmark: open own RC if saved, else guest RC
        if (own) {
            openRestaurantCard(own.id);
        } else {
            openSharedRestaurant(activityId);
        }
    }
}

// ========== FRIEND REVIEW DETAIL =========

function openFriendReviewDetail(reviewJson) {
    const r = typeof reviewJson === 'string' ? JSON.parse(reviewJson) : reviewJson;
    const name = r.reviewer_name || r.display_name || r.first_name || 'Friend';
    const BANDS = {
        loved: { emoji: '🔥', label: 'Loved it' },
        okay:  { emoji: '😊', label: 'Pretty good' },
        meh:   { emoji: '😑', label: 'It was alright' },
    };

    // Avatar
    const avatarEl = document.getElementById('frd-avatar');
    if (avatarEl) {
        if (r.photo_url) {
            avatarEl.style.backgroundImage = `url('${r.photo_url}')`;
            avatarEl.style.backgroundSize = 'cover';
            avatarEl.style.backgroundPosition = 'center';
            avatarEl.textContent = '';
        } else {
            avatarEl.style.backgroundImage = '';
            avatarEl.textContent = name[0].toUpperCase();
        }
    }

    const nameEl = document.getElementById('frd-name');
    if (nameEl) nameEl.textContent = name;
    const timeEl = document.getElementById('frd-time');
    if (timeEl) timeEl.textContent = r.created_at ? formatTimeAgo(r.created_at) : '';
    const placeEl = document.getElementById('frd-place-name');
    if (placeEl) placeEl.textContent = r.place_name || '';

    // Sentiment
    const sentEl = document.getElementById('frd-sentiment');
    if (sentEl) {
        const band = r.sentiment && BANDS[r.sentiment];
        sentEl.innerHTML = band
            ? `<span class="fc-sent-chip ${r.sentiment}">${band.emoji} ${band.label}</span>`
            : '';
    }

    // Scores
    const scoresEl = document.getElementById('frd-scores');
    if (scoresEl) {
        const mkScore = (score, label) => score != null
            ? `<div class="rcfr-score-col">
                   <div class="rcfr-score-num">${score}</div>
                   <div class="rcfr-score-bar"><div class="rcfr-score-fill" style="width:${score * 10}%"></div></div>
                   <div class="rcfr-score-lbl">${label}</div>
               </div>` : '';
        const fs = r.food_score, vs = r.vibe_score, ls = r.value_score;
        scoresEl.innerHTML = (fs != null || vs != null || ls != null)
            ? mkScore(fs,'Food') + mkScore(vs,'Vibe') + mkScore(ls,'Value') : '';
        scoresEl.style.display = scoresEl.innerHTML ? '' : 'none';
    }

    // Caption
    const captionEl = document.getElementById('frd-caption');
    if (captionEl) {
        const caption = r.caption || r.overall_remarks || '';
        captionEl.textContent = caption ? `"${caption}"` : '';
        captionEl.style.display = caption ? '' : 'none';
    }

    // Dishes
    const dishesEl = document.getElementById('frd-dishes');
    if (dishesEl) {
        const dishes = r.dishes || [];
        dishesEl.innerHTML = dishes.map(d =>
            `<span class="fc-dish-chip">${escapeHtml(d.dish_name)}${d.rating != null ? ` · ${d.rating}` : ''}</span>`
        ).join('');
        dishesEl.style.display = dishes.length ? '' : 'none';
    }

    // Photos
    const photosEl = document.getElementById('frd-photos');
    if (photosEl) {
        const photos = r.photos || [];
        photosEl.innerHTML = photos.map(p =>
            `<img class="frd-photo" src="${escapeHtml(p.file_url || p)}" loading="lazy">`
        ).join('');
        photosEl.style.display = photos.length ? '' : 'none';
    }

    const overlay = document.getElementById('frd-overlay');
    const sheet   = document.getElementById('frd-sheet');
    if (overlay) overlay.style.display = 'flex';
    requestAnimationFrame(() => sheet?.classList.add('rc-open'));
}

function closeFriendReviewDetail() {
    const sheet = document.getElementById('frd-sheet');
    sheet?.classList.remove('rc-open');
    setTimeout(() => {
        const overlay = document.getElementById('frd-overlay');
        if (overlay) overlay.style.display = 'none';
    }, 300);
}

// ========== COLLECTIONS ==========

async function loadCollections() {
    try {
        const res = await fetch(`${API_URL}/api/collections`, { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        collections = data.collections || [];
        renderCollectionsList();
        renderCollectionFilterRow();
        populateCollectionsDropdown();
    } catch (e) { console.error('loadCollections error:', e); }
}

function renderCollectionsList() {
    const el = document.getElementById('collections-list');
    if (!el) return;
    if (!collections.length) {
        el.innerHTML = '<div class="col-empty">No collections yet. Tap ＋ to create one.</div>';
        return;
    }
    el.innerHTML = collections.map(c => `
        <div class="col-card" onclick="openCollectionSheet(${c.id})">
            <span class="col-emoji">${escapeHtml(c.emoji || '📍')}</span>
            <div class="col-info">
                <div class="col-name">${escapeHtml(c.name)}</div>
                <div class="col-meta">${c.place_count || 0} places${c.role === 'owner' ? '' : ' · Shared'}</div>
            </div>
            <span class="col-chevron">›</span>
        </div>
    `).join('');
}

function renderCollectionFilterRow() {
    const row = document.getElementById('collection-filter-row');
    if (!row) return;
    if (!collections.length) {
        row.style.display = 'none';
        return;
    }
    row.style.display = '';
    const allActive = !activeCollectionId;
    row.innerHTML = [
        `<button class="col-pill${allActive ? ' active' : ''}" onclick="setActiveCollection(null)">All</button>`,
        ...collections.map(c => {
            const isActive = activeCollectionId == c.id;
            return `<button class="col-pill${isActive ? ' active' : ''}" onclick="setActiveCollection(${c.id})">${escapeHtml(c.emoji || '📍')} ${escapeHtml(c.name)}</button>`;
        })
    ].join('');
}

function setActiveCollection(id) {
    activeCollectionId = id;
    const select = document.getElementById('map-collection-filter');
    if (select) select.value = id || '';
    if (id && !_collectionPlacesCache[id]) {
        _fetchCollectionPlaces(id).then(() => {
            applyFilters();
            displayPlacesOnMap(false);  // direct: after async data fetch
            renderCollectionFilterRow();
        });
    } else {
        applyFilters();
        debouncedDisplayPlacesOnMap(false);  // filter change: debounced
        renderCollectionFilterRow();
    }
}

async function _fetchCollectionPlaces(collectionId) {
    try {
        const res = await fetch(`${API_URL}/api/collections/${collectionId}/places`, { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        _collectionPlacesCache[collectionId] = data.places || [];
    } catch (e) { console.error('_fetchCollectionPlaces error:', e); }
}

// ── Create Collection ──

function openCreateCollection() {
    const overlay = document.getElementById('create-collection-overlay');
    if (!overlay) return;
    document.getElementById('col-name-input').value = '';
    document.querySelectorAll('.col-emoji-btn').forEach(b => b.classList.remove('active'));
    const first = document.querySelector('.col-emoji-btn');
    if (first) first.classList.add('active');
    // Wire emoji button clicks
    document.querySelectorAll('.col-emoji-btn').forEach(b => {
        b.onclick = () => selectCollectionEmoji(b);
    });
    overlay.style.display = 'flex';
}

function closeCreateCollection(e) {
    if (e && e.target !== e.currentTarget) return;
    const overlay = document.getElementById('create-collection-overlay');
    if (overlay) overlay.style.display = 'none';
}

function selectCollectionEmoji(el) {
    document.querySelectorAll('.col-emoji-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
}

async function submitCreateCollection() {
    const name = document.getElementById('col-name-input').value.trim();
    if (!name) { showToast('Enter a collection name'); return; }
    const activeEmoji = document.querySelector('.col-emoji-btn.active');
    const emoji = activeEmoji ? activeEmoji.textContent.trim() : '📍';
    try {
        const res = await fetch(`${API_URL}/api/collections`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, emoji }),
        });
        if (!res.ok) throw new Error();
        closeCreateCollection();
        await loadCollections();
        showToast(`${emoji} "${name}" created`);
    } catch (e) { showToast('Failed to create collection'); }
}

// ── Collection Detail Sheet ──

let _currentCollectionId = null;

async function openCollectionSheet(collectionId) {
    _currentCollectionId = collectionId;
    const overlay = document.getElementById('collection-sheet-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';

    document.getElementById('col-sheet-title').textContent = '…';
    document.getElementById('col-sheet-meta').innerHTML = '';
    document.getElementById('col-sheet-actions').innerHTML = '';
    document.getElementById('col-sheet-body').innerHTML = '<div class="col-empty">Loading…</div>';

    try {
        const [colRes, placesRes] = await Promise.all([
            fetch(`${API_URL}/api/collections/${collectionId}`, { headers: getAuthHeaders() }),
            fetch(`${API_URL}/api/collections/${collectionId}/places`, { headers: getAuthHeaders() }),
        ]);
        if (!colRes.ok) throw new Error();
        const col = (await colRes.json()).collection;
        const colPlaces = placesRes.ok ? ((await placesRes.json()).places || []) : [];

        _collectionPlacesCache[collectionId] = colPlaces;

        document.getElementById('col-sheet-title').textContent = `${col.emoji || '📍'} ${col.name}`;

        const members = col.members || [];
        document.getElementById('col-sheet-meta').innerHTML = members.slice(0, 5).map(m => {
            if (m.avatar_url) {
                return `<img class="col-member-avatar" src="${escapeHtml(m.avatar_url)}" title="${escapeHtml(m.display_name || '')}" onerror="this.style.display='none'">`;
            }
            return `<div class="col-member-initials" title="${escapeHtml(m.display_name || '')}">${(m.display_name || '?').slice(0, 1).toUpperCase()}</div>`;
        }).join('');

        const isOwner = col.role === 'owner';
        document.getElementById('col-sheet-actions').innerHTML = `
            <button class="col-action-btn" onclick="switchToMapWithCollection(${collectionId})">🗺 Map</button>
            ${isOwner ? `<button class="col-action-btn col-action-btn--primary" onclick="openInviteToCollection(${collectionId})">＋ Invite</button>` : ''}
        `;

        if (!colPlaces.length) {
            document.getElementById('col-sheet-body').innerHTML = '<div class="col-empty">No places yet. Open a saved place and tap ＋ Collect.</div>';
        } else {
            document.getElementById('col-sheet-body').innerHTML = colPlaces.map(p => {
                const ab = p.added_by;
                const sharedBy = ab ? `
                    <span class="cp-shared-by">
                        ${ab.avatar_url ? `<img class="cp-shared-avatar" src="${escapeHtml(ab.avatar_url)}" onerror="this.parentElement.style.display='none'">` : `<span class="cp-shared-initials">${(ab.display_name||'?').slice(0,1)}</span>`}
                        ${escapeHtml(ab.display_name || '')}
                    </span>` : '';
                return `
                    <div class="col-place-row" onclick="openRcFromCollection('${escapeHtml(p.google_place_id||'')}', ${p.place_id || 'null'})">
                        <div class="col-place-info">
                            <div class="col-place-name">${escapeHtml(p.name)}</div>
                            ${p.address ? `<div class="col-place-addr">${escapeHtml(p.address)}</div>` : ''}
                            ${sharedBy}
                        </div>
                        ${isOwner ? `<button class="col-place-remove" onclick="removeFromCollectionSheet(event,${collectionId},${p.id})">×</button>` : ''}
                    </div>`;
            }).join('');
        }
    } catch (e) {
        document.getElementById('col-sheet-body').innerHTML = '<div class="col-empty">Failed to load collection.</div>';
    }
}

function closeCollectionSheet(e) {
    if (e && e.target !== e.currentTarget) return;
    const overlay = document.getElementById('collection-sheet-overlay');
    if (overlay) overlay.style.display = 'none';
    _currentCollectionId = null;
}

function switchToMapWithCollection(collectionId) {
    activeCollectionId = collectionId;
    closeCollectionSheet();
    switchTab('saved');
    switchView('map');
    const select = document.getElementById('map-collection-filter');
    if (select) select.value = collectionId;
    displayPlacesOnMap(true);
}

async function removeFromCollectionSheet(event, collectionId, collectionPlaceId) {
    event.stopPropagation();
    try {
        const res = await fetch(`${API_URL}/api/collections/${collectionId}/places/${collectionPlaceId}`, {
            method: 'DELETE',
            headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error();
        showToast('Removed from collection');
        delete _collectionPlacesCache[collectionId];
        openCollectionSheet(collectionId);
        loadCollections();
    } catch (e) { showToast('Failed to remove'); }
}

function openRcFromCollection(googlePlaceId, placeId) {
    closeCollectionSheet();
    if (placeId) {
        openRestaurantCard(placeId);
    }
}

async function openInviteToCollection(collectionId) {
    showToast('Invite feature coming soon');
}

// ── Add to Collection Sheet ──

let _addToColPlaceId = null;
let _addToColGoogleId = null;
let _placeInCollections = new Set();

async function openAddToCollectionSheet(placeId) {
    _addToColPlaceId = placeId;
    const overlay = document.getElementById('add-to-col-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    document.getElementById('add-to-col-list').innerHTML = '<div class="col-empty">Loading…</div>';

    const place = places.find(p => p.id === placeId);
    _addToColGoogleId = place ? place.google_place_id : null;

    try {
        const res = await fetch(`${API_URL}/api/places/${placeId}/collections`, { headers: getAuthHeaders() });
        const data = res.ok ? await res.json() : { collection_ids: [] };
        _placeInCollections = new Set(data.collection_ids || []);
    } catch (e) {
        _placeInCollections = new Set();
    }
    renderAddToColList();
}

function closeAddToCollectionSheet(e) {
    if (e && e.target !== e.currentTarget) return;
    const overlay = document.getElementById('add-to-col-overlay');
    if (overlay) overlay.style.display = 'none';
    _addToColPlaceId = null;
    _addToColGoogleId = null;
}

function renderAddToColList() {
    const el = document.getElementById('add-to-col-list');
    if (!el) return;
    if (!collections.length) {
        el.innerHTML = `<div class="col-add-new-row" onclick="closeAddToCollectionSheet(); openCreateCollection();">＋ Create your first collection</div>`;
        return;
    }
    el.innerHTML = [
        `<div class="col-add-new-row" onclick="closeAddToCollectionSheet(); openCreateCollection();">＋ New collection</div>`,
        ...collections.map(c => {
            const inCol = _placeInCollections.has(c.id);
            return `
                <div class="col-add-row" onclick="togglePlaceInCollection(${c.id})">
                    <span class="col-add-emoji">${escapeHtml(c.emoji || '📍')}</span>
                    <span class="col-add-name">${escapeHtml(c.name)}</span>
                    <span class="col-add-check${inCol ? ' checked' : ''}" id="col-check-${c.id}">${inCol ? '✓' : ''}</span>
                </div>`;
        })
    ].join('');
}

async function togglePlaceInCollection(collectionId) {
    if (!_addToColPlaceId) return;
    const inCol = _placeInCollections.has(collectionId);
    if (inCol) {
        try {
            let cp = (_collectionPlacesCache[collectionId] || []).find(
                p => p.place_id === _addToColPlaceId || p.google_place_id === _addToColGoogleId
            );
            if (!cp) {
                const r = await fetch(`${API_URL}/api/collections/${collectionId}/places`, { headers: getAuthHeaders() });
                const d = r.ok ? await r.json() : { places: [] };
                _collectionPlacesCache[collectionId] = d.places || [];
                cp = (d.places || []).find(p => p.place_id === _addToColPlaceId || p.google_place_id === _addToColGoogleId);
            }
            if (!cp) return;
            const res = await fetch(`${API_URL}/api/collections/${collectionId}/places/${cp.id}`, {
                method: 'DELETE',
                headers: getAuthHeaders(),
            });
            if (!res.ok) throw new Error();
            _placeInCollections.delete(collectionId);
            delete _collectionPlacesCache[collectionId];
        } catch (e) { showToast('Failed to remove'); return; }
    } else {
        try {
            const res = await fetch(`${API_URL}/api/collections/${collectionId}/places`, {
                method: 'POST',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ place_id: _addToColPlaceId }),
            });
            if (!res.ok) throw new Error();
            _placeInCollections.add(collectionId);
            delete _collectionPlacesCache[collectionId];
        } catch (e) { showToast('Failed to add'); return; }
    }
    renderAddToColList();
    loadCollections();
}

// ========== SHARED RESTAURANT VIEW ==========

let sharedRcActivity = null;

function openSharedRestaurant(activityId) {
    const activity = feedActivitiesMap[activityId];
    if (!activity) return;
    const meta = activity.metadata || {};
    openRestaurantCardGuest({
        name:               activity.place_name_resolved    || meta.place_name || '',
        address:            activity.place_address_resolved || meta.address    || '',
        google_place_id:    activity.place_google_id        || meta.google_place_id || '',
        place_rating:       activity.place_rating,
        place_rating_count: activity.place_rating_count,
        place_price_level:  activity.place_price_level,
        place_types:        activity.place_types,
        source_url:         activity.place_source_url       || null,
    }, { highlightUserId: activity.user_id, activity });
}

// ========== IMAGE VIEWER ==========

let _ivScale = 1, _ivPrevScale = 1;
let _ivTx = 0, _ivTy = 0;
let _ivPinchDist0 = 0;
let _ivPanOrigin = null;   // { x, y, tx, ty }
let _ivDismissStart = null; // { y } when swipe-to-close begins
let _ivLastTap = 0;
let _ivTouchReady = false;

function openImgViewer(src) {
    const viewer = document.getElementById('img-viewer');
    const img = document.getElementById('img-viewer-img');
    if (!viewer || !img) return;
    _ivScale = 1; _ivPrevScale = 1; _ivTx = 0; _ivTy = 0;
    img.src = src;
    img.style.transition = 'none';
    img.style.transform = '';
    viewer.style.background = '';
    viewer.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    if (!_ivTouchReady) { _ivInitTouch(); _ivTouchReady = true; }
}

function closeImgViewer() {
    const viewer = document.getElementById('img-viewer');
    if (!viewer) return;
    viewer.style.display = 'none';
    document.body.style.overflow = '';
    _ivScale = 1; _ivTx = 0; _ivTy = 0;
}

function _ivApply(animate) {
    const img = document.getElementById('img-viewer-img');
    if (!img) return;
    img.style.transition = animate ? 'transform 0.2s ease' : 'none';
    img.style.transform = `translate(${_ivTx}px,${_ivTy}px) scale(${_ivScale})`;
}

function _ivPinchDist(t) {
    return Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY);
}

function _ivInitTouch() {
    const wrap = document.getElementById('img-viewer-wrap');
    if (!wrap) return;

    wrap.addEventListener('touchstart', e => {
        e.preventDefault();
        const t = e.touches;
        _ivDismissStart = null;
        if (t.length === 2) {
            _ivPinchDist0 = _ivPinchDist(t);
            _ivPrevScale = _ivScale;
            _ivPanOrigin = null;
        } else if (t.length === 1) {
            const now = Date.now();
            if (now - _ivLastTap < 280) {
                // Double-tap: toggle 1x ↔ 2.5x
                _ivLastTap = 0;
                _ivScale = _ivScale > 1.2 ? 1 : 2.5;
                _ivTx = 0; _ivTy = 0;
                _ivApply(true);
                return;
            }
            _ivLastTap = now;
            _ivPanOrigin = { x: t[0].pageX, y: t[0].pageY, tx: _ivTx, ty: _ivTy };
            if (_ivScale <= 1.05) _ivDismissStart = { y: t[0].pageY };
        }
    }, { passive: false });

    wrap.addEventListener('touchmove', e => {
        e.preventDefault();
        const t = e.touches;
        const viewer = document.getElementById('img-viewer');
        if (t.length === 2 && _ivPinchDist0) {
            const d = _ivPinchDist(t);
            _ivScale = Math.max(1, Math.min(4, _ivPrevScale * (d / _ivPinchDist0)));
            if (_ivScale <= 1) { _ivTx = 0; _ivTy = 0; }
            _ivApply(false);
        } else if (t.length === 1 && _ivPanOrigin) {
            const dx = t[0].pageX - _ivPanOrigin.x;
            const dy = t[0].pageY - _ivPanOrigin.y;
            if (_ivDismissStart && _ivScale <= 1.05) {
                _ivTy = dy;
                _ivApply(false);
                const progress = Math.min(1, Math.abs(dy) / 220);
                if (viewer) viewer.style.background = `rgba(0,0,0,${0.95 - progress * 0.75})`;
            } else if (_ivScale > 1.05) {
                _ivTx = _ivPanOrigin.tx + dx;
                _ivTy = _ivPanOrigin.ty + dy;
                _ivApply(false);
            }
        }
    }, { passive: false });

    wrap.addEventListener('touchend', e => {
        e.preventDefault();
        const viewer = document.getElementById('img-viewer');
        if (_ivDismissStart && _ivScale <= 1.05 && Math.abs(_ivTy) > 90) {
            closeImgViewer();
            return;
        }
        if (_ivDismissStart && _ivTy !== 0) {
            _ivTy = 0;
            if (viewer) viewer.style.background = '';
            _ivApply(true);
        }
        if (_ivScale < 1) { _ivScale = 1; _ivTx = 0; _ivTy = 0; _ivApply(true); }
        _ivPinchDist0 = 0;
        _ivDismissStart = null;
    }, { passive: false });
}
