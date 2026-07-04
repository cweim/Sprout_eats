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
    INEXPENSIVE: '💰',
    MODERATE: '💰💰',
    EXPENSIVE: '💰💰💰',
    VERY_EXPENSIVE: '💰💰💰💰',
};

// Pagination state
let totalPlaces = 0;
let currentPlacesPage = 1;
let hasMorePlaces = false;
let isLoadingMorePlaces = false;
const PLACES_PER_PAGE = 100;

// Notes modal state
let currentEditingPlaceId = null;
let pendingReviewPromptPlaceId = null;

// Location state
let userLocation = null;

const PLACE_PREVIEW_MIN_ZOOM = 14;
let listControlsInitialized = false;
let notesModalInitialized = false;
let reviewPromptInitialized = false;
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
                console.log('User location acquired:', userLocation);

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
                console.log('Location not available:', error.message);
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

        // Log user info for debugging
        console.log('Telegram WebApp initialized');
        console.log('User:', tg.initDataUnsafe.user);
        console.log('Theme:', tg.themeParams);

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
        console.log('Not running in Telegram WebApp context');
        return null;
    }
}

// Apply light/dark theme based on Telegram or system preference
function applyTheme() {
    let theme = 'light';

    // Check Telegram colorScheme first
    if (window.Telegram?.WebApp?.colorScheme) {
        theme = window.Telegram.WebApp.colorScheme;
        console.log('Theme from Telegram:', theme);
    } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
        // Fallback to system preference
        theme = 'dark';
        console.log('Theme from system preference:', theme);
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
            console.log(`Fetching places (attempt ${attempt}/${retries}) from:`, url);

            // Create abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: getAuthHeaders()
            });
            clearTimeout(timeoutId);

            console.log('Response status:', response.status);
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
            console.log('Fetched places:', data.places?.length || 0, 'of', data.total || 0);
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

    if (!notesModalInitialized) {
        setupNotesModal();
        notesModalInitialized = true;
    }

    if (!reviewPromptInitialized) {
        setupReviewPromptModal();
        reviewPromptInitialized = true;
    }

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
        closePopupOnClick: false  // Don't close popup when clicking inside it
    }).setView([0, 0], 2);

    // Use CartoDB Voyager tiles (cute, colorful, clean)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    // Plain layer group — no clustering, markers always visible
    markersLayer = L.layerGroup().addTo(map);

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
    // Only show preview if place has notes
    if (!place.notes) return '';

    return `
        <div class="place-preview-bubble">
            <div class="place-preview-text">${truncatePreviewText(place.notes, 56)}</div>
        </div>
    `;
}


