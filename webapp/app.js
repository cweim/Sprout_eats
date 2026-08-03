// Configuration
const API_URL = ''; // Set to your API URL, e.g., 'http://localhost:8000'

// Group map context — set when mini app is opened with ?group_id=<chat_id>
const _urlParams = new URLSearchParams(window.location.search);
const GROUP_ID = _urlParams.get('group_id') ? parseInt(_urlParams.get('group_id'), 10) : null;
const BOT_USERNAME = _urlParams.get('bot') || '';
const IS_GROUP_MAP = !!GROUP_ID;

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
    if (IS_GROUP_MAP) url = `${API_URL}/api/groups/${GROUP_ID}/places?page=1&per_page=${PLACES_PER_PAGE}`;
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
        if (IS_GROUP_MAP) endpoint = `${API_URL}/api/groups/${GROUP_ID}/places?page=${nextPage}&per_page=${PLACES_PER_PAGE}`;
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
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    // Plain layer group — no clustering, markers always visible
    markersLayer = L.layerGroup().addTo(map);

    // Friend activity layer — separate from user's own markers
    friendMarkersLayer = L.layerGroup().addTo(map);

    map.on('zoomend', () => {
        updatePlacePreviewVisibility();
        updateMarkerIconSizes();
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
    const types = typesString.split(',')
        .slice(0, 2)
        .map(t => t.trim().replace(/_/g, ' '))
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

    // ── Photo banner ───────────────────────────────────────────────────────
    if (photos.length === 1) {
        html += `<div class="popup-photo-banner" style="background-image:url('${photos[0].url}');cursor:pointer" onclick="openPopupPhotoViewer(${place.id},0)"></div>`;
    } else if (photos.length === 2) {
        html += `<div class="popup-photo-grid popup-photo-grid--2">
            <div class="popup-photo-cell" style="background-image:url('${photos[0].url}');cursor:pointer" onclick="openPopupPhotoViewer(${place.id},0)"></div>
            <div class="popup-photo-cell" style="background-image:url('${photos[1].url}');cursor:pointer" onclick="openPopupPhotoViewer(${place.id},1)"></div>
        </div>`;
    } else if (photos.length >= 3) {
        const extra = photos.length - 3;
        html += `<div class="popup-photo-grid popup-photo-grid--3">
            <div class="popup-photo-cell popup-photo-main" style="background-image:url('${photos[0].url}');cursor:pointer" onclick="openPopupPhotoViewer(${place.id},0)"></div>
            <div class="popup-photo-side">
                <div class="popup-photo-cell" style="background-image:url('${photos[1].url}');cursor:pointer" onclick="openPopupPhotoViewer(${place.id},1)"></div>
                <div class="popup-photo-cell${extra > 0 ? ' popup-photo-has-more' : ''}" style="background-image:url('${photos[2].url}');cursor:pointer" onclick="${extra > 0 ? `openRestaurantCard(${place.id})` : `openPopupPhotoViewer(${place.id},2)`}">
                    ${extra > 0 ? `<div class="popup-photo-more">+${extra}</div>` : ''}
                </div>
            </div>
        </div>`;
    }

    html += `<div class="popup-body">`;

    // ── Name (hero) ────────────────────────────────────────────────────────
    html += `<div class="place-popup-name">${escapeHtml(place.name)}</div>`;

    if (isReviewed) {
        // ── REVIEWED ──────────────────────────────────────────────────────
        const sentEmoji = review ? (SENTIMENT_EMOJI[review.sentiment] || '✍️') : '✓';
        const sentLabel = review ? ({ loved: 'Loved it', okay: 'It was okay', meh: 'Meh' }[review.sentiment] || '') : 'Visited';

        // Sentiment row
        html += `<div class="popup-info-row popup-sentiment-row">${sentEmoji} <strong>${sentLabel}</strong></div>`;

        // Score chips
        if (review && (review.food_score || review.vibe_score || review.value_score)) {
            html += `<div class="popup-scores">`;
            if (review.food_score)  html += `<span class="popup-score-chip">Food <b>${review.food_score}</b></span>`;
            if (review.vibe_score)  html += `<span class="popup-score-chip">Vibe <b>${review.vibe_score}</b></span>`;
            if (review.value_score) html += `<span class="popup-score-chip">Value <b>${review.value_score}</b></span>`;
            html += `</div>`;
        }

        // Dish chips
        const dishes = review?.dishes || [];
        if (dishes.length > 0) {
            const MAX_VISIBLE = 3;
            const visible = dishes.slice(0, MAX_VISIBLE);
            const overflow = dishes.length - MAX_VISIBLE;
            html += `<div class="popup-dishes">`;
            visible.forEach(d => {
                const score = d.rating != null ? `<span class="popup-dish-score">${d.rating}</span>` : '';
                html += `<span class="popup-dish-chip">${escapeHtml(d.name)}${score}</span>`;
            });
            if (overflow > 0) {
                html += `<span class="popup-dish-chip popup-dish-chip--more">+${overflow}</span>`;
            }
            html += `</div>`;
        }

        // Address row
        if (place.address) {
            html += `<div class="popup-info-row popup-info-muted">📍 ${escapeHtml(place.address)}</div>`;
        }

        // Opening hours
        html += buildPopupHoursHtml(place);

        // Caption
        const caption = review ? (review.caption || review.overall_remarks || '') : '';
        if (caption) {
            html += `<div class="popup-caption">"${escapeHtml(caption)}"</div>`;
        }

        // Primary CTA
        if (!IS_SHARE_MAP) {
            html += `<button class="popup-primary-btn" onclick="openRestaurantCard(${place.id})">View</button>`;
        }

    } else {
        // ── UNREVIEWED ────────────────────────────────────────────────────

        // Google meta row: rating · price · type
        const metaParts = [];
        if (place.place_rating) {
            const cnt = place.place_rating_count ? ` (${place.place_rating_count})` : '';
            metaParts.push(`⭐ ${place.place_rating}${cnt}`);
        }
        if (place.place_price_level && PLACE_PRICE_LABELS[place.place_price_level]) {
            metaParts.push(PLACE_PRICE_LABELS[place.place_price_level]);
        }
        const types = formatPlaceTypes(place.place_types);
        if (types) metaParts.push(types);
        if (metaParts.length) {
            html += `<div class="popup-info-row popup-info-muted">${metaParts.join(' · ')}</div>`;
        }

        // Address row
        if (place.address) {
            html += `<div class="popup-info-row popup-info-muted">📍 ${escapeHtml(place.address)}</div>`;
        }

        // Distance row
        const dist = getPlaceDistance(place);
        if (dist !== null) {
            html += `<div class="popup-info-row popup-info-muted">🗺 ${formatDistance(dist)} away</div>`;
        }

        // Opening hours
        html += buildPopupHoursHtml(place);

        // Description
        if (place.place_description) {
            html += `<div class="popup-caption">${escapeHtml(place.place_description)}</div>`;
        }

        // Primary CTA
        if (!IS_SHARE_MAP) {
            html += `<button class="popup-primary-btn popup-primary-btn--cta" onclick="openBeenHereSheet(${place.id})">Been here? Add review</button>`;
        }
    }

    // ── Secondary actions row: Maps · Reel · Delete ────────────────────────
    const secParts = [];

    if (place.google_place_id) {
        const encodedName = encodeURIComponent(place.name);
        secParts.push(`<a href="https://www.google.com/maps/search/?api=1&query=${encodedName}&query_place_id=${place.google_place_id}" target="_blank" class="popup-sec-btn">Maps</a>`);
    } else if (place.latitude && place.longitude) {
        secParts.push(`<a href="https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}" target="_blank" class="popup-sec-btn">Maps</a>`);
    }
    if (place.source_url) {
        secParts.push(`<a href="${safeUrl(place.source_url)}" target="_blank" class="popup-sec-btn">Reel</a>`);
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


function focusMarkerWithPopup(marker, latlng, zoom = 15) {
    if (!map || !marker) return;

    const targetCenter = getPopupFocusedLatLng(latlng, zoom);
    map.setView(targetCenter, zoom, { animate: true });
    setTimeout(() => marker.openPopup(), 220);
}

function getSpeechBubbleOffset(zoom) {
    // Position tip ~1px above the top of the marker at any zoom tier
    const sz = zoom < 15 ? 30 : zoom < 18 ? 40 : 52;
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
            offset: getSpeechBubbleOffset(zoom),
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
// zoom < 10     → tiny dot (hollow = unvisited, filled = visited)
// zoom 10–14   → medium circle / score badge (36px)
// zoom >= 15   → large circle / score badge (44px)
function getMarkerIconForZoom(zoom, place) {
    const isVisited = place.is_visited;
    const score = isVisited ? computePlaceScore(getPlaceReview(place.id)) : null;

    if (zoom < 10) {
        const bg     = isVisited ? '#7CB98E' : 'transparent';
        const border = isVisited ? '2px solid #7CB98E' : '2px solid #A8D58A';
        return L.divIcon({
            className: '',
            html: `<div class="marker-dot" style="background:${bg};border:${border};box-sizing:border-box"></div>`,
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

    let innerHtml;
    if (isVisited) {
        // Green filled circle with white checkmark
        innerHtml = `<div class="score-marker-dot" style="width:${sz}px;height:${sz}px;background:#7CB98E;border:2px solid #5a9a70;box-sizing:border-box;display:flex;align-items:center;justify-content:center;">
            <svg width="${iconSz}" height="${iconSz}" viewBox="0 0 10 10" fill="none">
                <polyline points="2,5 4.5,7.5 8,3" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>`;
    } else {
        // White circle with sprout character PNG (white bg blends with circle)
        const imgSz = Math.round(sz * 0.82);
        innerHtml = `<div class="score-marker-dot" style="width:${sz}px;height:${sz}px;background:white;border:2px solid #A8D58A;box-sizing:border-box;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:50%;">
            <img src="/images/white_bg_unvisited_icon.png" width="${imgSz}" height="${imgSz}" style="display:block;" draggable="false"/>
        </div>`;
    }

    return L.divIcon({
        className: '',
        html: innerHtml,
        iconSize: [sz, sz],
        iconAnchor: [sz / 2, sz / 2],
        popupAnchor: [0, -(sz / 2 + 2)]
    });
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

    // Apply open now filter for map
    filteredPlaces = filterByOpenNow(filteredPlaces);

    // Update cuisine dropdown options
    populateCuisineDropdown();

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
            displayPlacesOnMap(false);
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
            displayPlacesOnMap(false);
        });
    });

    // Cuisine type filter
    const cuisineSelect = document.getElementById('map-cuisine-filter');
    if (cuisineSelect) {
        cuisineSelect.addEventListener('change', (e) => {
            mapCuisineFilter = e.target.value;
            displayPlacesOnMap(false);
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
    const platform = place.source_platform;

    const platformBadge = platform === 'instagram'
        ? '<span class="pcard-platform" title="From Instagram">📸</span>'
        : platform === 'tiktok'
        ? '<span class="pcard-platform" title="From TikTok">🎵</span>'
        : '';

    let statusBadge = '';
    if (place.is_visited) {
        const visitDate = place.visited_at ? formatShortDate(place.visited_at) : '';
        const sentimentDisplay = review ? (SENTIMENT_EMOJI[review.sentiment] || '') : '';
        statusBadge = `<span class="pcard-status pcard-status-visited">✓${visitDate ? ' ' + visitDate : ''}</span>`;
        if (sentimentDisplay) statusBadge += `<span class="pcard-user-rating">${sentimentDisplay}</span>`;
    } else {
        statusBadge = `<span class="pcard-status pcard-status-wishlist">🌱 To visit</span>`;
    }

    let meta = '';
    if (place.place_rating) {
        const cnt = place.place_rating_count ? ` (${Number(place.place_rating_count).toLocaleString()})` : '';
        meta += `<span class="pcard-meta-item">⭐ ${place.place_rating}${cnt}</span>`;
    }
    if (place.place_price_level && PLACE_PRICE_LABELS[place.place_price_level]) {
        meta += `<span class="pcard-meta-item">${PLACE_PRICE_LABELS[place.place_price_level]}</span>`;
    }
    const types = formatPlaceTypes(place.place_types);
    if (types) meta += `<span class="pcard-meta-item pcard-type">${types}</span>`;

    const snippet = review?.overall_remarks
        ? `<p class="pcard-snippet">"${escapeHtml(review.overall_remarks.slice(0, 90))}${review.overall_remarks.length > 90 ? '…' : ''}"</p>`
        : (!place.is_visited && place.place_description
            ? `<p class="pcard-snippet pcard-desc">${escapeHtml(place.place_description.slice(0, 80))}${place.place_description.length > 80 ? '…' : ''}</p>`
            : '');

    const hoursHtml = !place.is_visited ? buildCardHoursHtml(place) : '';

    card.innerHTML = `
        <div class="pcard-top">
            <div class="pcard-name-row">
                ${platformBadge}
                <span class="pcard-name">${escapeHtml(place.name)}</span>
                <button class="pcard-more" onclick="event.stopPropagation(); openPlaceMenu(${place.id}, '${place.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')" aria-label="More options">···</button>
            </div>
            ${place.address ? `<p class="pcard-address">${escapeHtml(place.address)}</p>` : ''}
            ${meta ? `<div class="pcard-meta">${meta}</div>` : ''}
            ${snippet}
            ${hoursHtml}
        </div>
        <div class="pcard-bottom">
            <div class="pcard-status-row">${statusBadge}</div>
            ${!place.is_visited
                ? `<button class="pcard-log-btn" onclick="event.stopPropagation(); openRestaurantCard(${place.id})">Log visit →</button>`
                : `<button class="pcard-log-btn pcard-log-btn-edit" onclick="event.stopPropagation(); openRestaurantCard(${place.id})">View →</button>`}
        </div>`;

    card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
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
        const res = await fetch(`${API_URL}/api/groups/${GROUP_ID}/places/${placeId}/visited`, { method: 'PATCH' });
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
            const res = await fetch(`/api/groups/${GROUP_ID}/places/${placeId}/reviews`);
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

function sharePlace(placeId) {
    const place = places.find(p => p.id === placeId);
    if (!place) return;

    const mapsUrl = place.google_place_id
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${place.google_place_id}`
        : `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}`;

    // Shorten address to city/area (first 2 comma-parts) to keep message compact
    const shortAddress = place.address
        ? place.address.split(',').slice(0, 2).join(',').trim()
        : null;

    // Option A: all links inline with labels, no floating url param
    const lines = [`🍽️ ${place.name}`];
    if (shortAddress) lines.push(`📍 ${shortAddress}`);
    lines.push('');
    lines.push(`🗺️ ${mapsUrl}`);
    if (place.source_url) lines.push(`🎬 ${place.source_url}`);
    lines.push('');
    lines.push('Saved on Sprout 🌱 | @sprout_eats_bot');
    const text = lines.join('\n');

    // No url param — everything in text so layout is fully controlled
    const tgUrl = `https://t.me/share/url?url=&text=${encodeURIComponent(text)}`;
    if (window.Telegram?.WebApp?.openTelegramLink) {
        window.Telegram.WebApp.openTelegramLink(tgUrl);
    } else if (navigator.share) {
        navigator.share({ title: place.name, text, url: mapsUrl }).catch(() => {});
    } else {
        window.open(tgUrl, '_blank');
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
        if (currentMenuPlaceId) {
            const card = document.querySelector(`.place-card[data-place-id="${currentMenuPlaceId}"]`);
            if (card) {
                startPlaceEdit(currentMenuPlaceId, card);
            }
        }
        closePlaceMenu();
    });

    document.getElementById('menu-delete').addEventListener('click', () => {
        if (currentMenuPlaceId && currentMenuPlaceName) {
            const placeId = currentMenuPlaceId;
            const placeName = currentMenuPlaceName;
            closePlaceMenu();
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

        if (wishlist.length > 0) listContainer.appendChild(buildListSection('wishlist', 'Want to Go', wishlist, createPersonalPlaceCard));
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

// Filter places by search query (searches name, address, notes, types)
function filterBySearch(placesToFilter) {
    if (!searchQuery.trim()) return placesToFilter;

    const query = searchQuery.toLowerCase().trim();
    return placesToFilter.filter(place => {
        // Search across name, address, notes, and types
        const searchFields = [
            place.name,
            place.address,
            place.notes,
            place.place_types
        ].filter(Boolean).map(s => s.toLowerCase());

        return searchFields.some(field => field.includes(query));
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
    return `<div class="popup-hours-row" onclick="toggleHoursDropdown('${dropId}')">
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
    displayPlacesOnMap(false);
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
            displayPlacesOnMap(false);  // Don't change map bounds
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
    displayPlacesOnMap(false);
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
        const sortLabels = { newest: 'Newest', name: 'A-Z', rating: 'Top Rated' };
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
    displayPlacesOnMap(false);
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

    // Apply theme immediately
    applyTheme();

    // Setup view toggle
    setupViewToggle();

    // Global Escape key handler — close whichever overlay is open
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (document.getElementById('photo-viewer')?.style.display === 'flex') { closePhotoViewer(); return; }
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
        return;
    }

    // Prefer a zoomed-in user-centric map on first load when location is available.
    // Fall back to the previous "fit all places" overview if geolocation is unavailable.
    const initialLocation = await requestUserLocation(true);
    // Reviews must be loaded before map markers are created so popup content
    // correctly shows the reviewed vs un-reviewed card on first render.
    await loadReviews();

    displayPlacesOnMap(!initialLocation);

    ensurePlacesUiInitialized();

    // Render list view
    renderPlacesList(places);

    // Update all filter counts
    updateMapFilterCounts();
    updateVisitedChipCounts();

    if (IS_SHARE_MAP) {
        showShareBanner();
    }


    // Show saved tab by default (main home screen)
    switchTab('saved');

    // Load friend request badge in background
    loadFriendRequests();

    // Handle Telegram startapp deep link param
    const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param
        || new URLSearchParams(window.location.search).get('startapp');
    if (startParam) {
        if (startParam.startsWith('review_')) {
            const placeId = parseInt(startParam.slice('review_'.length));
            if (!isNaN(placeId)) {
                setTimeout(() => openReviewSheet(placeId), 300);
            }
        } else if (startParam.startsWith('place_')) {
            const placeId = parseInt(startParam.slice('place_'.length));
            if (!isNaN(placeId)) {
                markersLayer.eachLayer(marker => {
                    if (marker.placeData && marker.placeData.id === placeId) {
                        map.setView(marker.getLatLng(), 16);
                        marker.openPopup();
                    }
                });
            }
        }
    }
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
    return {
        sentiment,
        food_score: foodScore,
        vibe_score: vibeScore,
        value_score: valueScore,
        caption,
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

function resetPendingReviewPhotos() {
    pendingOverallPhotos = [];
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
}

// ========== PHOTO VIEWER ==========

let photoViewerPhotos = [];
let photoViewerIndex = 0;
let photoViewerEditMode = false;

function openPopupPhotoViewer(placeId, index) {
    const review = getPlaceReview(placeId);
    const photos = review?.overall_photos || [];
    if (photos.length === 0) return;
    openPhotoViewer(photos, index, false);
}

function openPhotoViewer(photos, startIndex = 0, allowDelete = false) {
    if (!photos || photos.length === 0) return;

    photoViewerPhotos = photos;
    photoViewerIndex = startIndex;
    photoViewerEditMode = allowDelete;

    const viewer = document.getElementById('photo-viewer');
    _prevFocusEl = document.activeElement;
    viewer.style.display = 'flex';
    viewer._trapFocusCleanup = trapFocus(viewer);
    viewer.classList.toggle('view-mode', !allowDelete);

    updatePhotoViewer();
    document.getElementById('photo-viewer-close').focus();
    hapticFeedback('light');
}

function closePhotoViewer() {
    const viewer = document.getElementById('photo-viewer');
    viewer._trapFocusCleanup?.();
    viewer.style.display = 'none';
    photoViewerPhotos = [];
    photoViewerIndex = 0;
    _prevFocusEl?.focus();
    _prevFocusEl = null;
}

function updatePhotoViewer() {
    const photo = photoViewerPhotos[photoViewerIndex];
    if (!photo) return;

    document.getElementById('photo-viewer-img').src = photo.url || photo.previewUrl;
    document.getElementById('photo-viewer-counter').textContent =
        `${photoViewerIndex + 1} / ${photoViewerPhotos.length}`;

    // Enable/disable nav buttons
    document.getElementById('photo-viewer-prev').disabled = photoViewerIndex === 0;
    document.getElementById('photo-viewer-next').disabled = photoViewerIndex === photoViewerPhotos.length - 1;
}

function photoViewerPrev() {
    if (photoViewerIndex > 0) {
        photoViewerIndex--;
        updatePhotoViewer();
        hapticFeedback('light');
    }
}

function photoViewerNext() {
    if (photoViewerIndex < photoViewerPhotos.length - 1) {
        photoViewerIndex++;
        updatePhotoViewer();
        hapticFeedback('light');
    }
}

async function photoViewerDelete() {
    const photo = photoViewerPhotos[photoViewerIndex];
    if (!photo) return;

    if (!confirm('Delete this photo?')) return;

    hapticFeedback('medium');

    let deleted = false;
    if (photo.pending) {
        removePendingPhoto(photo.localId, photo._dishId || null);
        deleted = true;
    } else if (currentReview?.id) {
        deleted = await deletePhoto(currentReview.id, photo.id);
    }

    if (deleted) {
        // Remove from array
        photoViewerPhotos.splice(photoViewerIndex, 1);

        if (photoViewerPhotos.length === 0) {
            closePhotoViewer();
            // Refresh photo grid
            const overallPhotosGrid = document.getElementById('overall-photos');
            if (overallPhotosGrid) {
                updatePhotoGrid(overallPhotosGrid, [...(currentReview?.overall_photos || []), ...getPendingPhotos()], 10, null);
            }
        } else {
            if (photoViewerIndex >= photoViewerPhotos.length) {
                photoViewerIndex = photoViewerPhotos.length - 1;
            }
            updatePhotoViewer();
        }
    }
}

// Setup photo viewer swipe gestures
function setupPhotoViewerGestures() {
    const body = document.getElementById('photo-viewer')?.querySelector('.photo-viewer-body');
    if (!body) return;

    let startX = 0;
    let startY = 0;

    body.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    });

    body.addEventListener('touchend', (e) => {
        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const diffX = endX - startX;
        const diffY = endY - startY;

        // Only swipe if horizontal movement is greater than vertical
        if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 50) {
            if (diffX > 0) {
                photoViewerPrev();
            } else {
                photoViewerNext();
            }
        }
    });
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
        closeReviewSheet();

        await loadReviews();
        applyFilters();
        displayPlacesOnMap(false);

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
function updatePhotoGrid(container, photos, maxPhotos, dishId = null) {
    container.innerHTML = '';

    // Add existing photos
    photos.forEach((photo, index) => {
        const thumb = document.createElement('div');
        thumb.className = 'photo-thumb';
        thumb.dataset.photoId = photo.id || photo.localId;
        thumb.innerHTML = `
            <img src="${photo.url || photo.previewUrl}" alt="Photo">
            <button type="button" class="photo-delete-btn" aria-label="Remove photo">×</button>
        `;

        // Delete handler
        thumb.querySelector('.photo-delete-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (photo.pending) {
                removePendingPhoto(photo.localId);
                const remaining = photos.filter(p => (p.id || p.localId) !== photo.localId);
                updatePhotoGrid(container, remaining, maxPhotos, dishId);
                return;
            }

            if (!currentReview?.id) return;
            if (await deletePhoto(currentReview.id, photo.id)) {
                thumb.remove();
                // Show add button if under limit
                if (container.querySelectorAll('.photo-thumb').length < maxPhotos) {
                    const savedRemaining = photos.filter(p => p.id !== photo.id);
                    addPhotoButton(container, savedRemaining, maxPhotos, dishId);
                }
            }
        });

        // Tap to view full size with swipe
        thumb.querySelector('img').addEventListener('click', () => {
            openPhotoViewer(photos.map(p => ({ ...p, _dishId: dishId })), index, true);
        });

        container.appendChild(thumb);
    });

    // Add "+" button if under limit
    if (photos.length < maxPhotos) {
        addPhotoButton(container, photos.filter(p => !p.pending), maxPhotos, dishId);
    }
}

/**
 * Add photo upload button to grid
 */
function addPhotoButton(container, savedPhotos, maxPhotos, dishId) {
    // Don't add if already at limit or button exists
    if (container.querySelector('.photo-add-btn')) return;
    if (container.querySelectorAll('.photo-thumb').length >= maxPhotos) return;

    const label = document.createElement('label');
    label.className = 'photo-add-btn';
    label.setAttribute('aria-label', 'Add photo');
    label.innerHTML = `
        <input type="file" accept="image/*" hidden aria-label="Upload photo">
        <span>+</span>
    `;

    label.querySelector('input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Validate file before showing placeholder
        const validation = validateImageFile(file);
        if (!validation.valid) {
            showToast(validation.error);
            e.target.value = '';
            return;
        }
        await queuePendingPhoto(file);
        updatePhotoGrid(container, [...savedPhotos, ...getPendingPhotos()], maxPhotos, dishId);
        showToast('Photo ready to save');

        // Reset input
        e.target.value = '';
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

    // Setup photo viewer
    setupPhotoViewer();
}

function setupPhotoViewer() {
    document.getElementById('photo-viewer-close').addEventListener('click', closePhotoViewer);
    document.getElementById('photo-viewer-prev').addEventListener('click', photoViewerPrev);
    document.getElementById('photo-viewer-next').addEventListener('click', photoViewerNext);
    document.getElementById('photo-viewer-delete').addEventListener('click', photoViewerDelete);

    // Close on backdrop click
    document.getElementById('photo-viewer').addEventListener('click', (e) => {
        if (e.target.id === 'photo-viewer') {
            closePhotoViewer();
        }
    });

    // Setup swipe gestures
    setupPhotoViewerGestures();
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
    const timeAgo = formatTimeAgo(new Date(review.updated_at || review.created_at));

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
            thumb.addEventListener('click', (e) => {
                e.stopPropagation();
                openPhotoViewer(allPhotos, index, false);
                hapticFeedback('light');
            });
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

// Format time ago helper
function formatTimeAgo(date) {
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} week${Math.floor(days / 7) > 1 ? 's' : ''} ago`;
    if (days < 365) return `${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? 's' : ''} ago`;
    return date.toLocaleDateString();
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

    // Update nav tab active state
    document.querySelectorAll('.nav-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Page title + header visibility (hidden on Saved for full-bleed)
    const titles = { home: 'sprout', discover: 'Discover', saved: 'Saved', profile: 'Profile' };
    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.textContent = titles[tab] || 'sprout';
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
        if (map) {
            setTimeout(() => map.invalidateSize(), 100);
            loadFriendMapActivity();
        }
    } else if (tab === 'home') {
        loadFeed();
    } else if (tab === 'profile') {
        loadProfile();
    }
}

function switchSavedView(view) {
    currentView = view;
    document.getElementById('list-view')?.classList.toggle('active', view === 'list');
    document.getElementById('map-view')?.classList.toggle('active', view === 'map');
    updateSavedToggleIcon(view);
    if (view === 'map' && map) {
        setTimeout(() => map.invalidateSize(), 100);
        loadFriendMapActivity();
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
            const timeAgo = formatTimeAgo(new Date(act.created_at));
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

// ========== FEED ==========

async function loadFeed() {
    const list = document.getElementById('feed-list');
    const loading = document.getElementById('feed-loading');
    const empty = document.getElementById('feed-empty');
    if (!list) return;

    if (loading) loading.style.display = '';
    if (empty) empty.style.display = 'none';
    list.innerHTML = '';

    try {
        const res = await fetch('/api/feed', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error('Failed to load feed');
        const data = await res.json();
        const activities = data.activities || [];

        if (loading) loading.style.display = 'none';

        if (activities.length === 0) {
            if (empty) empty.style.display = '';
            return;
        }

        list.innerHTML = activities.map(a => createFeedCard(a)).join('');
    } catch (err) {
        console.error('loadFeed error:', err);
        if (loading) loading.style.display = 'none';
        if (list) list.innerHTML = '<p style="padding:16px;color:var(--hint-color)">Could not load feed.</p>';
    }
}

function createFeedCard(activity) {
    const meta = activity.metadata || {};
    const actor = activity.actor_name || activity.actor_username || 'Friend';
    const actorInitials = actor.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
    const placeName = meta.place_name || 'a place';
    const address   = meta.address   || '';
    const sentiment = meta.sentiment || null;
    const remarks   = meta.remarks   || '';
    const timeAgo   = formatTimeAgo(activity.created_at);
    const gid       = meta.google_place_id || '';

    const likesCount = activity.likes_count || 0;
    const userLiked  = activity.user_liked  || false;

    let verb = 'checked out';
    if (activity.activity_type === 'visited')  verb = 'visited';
    if (activity.activity_type === 'reviewed') verb = 'reviewed';
    if (activity.activity_type === 'saved')    verb = 'saved';

    const sentimentLabel = { loved: 'Loved it', okay: 'It was okay', meh: 'Meh' };
    const sentimentHtml = sentiment
        ? `<div><span class="fc-sentiment">${SENTIMENT_EMOJI[sentiment]} ${sentimentLabel[sentiment]}</span></div>`
        : '';
    const captionHtml = remarks
        ? `<p class="fc-caption">"${escapeHtml(remarks)}"</p>`
        : '';
    const addrHtml = address
        ? `<p class="fc-address">${escapeHtml(address)}</p>`
        : '';

    const cardId = `fc-${activity.id}`;
    return `
        <div class="fc" id="${cardId}" onclick="onFeedCardTap('${gid}', '${escapeHtml(placeName)}')">
            <div class="fc-header">
                <div class="fc-avatar">${actorInitials}</div>
                <div class="fc-actor-block">
                    <span class="fc-actor">${escapeHtml(actor)}</span>
                    <span class="fc-meta">${verb} · ${timeAgo}</span>
                </div>
            </div>
            <div class="fc-place-block">
                <p class="fc-place-name">${escapeHtml(placeName)}</p>
                ${addrHtml}
            </div>
            ${sentimentHtml}
            ${captionHtml}
            <div class="fc-actions">
                <button class="fc-like-btn ${userLiked ? 'liked' : ''}"
                    data-liked="${userLiked}"
                    onclick="event.stopPropagation(); likeActivity(${activity.id}, this)"
                    aria-label="Like">
                    ${userLiked ? '❤️' : '🤍'} <span class="like-count">${likesCount > 0 ? likesCount : ''}</span>
                </button>
            </div>
        </div>`;
}

function formatTimeAgo(isoStr) {
    if (!isoStr) return '';
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}

// ========== PROFILE ==========

let profileData = null;

async function loadProfile() {
    try {
        const res = await fetch('/api/me', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error('Failed to load profile');
        profileData = await res.json();
        renderProfile(profileData);
        await loadFriends();
        await loadFriendRequests();
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
    const reviewsEl = document.getElementById('stat-reviews');
    if (savedEl) savedEl.textContent = stats.saved ?? '—';
    if (visitedEl) visitedEl.textContent = stats.visited ?? '—';
    if (reviewsEl) reviewsEl.textContent = stats.reviews ?? '—';

    renderMyVisits();
}

function renderMyVisits() {
    const section = document.getElementById('my-visits-section');
    const listEl = document.getElementById('my-visits-list');
    if (!section || !listEl) return;

    const visited = (places || []).filter(p => p.is_visited);
    if (visited.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = '';
    // Sort newest first by visited_at
    const sorted = [...visited].sort((a, b) => {
        const ta = a.visited_at ? new Date(a.visited_at).getTime() : 0;
        const tb = b.visited_at ? new Date(b.visited_at).getTime() : 0;
        return tb - ta;
    });

    listEl.innerHTML = sorted.slice(0, 10).map(place => {
        const review = getPlaceReview(place.id);
        const sentiment = review?.sentiment || null;
        const caption = review?.caption || review?.overall_remarks || '';
        const dateStr = place.visited_at ? formatShortDate(place.visited_at) : '';
        const sentimentEmoji = sentiment ? SENTIMENT_EMOJI[sentiment] : '';
        const captionDisplay = caption ? caption.slice(0, 60) + (caption.length > 60 ? '…' : '') : place.address || '';
        return `
            <div class="visit-item" onclick="openBeenHereSheet(${place.id})">
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
}

// ========== FRIENDS ==========

async function loadFriends() {
    const listEl = document.getElementById('friends-list');
    const emptyEl = document.getElementById('friends-empty');
    const countEl = document.getElementById('friends-count');
    if (!listEl) return;

    try {
        const res = await fetch('/api/friends', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const friends = data.friends || [];

        if (countEl) countEl.textContent = friends.length > 0 ? friends.length : '';

        // Remove existing friend cards (keep empty message)
        listEl.querySelectorAll('.friend-card').forEach(el => el.remove());

        if (friends.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
        } else {
            if (emptyEl) emptyEl.style.display = 'none';
            friends.forEach(f => {
                const name = f.display_name || f.first_name || 'Friend';
                const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
                const card = document.createElement('div');
                card.className = 'friend-card';
                card.innerHTML = `
                    <div class="friend-avatar-circle">${initials}</div>
                    <div class="friend-card-info">
                        <p class="friend-card-name">${escapeHtml(name)}</p>
                        ${f.username ? `<p class="friend-card-username">@${escapeHtml(f.username)}</p>` : ''}
                    </div>
                    <button class="btn-icon-sm btn-danger-sm" onclick="removeFriend(${f.friendship_id})" aria-label="Remove friend">✕</button>`;
                listEl.appendChild(card);
            });
        }
    } catch (err) {
        console.error('loadFriends error:', err);
    }
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

        // Update banner in profile view
        const banner = document.getElementById('friend-requests-banner');
        const label = document.getElementById('friend-requests-label');
        if (banner && label) {
            if (requests.length > 0) {
                label.textContent = `${requests.length} friend request${requests.length > 1 ? 's' : ''}`;
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
        await loadFriends();
    } catch (err) {
        console.error('removeFriend error:', err);
    }
}

// ========== ADD FRIEND MODAL ==========

let friendSearchTimeout = null;

function openAddFriendModal() {
    const modal = document.getElementById('add-friend-modal');
    if (modal) {
        modal.style.display = 'flex';
        document.getElementById('friend-search-input')?.focus();
    }
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
}

function searchFriends(query) {
    clearTimeout(friendSearchTimeout);
    if (!query || query.trim().length < 2) {
        document.getElementById('friend-search-results').innerHTML = '';
        document.getElementById('friend-search-empty').style.display = 'none';
        return;
    }
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

        resultsEl.innerHTML = users.map(u => `
            <div class="friend-result-card">
                <div class="friend-info">
                    <p class="friend-name">${escapeHtml(u.display_name || u.first_name || 'User')}</p>
                    ${u.username ? `<p class="friend-username">@${escapeHtml(u.username)}</p>` : ''}
                </div>
                <button class="btn-secondary-sm" onclick="sendFriendRequest(${u.id}, this)"
                    ${u.friendship_status ? 'disabled' : ''}>
                    ${u.friendship_status === 'accepted' ? 'Friends' :
                      u.friendship_status === 'pending' ? 'Requested' :
                      u.friendship_status === 'incoming_request' ? 'Accept' : 'Add'}
                </button>
            </div>`).join('');
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
            body: JSON.stringify({ addressee_id: userId })
        });
    } catch (err) {
        console.error('sendFriendRequest error:', err);
        if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
    }
}

// ========== FRIEND REQUESTS MODAL ==========

function showFriendRequests() {
    const modal = document.getElementById('friend-requests-modal');
    if (modal) modal.style.display = 'flex';
    loadFriendRequestsModal();
}

function closeFriendRequestsModal() {
    const modal = document.getElementById('friend-requests-modal');
    if (modal) modal.style.display = 'none';
}

async function loadFriendRequestsModal() {
    const listEl = document.getElementById('friend-requests-list');
    if (!listEl) return;

    try {
        const res = await fetch('/api/friends/requests', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const requests = data.requests || [];

        if (requests.length === 0) {
            listEl.innerHTML = '<p style="padding:16px;color:var(--hint-color)">No pending requests.</p>';
            return;
        }

        listEl.innerHTML = requests.map(r => `
            <div class="friend-request-card" id="req-${r.friendship_id}">
                <div class="friend-info">
                    <p class="friend-name">${escapeHtml(r.display_name || r.first_name || 'User')}</p>
                    ${r.username ? `<p class="friend-username">@${escapeHtml(r.username)}</p>` : ''}
                </div>
                <div class="request-actions">
                    <button class="btn-primary-sm" onclick="acceptFriendRequest(${r.friendship_id})">Accept</button>
                    <button class="btn-secondary-sm" onclick="declineFriendRequest(${r.friendship_id})">Decline</button>
                </div>
            </div>`).join('');
    } catch (err) {
        console.error('loadFriendRequestsModal error:', err);
    }
}

async function acceptFriendRequest(friendshipId) {
    try {
        await fetch(`/api/friends/${friendshipId}/accept`, { method: 'POST', headers: getAuthHeaders() });
        document.getElementById(`req-${friendshipId}`)?.remove();
        await loadFriends();
        await loadFriendRequests();
    } catch (err) {
        console.error('acceptFriendRequest error:', err);
    }
}

async function declineFriendRequest(friendshipId) {
    try {
        await fetch(`/api/friends/${friendshipId}`, { method: 'DELETE', headers: getAuthHeaders() });
        document.getElementById(`req-${friendshipId}`)?.remove();
        await loadFriendRequests();
    } catch (err) {
        console.error('declineFriendRequest error:', err);
    }
}

// ========== EDIT PROFILE ==========

function openEditProfile() {
    const modal = document.getElementById('edit-profile-modal');
    if (!modal) return;
    if (profileData) {
        const nameEl = document.getElementById('edit-display-name');
        const bioEl = document.getElementById('edit-bio');
        const publicEl = document.getElementById('edit-is-public');
        if (nameEl) nameEl.value = profileData.display_name || '';
        if (bioEl) bioEl.value = profileData.bio || '';
        if (publicEl) publicEl.checked = profileData.is_public ?? true;
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
    const isPublic = document.getElementById('edit-is-public')?.checked ?? true;

    try {
        const res = await fetch('/api/me', {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ display_name: displayName, bio, is_public: isPublic })
        });
        if (!res.ok) throw new Error('Failed to save');
        profileData = await res.json();
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
        const link = data.invite_link;

        if (navigator.share) {
            await navigator.share({ title: '🌱 Sprout', text: 'Add me on Sprout!', url: link });
        } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(link);
            alert('Invite link copied!');
        } else {
            prompt('Copy your invite link:', link);
        }
    } catch (err) {
        console.error('shareInviteLink error:', err);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// RESTAURANT CARD
// ═══════════════════════════════════════════════════════════════════════

let rcCurrentPlaceId = null;
let rcCurrentGoogleId = null;

async function openRestaurantCard(placeId) {
    rcCurrentPlaceId = placeId;

    const overlay = document.getElementById('restaurant-card-overlay');
    const sheet   = document.getElementById('restaurant-card');
    overlay.style.display = 'flex';
    sheet.classList.add('rc-open');

    // Render immediately from local state — no network round-trip needed
    const place = places.find(p => p.id === placeId);
    const review = getPlaceReview(placeId);

    // Reset friend list — reinject the empty-state element so it always exists in DOM
    document.getElementById('rc-friends-list').innerHTML =
        '<p class="rc-friends-empty" id="rc-friends-empty" style="display:none">None of your friends have been here yet.</p>';

    if (place) {
        try {
            renderRestaurantCard(place, review);
        } catch (e) {
            console.error('renderRestaurantCard error:', e);
            document.getElementById('rc-your-visit').innerHTML = '<p class="rc-loading">Error loading visit details</p>';
        }
        rcCurrentGoogleId = place.google_place_id || null;
        if (place.google_place_id) {
            loadRcFriendReviews(place.google_place_id);
        }
    } else {
        // Fallback: place not in local cache, fetch it
        document.getElementById('rc-name').textContent = '…';
        document.getElementById('rc-your-visit').innerHTML = '<p class="rc-loading">Loading…</p>';
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
            rcCurrentGoogleId = fetchedPlace.google_place_id || null;
            if (fetchedPlace.google_place_id) {
                loadRcFriendReviews(fetchedPlace.google_place_id);
            }
        } catch (e) {
            document.getElementById('rc-name').textContent = 'Error loading';
        }
    }
}

function renderRestaurantCard(place, review) {
    document.getElementById('rc-name').textContent = place.name || '';
    document.getElementById('rc-address').textContent = place.address || '';

    // Maps button
    const mapsBtn = document.getElementById('rc-maps-btn');
    if (place.google_place_id) {
        mapsBtn.onclick = () => window.open(
            `https://www.google.com/maps/place/?q=place_id:${place.google_place_id}`, '_blank'
        );
    } else if (place.latitude && place.longitude) {
        mapsBtn.onclick = () => window.open(
            `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}`, '_blank'
        );
    }

    // Meta row: rating (count) · price · type
    let meta = '';
    if (place.place_rating) {
        const cnt = place.place_rating_count ? ` <small>(${Number(place.place_rating_count).toLocaleString()})</small>` : '';
        meta += `<span class="rc-meta-chip">⭐ ${place.place_rating}${cnt}</span>`;
    }
    if (place.place_price_level && PLACE_PRICE_LABELS[place.place_price_level]) {
        meta += `<span class="rc-meta-chip">${PLACE_PRICE_LABELS[place.place_price_level]}</span>`;
    }
    const types = formatPlaceTypes(place.place_types);
    if (types) meta += `<span class="rc-meta-chip rc-type-chip">${types}</span>`;
    document.getElementById('rc-meta').innerHTML = meta;

    // Hours
    const hoursEl = document.getElementById('rc-hours');
    const hoursHtml = buildHoursHtml(place, 'rc');
    if (hoursHtml) {
        hoursEl.innerHTML = hoursHtml;
        hoursEl.style.display = '';
        hoursEl.className = 'rc-hours';
    } else {
        hoursEl.style.display = 'none';
    }

    // Description
    const descEl = document.getElementById('rc-description');
    if (place.place_description) {
        descEl.textContent = place.place_description;
        descEl.style.display = '';
    } else {
        descEl.style.display = 'none';
    }

    // Action buttons — Maps + Reel (same style as map popup)
    const sourceEl = document.getElementById('rc-source');
    const actionParts = [];
    if (place.google_place_id) {
        const encodedName = encodeURIComponent(place.name || '');
        actionParts.push(`<a href="https://www.google.com/maps/search/?api=1&query=${encodedName}&query_place_id=${place.google_place_id}" target="_blank" class="popup-sec-btn">Maps</a>`);
    } else if (place.latitude && place.longitude) {
        actionParts.push(`<a href="https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}" target="_blank" class="popup-sec-btn">Maps</a>`);
    }
    if (place.source_url) {
        actionParts.push(`<a href="${safeUrl(place.source_url)}" target="_blank" class="popup-sec-btn">Reel ↗</a>`);
    }
    if (actionParts.length) {
        sourceEl.innerHTML = actionParts.join('');
        sourceEl.style.display = '';
    } else {
        sourceEl.style.display = 'none';
    }

    // Personal notes
    const notesEl = document.getElementById('rc-notes');
    if (place.notes) {
        notesEl.innerHTML = `<span class="rc-notes-icon">📝</span><span class="rc-notes-text">${escapeHtml(place.notes)}</span>`;
        notesEl.style.display = '';
    } else {
        notesEl.style.display = 'none';
    }

    // Friends section — hide on share/group maps (no personal auth context)
    const friendsSection = document.getElementById('rc-friends-section');
    if (friendsSection) {
        friendsSection.style.display = (IS_SHARE_MAP || IS_GROUP_MAP) ? 'none' : '';
    }

    // Your visit section
    renderRcYourVisit(place, review);
}

function renderRcYourVisit(place, review) {
    const el = document.getElementById('rc-your-visit');

    if (!place.is_visited) {
        el.innerHTML = `
            <div class="rc-visit-cta">
                <p class="rc-visit-cta-text">Haven't been here yet?</p>
                <button class="rc-log-btn" onclick="openLogVisit(${place.id}, false)">
                    🌱 Log my visit
                </button>
            </div>`;
        return;
    }

    const visitDate = place.visited_at
        ? new Date(place.visited_at).toLocaleDateString('en-SG', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';

    let html = `<div class="rc-visit-logged">`;

    // Header: visited check + date + computed score badge
    const score = computePlaceScore(review);
    const scoreBadge = score !== null
        ? `<span class="rc-score-badge" style="background:${scoreMarkerColor(score)}">${score.toFixed(1)}</span>`
        : '';
    html += `<div class="rc-visit-header">
        <span class="rc-visit-check">✓ Visited${visitDate ? ` · <span class="rc-visit-date">${visitDate}</span>` : ''}</span>
        ${scoreBadge}
    </div>`;

    if (review) {
        // Sentiment
        const sentEmoji = SENTIMENT_EMOJI[review.sentiment] || '';
        const sentLabel = { loved: 'Loved it', okay: 'It was okay', meh: 'Meh' }[review.sentiment] || '';
        if (sentEmoji) {
            html += `<div class="rc-visit-sentiment">${sentEmoji} <strong>${sentLabel}</strong></div>`;
        }

        // Dimension scores
        if (review.food_score || review.vibe_score || review.value_score) {
            html += `<div class="rc-visit-scores">`;
            if (review.food_score)  html += `<span class="rc-score-chip">Food <b>${review.food_score}</b></span>`;
            if (review.vibe_score)  html += `<span class="rc-score-chip">Vibe <b>${review.vibe_score}</b></span>`;
            if (review.value_score) html += `<span class="rc-score-chip">Value <b>${review.value_score}</b></span>`;
            html += `</div>`;
        }

        // Photo grid (overall + dish photos combined)
        const allPhotos = [
            ...(review.overall_photos || []),
            ...((review.dishes || []).flatMap(d => d.photos || []))
        ];
        if (allPhotos.length > 0) {
            html += `<div class="rc-visit-photos">`;
            allPhotos.forEach((photo, i) => {
                html += `<div class="rc-visit-photo" style="background-image:url('${photo.url}')"
                    data-photo-index="${i}" role="button" tabindex="0" aria-label="View photo ${i + 1}"></div>`;
            });
            html += `</div>`;
        }

        // Dishes
        const dishes = review.dishes || [];
        if (dishes.length > 0) {
            html += `<div class="rc-visit-dishes">`;
            dishes.forEach(d => {
                html += `<div class="rc-visit-dish">
                    <span class="rc-dish-name">${escapeHtml(d.name)}</span>
                    ${d.rating != null ? `<span class="rc-dish-rating">${d.rating}<small>/10</small></span>` : ''}
                </div>`;
                if (d.remarks) {
                    html += `<p class="rc-dish-remarks">${escapeHtml(d.remarks)}</p>`;
                }
            });
            html += `</div>`;
        }

        // Caption
        const caption = review.caption || review.overall_remarks || '';
        if (caption) {
            html += `<p class="rc-visit-remarks">"${escapeHtml(caption)}"</p>`;
        }
    }

    html += `<button class="rc-edit-btn" onclick="openBeenHereSheet(${place.id})">✏️ Edit review</button>`;
    html += `</div>`;

    el.innerHTML = html;

    // Attach photo viewer listeners after innerHTML is set
    if (review) {
        const allPhotos = [
            ...(review.overall_photos || []),
            ...((review.dishes || []).flatMap(d => d.photos || []))
        ];
        if (allPhotos.length > 0) {
            el.querySelectorAll('.rc-visit-photo').forEach(div => {
                const idx = parseInt(div.dataset.photoIndex, 10);
                div.addEventListener('click', () => openPhotoViewer(allPhotos, idx, false));
            });
        }
    }
}

async function loadRcFriendReviews(googlePlaceId) {
    const listEl = document.getElementById('rc-friends-list');
    const emptyEl = document.getElementById('rc-friends-empty');
    try {
        const res = await fetch(`${API_URL}/api/restaurant/${googlePlaceId}/friend-reviews`, { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const reviews = data.reviews || [];
        if (reviews.length === 0) {
            emptyEl.style.display = '';
            return;
        }
        emptyEl.style.display = 'none';
        listEl.innerHTML = reviews.map(r => {
            const name = escapeHtml(r.display_name || r.first_name || 'Friend');
            const stars = r.overall_rating ? '⭐'.repeat(r.overall_rating) : '';
            const remarks = r.overall_remarks ? `<span class="rc-friend-remarks">"${escapeHtml(r.overall_remarks.slice(0, 80))}${r.overall_remarks.length > 80 ? '…' : ''}"</span>` : '';
            const date = r.created_at ? formatTimeAgo(r.created_at) : '';
            return `<div class="rc-friend-row">
                <div class="rc-friend-avatar">${name[0].toUpperCase()}</div>
                <div class="rc-friend-body">
                    <div class="rc-friend-name-row">
                        <span class="rc-friend-name">@${name}</span>
                        ${stars ? `<span class="rc-friend-stars">${stars}</span>` : ''}
                        ${date ? `<span class="rc-friend-date">${date}</span>` : ''}
                    </div>
                    ${remarks}
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('loadRcFriendReviews error:', e);
    }
}

function closeRestaurantCard() {
    const sheet = document.getElementById('restaurant-card');
    const overlay = document.getElementById('restaurant-card-overlay');
    sheet.classList.remove('rc-open');
    overlay.style.display = 'none';
    rcCurrentPlaceId = null;
    rcCurrentGoogleId = null;
}

function openRcMenu() {
    const menu = document.getElementById('rc-menu');
    if (menu) menu.style.display = 'flex';
}

function closeRcMenu() {
    const menu = document.getElementById('rc-menu');
    if (menu) menu.style.display = 'none';
}

async function deletePlaceFromCard() {
    if (!rcCurrentPlaceId) return;
    if (!confirm('Remove this place from your list?')) return;
    try {
        await fetch(`${API_URL}/api/places/${rcCurrentPlaceId}`, {
            method: 'DELETE', headers: getAuthHeaders()
        });
        closeRestaurantCard();
        // Remove from local array + re-render
        places = places.filter(p => p.id !== rcCurrentPlaceId);
        renderPlacesList(applyFiltersToList(places));
        displayPlacesOnMap(false);
    } catch (e) {
        console.error('deletePlaceFromCard error:', e);
    }
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
            const updatedPlace = places.find(p => p.id === lvPlaceId);
            if (updatedPlace) renderRcYourVisit(updatedPlace);
        }
        // Re-render list
        renderPlacesList(applyFiltersToList(places));
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
    const countEl = btn.querySelector('.like-count');
    const currentCount = parseInt(countEl?.textContent || '0');

    // Optimistic update
    btn.dataset.liked = liked ? 'false' : 'true';
    btn.classList.toggle('liked', !liked);
    if (countEl) countEl.textContent = liked ? currentCount - 1 : currentCount + 1;

    try {
        const method = liked ? 'DELETE' : 'POST';
        await fetch(`${API_URL}/api/activities/${activityId}/like`, {
            method, headers: getAuthHeaders()
        });
    } catch (e) {
        // Revert on error
        btn.dataset.liked = liked ? 'true' : 'false';
        btn.classList.toggle('liked', liked);
        if (countEl) countEl.textContent = currentCount;
    }
}

function onFeedCardTap(googlePlaceId, placeName) {
    if (!googlePlaceId) return;
    // Try to find in own places list first
    const own = places.find(p => p.google_place_id === googlePlaceId);
    if (own) {
        openRestaurantCard(own.id);
    } else {
        // Show a lightweight info card (future: open shared restaurant page)
        // For now just open Google Maps as fallback
        if (placeName) {
            window.open(`https://www.google.com/maps/place/?q=place_id:${googlePlaceId}`, '_blank');
        }
    }
}