function updatePlacePreviewVisibility() {
    if (!map) return;

    const container = map.getContainer();
    const currentZoom = map.getZoom();
    const shouldShow = currentZoom >= PLACE_PREVIEW_MIN_ZOOM;
    console.log(`Zoom: ${currentZoom}, Min: ${PLACE_PREVIEW_MIN_ZOOM}, Show: ${shouldShow}`);
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
    let html = `<div class="place-popup" data-place-id="${place.id}">`;

    // Name
    html += `<div class="place-popup-name">${escapeHtml(place.name)}</div>`;

    // Address
    if (place.address) {
        html += `<div class="place-popup-address">${escapeHtml(place.address)}</div>`;
    }

    // Review indicator
    const review = getPlaceReview(place.id);
    if (review) {
        html += `<div class="popup-review">✍️ ${'⭐'.repeat(review.overall_rating)} ${review.overall_rating}/5</div>`;
    }

    // Description (editorial summary)
    if (place.place_description) {
        html += `<div class="place-description">${escapeHtml(place.place_description)}</div>`;
    }

    // Meta info (rating, price, types, distance)
    let metaHtml = '';
    if (place.place_rating) {
        const ratingCount = place.place_rating_count ? ` (${place.place_rating_count})` : '';
        metaHtml += `<span>⭐ ${place.place_rating}/5${ratingCount}</span>`;
    }
    if (place.place_price_level && PLACE_PRICE_LABELS[place.place_price_level]) {
        if (metaHtml) metaHtml += ' · ';
        metaHtml += `<span>${PLACE_PRICE_LABELS[place.place_price_level]}</span>`;
    }
    const types = formatPlaceTypes(place.place_types);
    if (types) {
        if (metaHtml) metaHtml += ' · ';
        metaHtml += `<span>${types}</span>`;
    }
    const popupDistance = getPlaceDistance(place);
    if (popupDistance !== null) {
        if (metaHtml) metaHtml += ' · ';
        metaHtml += `<span>📍 ${formatDistance(popupDistance)}</span>`;
    }
    if (metaHtml) {
        html += `<div class="place-popup-meta">${metaHtml}</div>`;
    }

    // Visited toggle (full width, like list view) — read-only on share map
    const visitedClass = place.is_visited ? ' active' : '';
    const visitedText = place.is_visited ? '✓ Visited' : 'Mark as visited';
    if (IS_SHARE_MAP) {
        if (place.is_visited) {
            html += `<button class="visited-toggle-btn popup-visited active" style="pointer-events:none">✓ Visited</button>`;
        }
    } else {
        html += `<button class="visited-toggle-btn popup-visited${visitedClass}" onclick="toggleVisited(${place.id})">${visitedText}</button>`;
    }

    // Notes section — read-only on share map
    if (IS_SHARE_MAP) {
        if (place.notes) {
            html += `<div class="popup-notes has-notes"><span class="notes-text">${escapeHtml(place.notes)}</span></div>`;
        }
    } else if (place.notes) {
        html += `<div class="popup-notes has-notes" onclick="event.stopPropagation(); startPopupNoteEdit(${place.id}, this)">
            <span class="notes-text">${escapeHtml(place.notes)}</span>
        </div>`;
    } else {
        html += `<div class="popup-notes empty" onclick="event.stopPropagation(); startPopupNoteEdit(${place.id}, this)">
            <span class="notes-icon">✏️</span>
            <span class="notes-placeholder">Add notes...</span>
        </div>`;
    }

    // Action buttons
    html += '<div class="place-popup-actions">';

    // Review button (personal map only)
    if (!IS_SHARE_MAP) {
        if (place.is_visited) {
            const reviewAriaLabel = `Write review for ${escapeHtml(place.name)}`;
            html += `<button class="card-action-btn review-btn" onclick="openReviewSheet(${place.id})" title="Write Review" aria-label="${reviewAriaLabel}">Review</button>`;
        } else {
            html += `<button class="card-action-btn review-btn disabled" onclick="showVisitFirstNudge()" aria-label="Mark as visited first to review">Review</button>`;
        }
    }

    // Google Maps link
    const mapsAriaLabel = `Open ${escapeHtml(place.name)} in Google Maps`;
    if (place.google_place_id) {
        const encodedName = encodeURIComponent(place.name);
        html += `<a href="https://www.google.com/maps/search/?api=1&query=${encodedName}&query_place_id=${place.google_place_id}"
                    target="_blank" class="card-action-btn external-btn" title="Open in Google Maps" aria-label="${mapsAriaLabel}">Maps</a>`;
    } else if (place.latitude && place.longitude) {
        html += `<a href="https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}"
                    target="_blank" class="card-action-btn external-btn" title="Open in Google Maps" aria-label="${mapsAriaLabel}">Maps</a>`;
    }

    // Original reel link
    if (place.source_url) {
        html += `<a href="${safeUrl(place.source_url)}" target="_blank" class="card-action-btn external-btn" title="View Original Reel" aria-label="View original reel">Reel</a>`;
    }

    // Delete button (personal map only)
    if (!IS_SHARE_MAP) {
        const escapedName = place.name.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        const deleteAriaLabel = `Delete ${escapeHtml(place.name)}`;
        html += `<button class="card-action-btn delete-btn" onclick="confirmDeletePlace(${place.id}, '${escapedName}')" title="Delete Place" aria-label="${deleteAriaLabel}">Delete</button>`;
    }

    html += '</div></div>';

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
    // Create icons for swapping
    const visitedIcon = L.icon({
        iconUrl: '/images/sprout_mascot_green.png',
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40]
    });
    const unvisitedIcon = L.icon({
        iconUrl: '/images/sprout_mascot_purple.png',
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40]
    });

    markersLayer.eachLayer(marker => {
        if (marker.placeData && marker.placeData.id === placeId) {
            // Update marker data reference
            marker.placeData = place;
            // Update marker icon based on visited status
            const newIcon = place.is_visited ? visitedIcon : unvisitedIcon;
            marker.setIcon(newIcon);
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

// Open notes modal from popup (legacy, kept for compatibility)
function openNotesForPlace(placeId) {
    const place = places.find(p => p.id === placeId);
    if (place) {
        openNotesModal(place);
    }
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

function syncMarkerPreviewTooltip(marker, place) {
    if (!marker) return;

    if (place.notes) {
        const tooltipContent = createMarkerPreviewContent(place);
        if (marker.getTooltip()) {
            marker.setTooltipContent(tooltipContent);
        } else {
            marker.bindTooltip(tooltipContent, {
                permanent: true,
                direction: 'top',
                offset: [0, -42],
                className: 'place-preview-tooltip'
            });
        }
    } else if (marker.getTooltip()) {
        marker.unbindTooltip();
    }
}

// Return marker icon sized for current zoom level
// zoom < 10  → small colored dot
// zoom 10-14 → medium sprout (26px)
// zoom >= 15 → full sprout (40px)
function getMarkerIconForZoom(zoom, isVisited) {
    if (zoom < 10) {
        const color = isVisited ? '#4caf50' : '#7c4dff';
        return L.divIcon({
            className: '',
            html: `<div class="marker-dot" style="background:${color}"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6],
            popupAnchor: [0, -6]
        });
    }
    const size = zoom < 15 ? 26 : 40;
    const half = size / 2;
    return L.icon({
        iconUrl: isVisited ? '/images/sprout_mascot_green.png' : '/images/sprout_mascot_purple.png',
        iconSize: [size, size],
        iconAnchor: [half, size],
        popupAnchor: [0, -size]
    });
}

// Update all existing marker icons to match current zoom
function updateMarkerIconSizes() {
    if (!map || !markersLayer) return;
    const zoom = map.getZoom();
    markersLayer.getLayers().forEach(marker => {
        if (marker.placeData) {
            marker.setIcon(getMarkerIconForZoom(zoom, marker.placeData.is_visited));
        }
    });
}

// Add markers for all places
function displayPlacesOnMap(fitBounds = true) {
    if (!map || !markersLayer) return;

    // Clear existing markers
    markersLayer.clearLayers();

    // Filter places based on visited filter and cuisine
    let filteredPlaces = filterPlacesByVisited(places);

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
            const icon = getMarkerIconForZoom(zoom, place.is_visited);
            const marker = L.marker([place.latitude, place.longitude], { icon });
            marker.placeData = place;

            // Zoom to marker on click, then show popup
            marker.on('click', function(e) {
                focusMarkerWithPopup(marker, e.latlng, 16);
            });

            // Bind popup with place details
            marker.bindPopup(createPopupContent(place), {
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

// Nudge when user taps Review on unvisited place
function showVisitFirstNudge() {
    const messages = [
        "sprout says: visit first, review later! 🌱",
        "haven't been yet? go go go! 🌿",
        "mark it visited and spill the tea ☕",
    ];
    const msg = messages[Math.floor(Math.random() * messages.length)];
    showToast(msg, null, 2000);
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

// Go to user's location
function goToMyLocation() {
    if (!navigator.geolocation) {
        showToast("Location not supported in this browser");
        return;
    }

    showToast("Finding your location...");

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;

            // Store user location for distance calculations
            userLocation = { lat: latitude, lng: longitude };

            // Remove existing user marker
            if (userLocationMarker) {
                map.removeLayer(userLocationMarker);
            }

            // Create custom icon for user location
            const userIcon = L.divIcon({
                className: 'user-location-marker',
                html: '<div class="user-marker-dot"></div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });

            // Add marker at user location
            userLocationMarker = L.marker([latitude, longitude], { icon: userIcon });
            userLocationMarker.addTo(map);

            // Pan to user location
            map.setView([latitude, longitude], 16);

            showToast("Here you are!");

            // Re-render views with distances (don't fit bounds, stay on user location)
            applyFilters();
            displayPlacesOnMap(false);
        },
        (error) => {
            let message = "Couldn't get your location";
            if (error.code === error.PERMISSION_DENIED) {
                message = "Location access denied. Check your settings!";
            }
            showToast(message);
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
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
    document.getElementById('btn-my-location').addEventListener('click', goToMyLocation);

    // Map filter chips (visited/unvisited)
    const mapFilterChips = document.querySelectorAll('.map-filter-chip');
    mapFilterChips.forEach(chip => {
        chip.addEventListener('click', () => {
            mapFilterChips.forEach(c => { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
            chip.classList.add('active');
            chip.setAttribute('aria-pressed', 'true');
            visitedFilter = chip.dataset.filter;
            localStorage.setItem('visitedFilter', visitedFilter);
            // Sync with list view filter
            document.querySelectorAll('.visited-chip').forEach(c => {
                const isActive = c.dataset.filter === visitedFilter;
                c.classList.toggle('active', isActive);
                c.setAttribute('aria-pressed', String(isActive));
            });
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

    // Sprout icon (visual only — visited=green, unvisited=purple)
    const sproutImg = place.is_visited ? '/images/sprout_mascot_green.png' : '/images/sprout_mascot_purple.png';

    // Header with sprout icon, name, and more button
    let headerHtml = `<div class="place-card-header">`;
    headerHtml += `<span class="sprout-icon"><img src="${sproutImg}" alt="${place.is_visited ? 'Visited' : 'To visit'}"></span>`;
    // Add review badge if exists (personal map only)
    const review = (IS_GROUP_MAP || IS_SHARE_MAP) ? null : getPlaceReview(place.id);
    const reviewBadge = review
        ? `<span class="place-review-badge">✍️ ${'⭐'.repeat(review.overall_rating)}</span>`
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

    // Distance + visited toggle row
    const distance = getPlaceDistance(place);
    const distanceText = distance !== null ? `<span class="place-card-distance">📍 ${formatDistance(distance)} away</span>` : '';
    let distanceHtml = '';
    if (IS_SHARE_MAP) {
        // Read-only: show visited badge, no toggle
        const visitedBadge = place.is_visited ? `<span class="visited-toggle-btn card-visited-toggle active" style="pointer-events:none">✓ Visited</span>` : '';
        distanceHtml = `<div class="place-card-distance-row">${distanceText}${visitedBadge}</div>`;
    } else if (!IS_GROUP_MAP) {
        const visitedClass = place.is_visited ? ' active' : '';
        const visitedText = place.is_visited ? '✓ Visited' : 'Mark as visited';
        const visitedToggleBtn = `<button class="visited-toggle-btn card-visited-toggle${visitedClass}" onclick="event.stopPropagation(); toggleVisitedFromCard(${place.id})" aria-label="${place.is_visited ? 'Mark as unvisited' : 'Mark as visited'}">${visitedText}</button>`;
        distanceHtml = `<div class="place-card-distance-row">${distanceText}${visitedToggleBtn}</div>`;
    } else {
        // Group map — same visited toggle, calls group API
        const visitedClass = place.is_visited ? ' active' : '';
        const visitedText = place.is_visited ? '✓ Visited' : 'Mark as visited';
        const visitedToggleBtn = `<button class="visited-toggle-btn card-visited-toggle${visitedClass}" onclick="event.stopPropagation(); toggleGroupVisitedFromCard(${place.id}, this)" aria-label="${place.is_visited ? 'Mark as unvisited' : 'Mark as visited'}">${visitedText}</button>`;
        distanceHtml = `<div class="place-card-distance-row">${distanceText}${visitedToggleBtn}</div>`;
    }

    // Notes section - inline editable (personal map only); read-only on share map
    let notesHtml = '';
    if (IS_SHARE_MAP) {
        if (place.notes) {
            notesHtml = `<div class="place-card-notes has-notes">
                <span class="notes-text">${escapeHtml(place.notes)}</span>
            </div>`;
        }
    } else if (!IS_GROUP_MAP) {
        if (place.notes) {
            notesHtml = `<div class="place-card-notes has-notes" onclick="event.stopPropagation(); startInlineNoteEdit(${place.id}, this)">
                <span class="notes-text">${escapeHtml(place.notes)}</span>
            </div>`;
        } else {
            notesHtml = `<div class="place-card-notes empty" onclick="event.stopPropagation(); startInlineNoteEdit(${place.id}, this)">
                <span class="notes-icon">✏️</span>
                <span class="notes-placeholder">Add notes...</span>
            </div>`;
        }
    }

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

    // Action buttons (Review, Maps, Reel - delete moved to menu)
    let actionsHtml = '<div class="place-card-actions">';

    // Review button (personal map only)
    if (!IS_GROUP_MAP && !IS_SHARE_MAP) {
        if (place.is_visited) {
            actionsHtml += `<button class="card-action-btn review-btn" onclick="event.stopPropagation(); openReviewSheet(${place.id})" aria-label="Write review">⭐ Review</button>`;
        } else {
            actionsHtml += `<button class="card-action-btn review-btn disabled" onclick="event.stopPropagation(); showVisitFirstNudge()" aria-label="Mark as visited first to review">⭐ Review</button>`;
        }
    }

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

    card.innerHTML = headerHtml + addressHtml + descriptionHtml + attributionHtml + metaHtml + distanceHtml + notesHtml + reviewsHtml + actionsHtml;

    // Click handler - show on map
    card.addEventListener('click', (e) => {
        // Don't navigate if clicking on interactive elements
        if (e.target.closest('button, a, input, textarea, select, .place-card-notes, .place-edit-form')) {
            return;
        }
        showPlaceOnMap(place);
    });

    return card;
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

    // Clear existing cards
    listContainer.innerHTML = '';

    // Remove any stale load-more button
    const existingLoadMore = document.getElementById('load-more-places-btn');
    if (existingLoadMore) existingLoadMore.remove();

    // Check for empty results
    if (placesToRender.length === 0) {
        listContainer.style.display = 'none';
        noResults.style.display = 'flex';
        updateResultsCount(0, places.length);
        return;
    }

    // Show list, hide no-results
    listContainer.style.display = 'block';
    noResults.style.display = 'none';

    // Create and append cards
    placesToRender.forEach(place => {
        const card = createPlaceCard(place);
        listContainer.appendChild(card);
    });

    updateResultsCount(placesToRender.length, totalPlaces || places.length);

    // Show "Load more" button when more pages exist and no active filters
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
    const match = todayStr.match(/(\d+:\d+ [AP]M)\s*[–\-]\s*(\d+:\d+ [AP]M)/);
    if (!match) return null;
    const toMin = s => {
        const [time, mer] = s.split(' ');
        let [h, m] = time.split(':').map(Number);
        if (mer === 'PM' && h !== 12) h += 12;
        if (mer === 'AM' && h === 12) h = 0;
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

    // Apply visited filter first
    filtered = filterPlacesByVisited(filtered);

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
    // Update local state immediately
    const place = places.find(p => p.id === placeId);
    if (place) {
        place.is_visited = isVisited;
    }

    // Haptic feedback
    hapticFeedback('light');

    // Show feedback
    const placeName = place ? place.name : '';
    showToast(isVisited ? `✓ Marked ${placeName} as visited!` : `Unmarked ${placeName}`);

    // Persist to server
    try {
        const response = await fetch(`${API_URL}/api/places/${placeId}`, {
            method: 'PATCH',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_visited: isVisited })
        });
        if (!response.ok) {
            throw new Error('Failed to update');
        }
        if (isVisited && !getPlaceReview(placeId)) {
            openReviewPrompt(placeId);
        }
        if (!isVisited && pendingReviewPromptPlaceId === placeId) {
            closeReviewPrompt();
        }
    } catch (error) {
        console.error('Failed to update visited status:', error);
        // Revert local state on error
        if (place) place.is_visited = !isVisited;
        showToast('Failed to save');
    }

    // If called from popup, update marker and popup in-place without closing
    if (fromPopup && place) {
        updateMarkerPopup(placeId, place);
        applyFilters();
    } else {
        // Full re-render for list view changes
        applyFilters();
        displayPlacesOnMap();
    }
}

function openReviewPrompt(placeId) {
    const place = places.find(p => p.id === placeId);
    const modal = document.getElementById('review-prompt-modal');
    const placeNameEl = document.getElementById('review-prompt-place-name');
    if (!place || !modal || !placeNameEl) return;

    pendingReviewPromptPlaceId = placeId;
    placeNameEl.textContent = place.name;
    _prevFocusEl = document.activeElement;
    modal.style.display = 'flex';
    modal._trapFocusCleanup = trapFocus(modal);
    modal.querySelector('button')?.focus();
}

function closeReviewPrompt() {
    pendingReviewPromptPlaceId = null;
    const modal = document.getElementById('review-prompt-modal');
    if (modal) {
        modal._trapFocusCleanup?.();
        modal.style.display = 'none';
    }
    _prevFocusEl?.focus();
    _prevFocusEl = null;
}

async function dontAskReviewAgain(placeId) {
    try {
        const response = await fetch(`${API_URL}/api/places/${placeId}/review-reminder/dont-ask`, {
            method: 'POST',
            headers: getAuthHeaders()
        });
        if (!response.ok) {
            throw new Error('Failed to update reminder preference');
        }
        showToast("Won't ask again for this place");
    } catch (error) {
        console.error('Failed to opt out of review reminder:', error);
        showToast('Failed to save');
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

function startInlineNoteEdit(placeId, container) {
    const place = places.find(p => p.id === placeId);
    if (!place) return;

    // Replace container content with textarea
    const currentNotes = place.notes || '';
    container.innerHTML = `
        <textarea class="inline-notes-input" placeholder="What did you think? Any must-try dishes?">${currentNotes}</textarea>
        <div class="inline-notes-actions">
            <button class="inline-notes-cancel" onclick="event.stopPropagation(); cancelInlineNoteEdit(${placeId})">Cancel</button>
            <button class="inline-notes-save" onclick="event.stopPropagation(); saveInlineNote(${placeId})">Save</button>
        </div>
    `;
    container.classList.add('editing');

    // Focus the textarea
    const textarea = container.querySelector('textarea');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Handle click outside to cancel
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            cancelInlineNoteEdit(placeId);
        } else if (e.key === 'Enter' && e.metaKey) {
            saveInlineNote(placeId);
        }
    });
}

// Cancel inline note editing
function cancelInlineNoteEdit(placeId) {
    applyFilters(); // Re-render the list to restore original state
}

// Save inline note
function saveInlineNote(placeId) {
    const card = document.querySelector(`.place-card[data-place-id="${placeId}"]`);
    if (!card) return;

    const textarea = card.querySelector('.inline-notes-input');
    if (!textarea) return;

    const saveBtn = card.querySelector('.inline-notes-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

    // Send empty string to clear notes (not null, which API ignores)
    const notes = textarea.value.trim();
    updatePlaceNotes(placeId, notes).finally(() => {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    });
}

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

function setupReviewPromptModal() {
    document.getElementById('review-prompt-close').addEventListener('click', closeReviewPrompt);
    document.getElementById('review-prompt-later').addEventListener('click', () => {
        closeReviewPrompt();
        showToast('Okay, I’ll remind you later in Telegram');
    });
    document.getElementById('review-prompt-now').addEventListener('click', async () => {
        const placeId = pendingReviewPromptPlaceId;
        closeReviewPrompt();
        if (placeId) {
            await openReviewSheet(placeId);
        }
    });
    document.getElementById('review-prompt-dont-ask').addEventListener('click', async () => {
        const placeId = pendingReviewPromptPlaceId;
        closeReviewPrompt();
        if (placeId) {
            await dontAskReviewAgain(placeId);
        }
    });

    document.getElementById('review-prompt-modal').addEventListener('click', (e) => {
        if (e.target.id === 'review-prompt-modal') {
            closeReviewPrompt();
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

// Open search modal
function openSearchModal() {
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
                    ${place.place_rating ? `<span class="search-result-rating">⭐ ${place.place_rating}</span>` : ''}
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
    ['btn-search-google', 'btn-search-empty', 'fab-discover'].forEach((id) => {
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
        let count = 0;
        switch (filter) {
            case 'all':
                count = allCount;
                break;
            case 'visited':
                count = visitedCount;
                break;
            case 'unvisited':
                count = unvisitedCount;
                break;
        }

        // Update chip text with count
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
        if (document.getElementById('review-prompt-modal')?.style.display === 'flex') { closeReviewPrompt(); return; }
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
    displayPlacesOnMap(!initialLocation);

    ensurePlacesUiInitialized();

    // Render list view
    renderPlacesList(places);

    // Load secondary data in the background so first paint is faster.
    loadReviews();

    // Update all filter counts
    updateMapFilterCounts();
    updateVisitedChipCounts();

    // Share map: show owner banner, hide add/discover FAB
    if (IS_SHARE_MAP) {
        const fab = document.getElementById('fab-discover');
        if (fab) fab.style.display = 'none';
        showShareBanner();
    }


    // Show map tab by default
    switchTab('map');

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

    console.log(`Loaded ${places.length} places`);
}

// ========== REVIEW SHEET ==========

// Review state
let currentReviewPlaceId = null;
let currentReview = null;
let dishChips = [];       // [{localId, persistedId, name}]
let chipIdCounter = 0;

const PRICE_LABELS = ['', 'Cheap', 'Affordable', 'Moderate', 'Pricey', 'Expensive'];

// Initialize star rating component
function initStarRating(container, onChange) {
    container.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
        const star = document.createElement('button');
        star.type = 'button';
        star.className = 'star';
        star.textContent = '★';
        star.dataset.value = i;
        star.setAttribute('aria-label', i === 1 ? '1 star' : `${i} stars`);
        container.appendChild(star);
    }

    const updateStars = (rating, hoverValue = null) => {
        container.querySelectorAll('.star').forEach((star, idx) => {
            const val = idx + 1;
            star.classList.toggle('filled', val <= rating);
            star.classList.toggle('hovered', hoverValue !== null && val <= hoverValue);
        });
    };

    container.addEventListener('click', (e) => {
        const star = e.target.closest('.star');
        if (!star) return;
        const value = parseInt(star.dataset.value);
        container.dataset.rating = value;
        updateStars(value);
        hapticFeedback('light');
        if (onChange) onChange(value);
    });

    container.addEventListener('mouseover', (e) => {
        const star = e.target.closest('.star');
        if (!star) return;
        updateStars(parseInt(container.dataset.rating), parseInt(star.dataset.value));
    });

    container.addEventListener('mouseleave', () => {
        updateStars(parseInt(container.dataset.rating));
    });

    // Set initial state
    updateStars(parseInt(container.dataset.rating) || 0);
}

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

function addDishChip(name, persistedId = null) {
    if (!name.trim()) return;
    const localId = `chip-${++chipIdCounter}`;
    dishChips.push({ localId, persistedId, name: name.trim() });
    renderDishChips();
}

function removeDishChip(localId) {
    dishChips = dishChips.filter(c => c.localId !== localId);
    renderDishChips();
}

function renderDishChips() {
    const container = document.getElementById('dish-chips-container');
    if (!container) return;
    container.querySelectorAll('.dish-chip').forEach(el => el.remove());
    const trigger = container.querySelector('#dish-add-trigger');
    dishChips.forEach(chip => {
        const el = document.createElement('span');
        el.className = 'dish-chip';
        el.innerHTML = `<span class="dish-chip-name">${escapeHtml(chip.name)}</span><button type="button" class="dish-chip-remove" aria-label="Remove ${escapeHtml(chip.name)}">×</button>`;
        el.querySelector('.dish-chip-remove').addEventListener('click', () => removeDishChip(chip.localId));
        container.insertBefore(el, trigger);
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

function getReviewFormValidation() {
    const rating = parseInt(document.getElementById('overall-stars').dataset.rating) || 0;
    if (rating === 0) {
        return { valid: false, message: 'Add a rating to save your review ⭐', element: document.getElementById('overall-rating-group') };
    }
    return { valid: true };
}

function getReviewFormPayload() {
    return {
        overall_rating: parseInt(document.getElementById('overall-stars').dataset.rating) || 0,
        price_rating: parseInt(document.getElementById('price-rating').dataset.rating) || 0,
        overall_remarks: document.getElementById('overall-remarks').value.trim(),
        dishes: dishChips.map(c => c.persistedId ? { id: c.persistedId, name: c.name } : { name: c.name }),
    };
}

// Populate review form from currentReview (or blank for new)
function populateReviewForm() {
    // Ratings
    const starsEl = document.getElementById('overall-stars');
    const priceEl = document.getElementById('price-rating');
    starsEl.dataset.rating = currentReview?.overall_rating || 0;
    priceEl.dataset.rating = currentReview?.price_rating || 0;
    initStarRating(starsEl);
    initPriceRating(priceEl);

    // Remarks
    document.getElementById('overall-remarks').value = currentReview?.overall_remarks || '';

    // Dish chips
    dishChips = [];
    chipIdCounter = 0;
    (currentReview?.dishes || []).forEach(d => addDishChip(d.name, d.id));
    renderDishChips();

    // Photos
    const photosGrid = document.getElementById('overall-photos');
    updatePhotoGrid(photosGrid, [...(currentReview?.overall_photos || []), ...getPendingPhotos()], 10, null);

    // Delete button only for existing reviews
    document.getElementById('delete-review-btn').style.display = currentReview ? 'block' : 'none';

    // Clear errors
    clearReviewValidationState();
}

function clearReviewValidationState() {
    const errorEl = document.getElementById('review-form-error');
    if (errorEl) {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
    }

    document.getElementById('overall-rating-group')?.classList.remove('invalid');
    document.getElementById('price-rating-group')?.classList.remove('invalid');
    document.querySelectorAll('.dish-card.invalid').forEach(card => card.classList.remove('invalid'));
}

function showReviewValidationError(message, element = null) {
    const errorEl = document.getElementById('review-form-error');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.style.display = 'block';
    }

    if (element) {
        element.classList.add('invalid');
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    showToast(message);
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
        showReviewValidationError(validation.message, validation.element);
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

        if (!response.ok) throw new Error('Failed to save review');

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

        showSuccessAnimation();
        closeReviewSheet();

        await loadReviews();
        applyFilters();
        displayPlacesOnMap(false);

    } catch (error) {
        console.error('Failed to save review:', error);
        showToast('Failed to save review 😅');
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = 'Save';
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

    if (!confirm('Delete this review? This cannot be undone.')) return;

    hapticFeedback('medium');

    try {
        const response = await fetch(`${API_URL}/api/places/${currentReviewPlaceId}/review`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });

        if (!response.ok) throw new Error('Failed to delete review');

        showToast('Review deleted');
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
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
        return { valid: false, error: 'Please select a JPEG, PNG, or WebP image' };
    }
    if (file.size > 10 * 1024 * 1024) { // 10MB max raw
        return { valid: false, error: 'Image too large (max 10MB)' };
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

let currentTab = 'map';
let feedLoaded = false;

function switchTab(tab) {
    currentTab = tab;

    // Update nav tab active state
    document.querySelectorAll('.nav-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // All views live inside .app-main — just toggle active class
    document.getElementById('map-view')?.classList.toggle('active', tab === 'map');
    document.getElementById('list-view')?.classList.toggle('active', false);
    document.getElementById('reviews-view')?.classList.toggle('active', false);
    document.getElementById('feed-view')?.classList.toggle('active', tab === 'feed');
    document.getElementById('profile-view')?.classList.toggle('active', tab === 'profile');

    // When switching to map tab, restore the last inner view (map/list/reviews)
    if (tab === 'map') {
        switchView(currentView || 'map');
    }

    if (tab === 'map' && map) {
        setTimeout(() => map.invalidateSize(), 100);
    } else if (tab === 'feed') {
        loadFeed();
    } else if (tab === 'profile') {
        loadProfile();
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

        list.innerHTML = activities.map(createFeedCard).join('');
    } catch (err) {
        console.error('loadFeed error:', err);
        if (loading) loading.style.display = 'none';
        if (list) list.innerHTML = '<p style="padding:16px;color:var(--hint-color)">Could not load feed.</p>';
    }
}

function createFeedCard(activity) {
    const timeAgo = formatTimeAgo(activity.created_at);
    const actor = activity.actor_display_name || activity.actor_username || 'Someone';
    const placeLink = activity.place_name
        ? `<span class="feed-place-name">${escapeHtml(activity.place_name)}</span>`
        : '';

    let icon = '📍';
    let action = 'did something';
    if (activity.activity_type === 'visited') {
        icon = '✅';
        action = `visited ${placeLink}`;
    } else if (activity.activity_type === 'reviewed') {
        icon = '⭐';
        action = `reviewed ${placeLink}`;
    } else if (activity.activity_type === 'saved') {
        icon = '🔖';
        action = `saved ${placeLink}`;
    } else if (activity.activity_type === 'friend_added') {
        icon = '🤝';
        action = 'made a new friend';
    }

    const reviewHtml = activity.review_text
        ? `<p class="feed-review-text">"${escapeHtml(activity.review_text)}"</p>`
        : '';

    const ratingHtml = activity.review_rating
        ? `<span class="feed-rating">${'⭐'.repeat(Math.round(activity.review_rating))}</span>`
        : '';

    return `
        <div class="feed-card">
            <div class="feed-card-icon">${icon}</div>
            <div class="feed-card-body">
                <p class="feed-action"><strong>${escapeHtml(actor)}</strong> ${action}</p>
                ${ratingHtml}
                ${reviewHtml}
                <p class="feed-time">${timeAgo}</p>
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
    const nameEl = document.getElementById('profile-display-name');
    const userEl = document.getElementById('profile-username');
    const bioEl = document.getElementById('profile-bio');
    if (nameEl) nameEl.textContent = data.display_name || data.first_name || 'You';
    if (userEl) userEl.textContent = data.username ? `@${data.username}` : '';
    if (bioEl) bioEl.textContent = data.bio || '';

    const stats = data.stats || {};
    const savedEl = document.getElementById('stat-saved');
    const visitedEl = document.getElementById('stat-visited');
    const reviewsEl = document.getElementById('stat-reviews');
    if (savedEl) savedEl.textContent = stats.saved ?? '—';
    if (visitedEl) visitedEl.textContent = stats.visited ?? '—';
    if (reviewsEl) reviewsEl.textContent = stats.reviews ?? '—';
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
                const card = document.createElement('div');
                card.className = 'friend-card';
                card.innerHTML = `
                    <div class="friend-info">
                        <p class="friend-name">${escapeHtml(f.display_name || f.first_name || 'Friend')}</p>
                        ${f.username ? `<p class="friend-username">@${escapeHtml(f.username)}</p>` : ''}
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



