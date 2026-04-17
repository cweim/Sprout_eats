// Configuration
const API_URL = ''; // Set to your API URL, e.g., 'http://localhost:8000'

// State
let places = [];
let allReviews = [];
let currentView = 'map';
let map = null;
let markersLayer = null;
let userLocationMarker = null;

// Filter state
let searchQuery = '';
let activeCategory = '';  // Single category filter (empty = all)
let sortBy = 'newest';
let visitedFilter = 'all';  // 'all', 'visited', 'unvisited'
let countryFilter = '';  // Country filter (empty = all)
let mapCuisineFilter = '';  // Cuisine filter for map view
let searchDebounceTimer = null;

// Notes modal state
let currentEditingPlaceId = null;

// Location state
let userLocation = null;

const PLACE_PREVIEW_MIN_ZOOM = 14;

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

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Fetching places (attempt ${attempt}/${retries}) from:`, `${API_URL}/api/places`);

            // Create abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const response = await fetch(`${API_URL}/api/places`, {
                signal: controller.signal,
                headers: {
                    'ngrok-skip-browser-warning': 'true'
                }
            });
            clearTimeout(timeoutId);

            console.log('Response status:', response.status);
            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status}`);
            }
            const data = await response.json();
            console.log('Fetched places:', data.places?.length || 0);
            return { success: true, places: data.places || [] };
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

// Show loading state
function showLoading() {
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('map-view').classList.remove('active');
    document.getElementById('list-view').classList.remove('active');
}

// Hide loading state
function hideLoading() {
    document.getElementById('loading').style.display = 'none';
}

// Show empty state
function showEmptyState() {
    document.getElementById('empty-state').style.display = 'flex';
    document.getElementById('map-view').classList.remove('active');
    document.getElementById('list-view').classList.remove('active');
}

// Hide empty state
function hideEmptyState() {
    document.getElementById('empty-state').style.display = 'none';
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

    // Create feature group for markers (supports getBounds)
    markersLayer = L.featureGroup().addTo(map);

    map.on('zoomend', updatePlacePreviewVisibility);
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
    html += `<div class="place-popup-name">${place.name}</div>`;

    // Address
    if (place.address) {
        html += `<div class="place-popup-address">${place.address}</div>`;
    }

    // Review indicator
    const review = getPlaceReview(place.id);
    if (review) {
        html += `<div class="popup-review">✍️ ${'⭐'.repeat(review.overall_rating)} ${review.overall_rating}/5</div>`;
    }

    // Meta info (rating, types, distance)
    let metaHtml = '';
    if (place.place_rating) {
        const ratingCount = place.place_rating_count ? ` (${place.place_rating_count})` : '';
        metaHtml += `<span>⭐ ${place.place_rating}/5${ratingCount}</span>`;
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

    // Visited toggle (full width, like list view)
    const visitedClass = place.is_visited ? ' active' : '';
    const visitedText = place.is_visited ? '✓ Visited' : 'Mark as visited';
    html += `<button class="visited-toggle-btn popup-visited${visitedClass}" onclick="toggleVisited(${place.id})">${visitedText}</button>`;

    // Notes section (inline editing like list view)
    if (place.notes) {
        html += `<div class="popup-notes has-notes" onclick="event.stopPropagation(); startPopupNoteEdit(${place.id}, this)">
            <span class="notes-text">${place.notes}</span>
        </div>`;
    } else {
        html += `<div class="popup-notes empty" onclick="event.stopPropagation(); startPopupNoteEdit(${place.id}, this)">
            <span class="notes-icon">✏️</span>
            <span class="notes-placeholder">Add notes...</span>
        </div>`;
    }

    // Action buttons
    html += '<div class="place-popup-actions">';

    // Review button (primary if visited, disabled if not)
    if (place.is_visited) {
        const reviewAriaLabel = `Write review for ${place.name}`;
        html += `<button class="popup-action-btn primary review-btn" onclick="openReviewSheet(${place.id})" title="Write Review" aria-label="${reviewAriaLabel}">✍️</button>`;
    } else {
        html += `<button class="popup-action-btn review-btn disabled" title="Mark as visited first" aria-label="Mark as visited first to review" disabled>✍️</button>`;
    }

    // Google Maps link - shortened
    const mapsAriaLabel = `Open ${place.name} in Google Maps`;
    if (place.google_place_id) {
        const encodedName = encodeURIComponent(place.name);
        html += `<a href="https://www.google.com/maps/search/?api=1&query=${encodedName}&query_place_id=${place.google_place_id}"
                    target="_blank" class="popup-action-btn" title="Open in Google Maps" aria-label="${mapsAriaLabel}">📍</a>`;
    } else if (place.latitude && place.longitude) {
        html += `<a href="https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}"
                    target="_blank" class="popup-action-btn" title="Open in Google Maps" aria-label="${mapsAriaLabel}">📍</a>`;
    }

    // Original reel link - shortened
    if (place.source_url) {
        html += `<a href="${place.source_url}" target="_blank" class="popup-action-btn" title="View Original Reel" aria-label="View original reel">▶️</a>`;
    }

    // Delete button
    const escapedName = place.name.replace(/'/g, "\\'").replace(/"/g, "&quot;");
    const deleteAriaLabel = `Delete ${place.name}`;
    html += `<button class="popup-action-btn" onclick="confirmDeletePlace(${place.id}, '${escapedName}')" style="background: var(--danger-bg); color: var(--danger-color);" title="Delete Place" aria-label="${deleteAriaLabel}">🗑️</button>`;

    html += '</div></div>';

    return html;
}

// Toggle visited status from popup
function toggleVisited(placeId) {
    const place = places.find(p => p.id === placeId);
    if (place) {
        updatePlaceVisited(placeId, !place.is_visited, true);  // true = from popup, don't close it
    }
}

// Update a marker's popup content in-place without closing it
function updateMarkerPopup(placeId, place) {
    // Create icons for swapping
    const visitedIcon = L.icon({
        iconUrl: 'images/sprout_mascot_green.png',
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40]
    });
    const unvisitedIcon = L.icon({
        iconUrl: 'images/sprout_mascot_purple.png',
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
            marker.setTooltipContent(createMarkerPreviewContent(place));
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

    const notes = textarea.value.trim();
    updatePlaceNotes(placeId, notes);
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

    // Update cuisine dropdown options
    populateCuisineDropdown();

    if (filteredPlaces.length === 0) {
        // No places - show world view or stay at user location
        if (!userLocation) {
            map.setView([20, 0], 2);
        }
        return;
    }

    // Create custom icons for visited/unvisited
    const visitedIcon = L.icon({
        iconUrl: 'images/sprout_mascot_green.png',
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40]
    });

    const unvisitedIcon = L.icon({
        iconUrl: 'images/sprout_mascot_purple.png',
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40]
    });

    // Add marker for each place with mascot icons
    filteredPlaces.forEach(place => {
        if (place.latitude && place.longitude) {
            // Use different mascot for visited vs unvisited
            const icon = place.is_visited ? visitedIcon : unvisitedIcon;
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

            // Only show speech bubble if place has notes
            if (place.notes) {
                marker.bindTooltip(createMarkerPreviewContent(place), {
                    permanent: true,
                    direction: 'top',
                    offset: [0, -42],
                    className: 'place-preview-tooltip'
                });
            }

            markersLayer.addLayer(marker);
        }
    });

    // Fit map to show all markers only if requested
    if (fitBounds && markersLayer.getLayers().length > 0) {
        const bounds = markersLayer.getBounds();
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
    }

    updatePlacePreviewVisibility();
}

// Populate cuisine dropdown from available places
function populateCuisineDropdown() {
    const select = document.getElementById('map-cuisine-filter');
    if (!select) return;

    const cuisines = new Set();
    places.forEach(p => {
        const category = getPrimaryCategory(p.place_types);
        if (category) cuisines.add(category);
    });

    // Remember current value
    const currentValue = select.value;

    // Clear and rebuild options
    select.innerHTML = '<option value="">All types</option>';
    Array.from(cuisines).sort().forEach(cuisine => {
        const option = document.createElement('option');
        option.value = cuisine;
        option.textContent = cuisine.charAt(0).toUpperCase() + cuisine.slice(1);
        select.appendChild(option);
    });

    // Restore value if still valid
    select.value = currentValue;
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
function showToast(message, retryFn = null) {
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

    // Remove after 3 seconds (5 seconds if has retry)
    const duration = retryFn ? 5000 : 3000;
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
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
    document.getElementById('btn-fit-all').addEventListener('click', fitAllPlaces);

    // Map filter chips (visited/unvisited)
    const mapFilterChips = document.querySelectorAll('.map-filter-chip');
    mapFilterChips.forEach(chip => {
        chip.addEventListener('click', () => {
            mapFilterChips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            visitedFilter = chip.dataset.filter;
            // Sync with list view filter
            document.querySelectorAll('.visited-chip').forEach(c => {
                c.classList.toggle('active', c.dataset.filter === visitedFilter);
            });
            applyFilters();
            displayPlacesOnMap(false);
        });
    });

    // Map cuisine filter
    const cuisineSelect = document.getElementById('map-cuisine-filter');
    cuisineSelect.addEventListener('change', (e) => {
        mapCuisineFilter = e.target.value;
        displayPlacesOnMap(false);
    });
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

    // Sprout icon based on visited status
    const sproutImg = place.is_visited ? 'images/sprout_mascot_green.png' : 'images/sprout_mascot_purple.png';
    const sproutTitle = place.is_visited ? 'Visited! Click to unmark' : 'Click to mark as visited';
    const sproutAriaLabel = place.is_visited ? 'Mark as unvisited' : 'Mark as visited';

    // Header with sprout toggle, name, and more button
    let headerHtml = `<div class="place-card-header">`;
    headerHtml += `<button class="sprout-toggle" onclick="event.stopPropagation(); toggleVisitedFromCard(${place.id})" title="${sproutTitle}" aria-label="${sproutAriaLabel}">
        <img src="${sproutImg}" alt="${place.is_visited ? 'Visited' : 'To visit'}">
    </button>`;
    // Add review badge if exists
    const review = getPlaceReview(place.id);
    const reviewBadge = review
        ? `<span class="place-review-badge">✍️ ${'⭐'.repeat(review.overall_rating)}</span>`
        : '';
    headerHtml += `<span class="place-card-name">${place.name} ${reviewBadge}</span>`;
    headerHtml += `<button class="more-btn" onclick="event.stopPropagation(); openPlaceMenu(${place.id}, '${place.name.replace(/'/g, "\\'")}')" aria-label="More options">···</button>`;
    headerHtml += `</div>`;

    // Address
    let addressHtml = '';
    if (place.address) {
        addressHtml = `<div class="place-card-address">${place.address}</div>`;
    }

    // Meta row: rating and types
    let metaHtml = '<div class="place-card-meta">';
    if (place.place_rating) {
        const count = place.place_rating_count ? ` (${place.place_rating_count})` : '';
        metaHtml += `<span class="place-card-rating">⭐ ${place.place_rating}${count}</span>`;
    }
    const types = formatPlaceTypes(place.place_types);
    if (types) {
        metaHtml += `<span class="place-card-types">${types}</span>`;
    }
    metaHtml += '</div>';

    // Distance display (if user location available)
    let distanceHtml = '';
    const distance = getPlaceDistance(place);
    if (distance !== null) {
        distanceHtml = `<div class="place-card-distance">📍 ${formatDistance(distance)} away</div>`;
    }

    // Notes section - inline editable
    let notesHtml = '';
    if (place.notes) {
        notesHtml = `<div class="place-card-notes has-notes" onclick="event.stopPropagation(); startInlineNoteEdit(${place.id}, this)">
            <span class="notes-text">${place.notes}</span>
        </div>`;
    } else {
        notesHtml = `<div class="place-card-notes empty" onclick="event.stopPropagation(); startInlineNoteEdit(${place.id}, this)">
            <span class="notes-icon">✏️</span>
            <span class="notes-placeholder">Add notes...</span>
        </div>`;
    }

    // Action buttons (Review, Maps, Reel - delete moved to menu)
    let actionsHtml = '<div class="place-card-actions">';

    // Review button (disabled if not visited)
    if (place.is_visited) {
        actionsHtml += `<button class="card-action-btn review-btn" onclick="event.stopPropagation(); openReviewSheet(${place.id})" aria-label="Write review">⭐ Review</button>`;
    } else {
        actionsHtml += `<button class="card-action-btn review-btn disabled" title="Mark as visited first" aria-label="Mark as visited first to review" disabled>⭐ Review</button>`;
    }

    // Google Maps link
    if (place.google_place_id) {
        const encodedName = encodeURIComponent(place.name);
        actionsHtml += `<a href="https://www.google.com/maps/search/?api=1&query=${encodedName}&query_place_id=${place.google_place_id}"
                          target="_blank" class="card-action-btn" onclick="event.stopPropagation()" aria-label="Open in Google Maps">📍 Maps</a>`;
    } else if (place.latitude && place.longitude) {
        actionsHtml += `<a href="https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}"
                          target="_blank" class="card-action-btn" onclick="event.stopPropagation()" aria-label="Open in Google Maps">📍 Maps</a>`;
    }

    // Original reel link
    if (place.source_url) {
        actionsHtml += `<a href="${place.source_url}" target="_blank" class="card-action-btn" onclick="event.stopPropagation()" aria-label="View original reel">▶️ Reel</a>`;
    }

    actionsHtml += '</div>';

    card.innerHTML = headerHtml + addressHtml + metaHtml + distanceHtml + notesHtml + actionsHtml;

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

// Toggle visited from card sprout button
function toggleVisitedFromCard(placeId) {
    const place = places.find(p => p.id === placeId);
    if (place) {
        updatePlaceVisited(placeId, !place.is_visited, false);
    }
}

// ========== PLACE OVERFLOW MENU ==========

let currentMenuPlaceId = null;
let currentMenuPlaceName = null;

function openPlaceMenu(placeId, placeName) {
    currentMenuPlaceId = placeId;
    currentMenuPlaceName = placeName;
    document.getElementById('place-menu').style.display = 'flex';
    hapticFeedback('light');
}

function closePlaceMenu() {
    document.getElementById('place-menu').style.display = 'none';
    currentMenuPlaceId = null;
    currentMenuPlaceName = null;
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
            closePlaceMenu();
            confirmDeletePlace(currentMenuPlaceId, currentMenuPlaceName);
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

    updateResultsCount(placesToRender.length, places.length);
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

// Filter places by search query
function filterBySearch(placesToFilter) {
    if (!searchQuery.trim()) return placesToFilter;

    const query = searchQuery.toLowerCase().trim();
    return placesToFilter.filter(place => {
        const name = (place.name || '').toLowerCase();
        const address = (place.address || '').toLowerCase();
        return name.includes(query) || address.includes(query);
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
                showToast("Enable location to sort by distance");
                return sorted; // Return unsorted if no location
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
    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            // Update active state
            chips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');

            // Update filter
            visitedFilter = chip.dataset.filter;

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
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify({ is_visited: isVisited })
        });
        if (!response.ok) {
            throw new Error('Failed to update');
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
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true'
            },
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

    // Send empty string to clear notes (not null, which API ignores)
    const notes = textarea.value.trim();
    updatePlaceNotes(placeId, notes);
}

// Confirm delete place
function confirmDeletePlace(placeId, placeName) {
    if (confirm(`Delete "${placeName}"?\n\nThis can't be undone! 🥺`)) {
        deletePlace(placeId);
    }
}

// Delete a place
async function deletePlace(placeId) {
    // Haptic feedback
    hapticFeedback('medium');

    // Delete from server
    try {
        const response = await fetch(`${API_URL}/api/places/${placeId}`, {
            method: 'DELETE',
            headers: {
                'ngrok-skip-browser-warning': 'true'
            }
        });
        if (!response.ok) {
            throw new Error('Failed to delete');
        }
    } catch (error) {
        console.error('Failed to delete place:', error);
        showToast('Oops! Failed to delete 😅');
        return;
    }

    // Get place name before removal
    const deletedPlace = places.find(p => p.id === placeId);
    const placeName = deletedPlace ? deletedPlace.name : '';

    // Remove from local state
    places = places.filter(p => p.id !== placeId);

    // Show feedback
    showToast(`Bye bye ${placeName}! 👋`);

    // Re-render
    applyFilters();
    displayPlacesOnMap();
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
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true'
            },
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
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true'
            },
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

    modal.style.display = 'flex';
    textarea.focus();

    // Update character count on input
    textarea.oninput = () => {
        charCount.textContent = textarea.value.length;
    };
}

// Close notes modal
function closeNotesModal() {
    const modal = document.getElementById('notes-modal');
    modal.style.display = 'none';
    currentEditingPlaceId = null;
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

    modal.style.display = 'flex';
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

    // Build search query with location bias
    let query = type;
    if (userLocation) {
        query = `${type} near me`;
    }

    // Show loading
    resultsContainer.innerHTML = '';
    loadingEl.style.display = 'flex';
    emptyEl.style.display = 'none';

    try {
        const response = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(query)}&max_results=10`, {
            headers: {
                'ngrok-skip-browser-warning': 'true'
            }
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
                        <div class="search-result-name">${place.name}</div>
                        <div class="search-result-address">${place.address || ''}</div>
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
    document.getElementById('search-modal').style.display = 'none';
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
        const response = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(query)}&max_results=10`, {
            headers: {
                'ngrok-skip-browser-warning': 'true'
            }
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
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify(place)
        });

        if (!response.ok) throw new Error('Failed to add');

        const data = await response.json();

        // Add to local state
        places.push(data.place);

        // Close modal
        closeSearchModal();

        // Show success toast
        showToast(`Added ${place.name}! 🎉`);

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

        // Also update list view
        applyFilters();

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
let drawerSort = 'newest';
let drawerCountry = '';
let drawerType = '';

function openFilterDrawer() {
    // Initialize drawer state from current filters
    drawerSort = sortBy;
    drawerCountry = countryFilter;
    drawerType = activeCategory;

    // Populate options
    populateFilterDrawerOptions();

    // Show drawer
    document.getElementById('filter-drawer').style.display = 'flex';
    hapticFeedback('light');
}

function closeFilterDrawer() {
    document.getElementById('filter-drawer').style.display = 'none';
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
}

function applyFilterDrawer() {
    sortBy = drawerSort;
    countryFilter = drawerCountry;
    activeCategory = drawerType;

    closeFilterDrawer();
    applyFilters();
    displayPlacesOnMap(false);
    updateFilterButton();
    renderActiveFilterPills();
}

function clearAllFilters() {
    drawerSort = 'newest';
    drawerCountry = '';
    drawerType = '';
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

    // Count active filters (excluding default sort)
    let count = 0;
    if (sortBy !== 'newest') count++;
    if (countryFilter) count++;
    if (activeCategory) count++;

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

    if (sortBy !== 'newest') {
        const sortLabels = { name: 'A-Z', rating: 'Top Rated', distance: 'Nearest' };
        html += `<span class="filter-pill">
            ${sortLabels[sortBy] || sortBy}
            <button class="filter-pill-remove" onclick="removeFilter('sort')">×</button>
        </span>`;
    }

    container.innerHTML = html;
}

function removeFilter(type) {
    if (type === 'country') countryFilter = '';
    if (type === 'type') activeCategory = '';
    if (type === 'sort') sortBy = 'newest';

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
        const baseText = filter === 'all' ? 'All' : filter === 'visited' ? 'Visited ✓' : 'To Visit';
        chip.textContent = count > 0 ? `${baseText} (${count})` : baseText;
    });
}

// Update review filter chip counts
function updateReviewFilterCounts() {
    const totalCount = allReviews.length;
    const withPhotosCount = allReviews.filter(r => {
        const dishPhotos = r.dishes?.reduce((sum, d) => sum + (d.photos?.length || 0), 0) || 0;
        const overallPhotos = r.overall_photos?.length || 0;
        return (dishPhotos + overallPhotos) > 0;
    }).length;
    const fiveStarCount = allReviews.filter(r => r.overall_rating === 5).length;
    const fourStarCount = allReviews.filter(r => r.overall_rating === 4).length;

    document.querySelectorAll('.review-filter-chip').forEach(chip => {
        const filter = chip.dataset.filter;
        let count = 0;
        let baseText = '';

        switch (filter) {
            case 'all':
                count = totalCount;
                baseText = 'All';
                break;
            case 'photos':
                count = withPhotosCount;
                baseText = 'With Photos';
                break;
            case '5star':
                count = fiveStarCount;
                baseText = '5 ⭐';
                break;
            case '4star':
                count = fourStarCount;
                baseText = '4 ⭐';
                break;
        }

        chip.textContent = count > 0 ? `${baseText} (${count})` : baseText;
    });
}

// Update all filter counts
function updateAllFilterCounts() {
    updateVisitedChipCounts();
    updateMapFilterCounts();
    updateReviewFilterCounts();
}

// Switch view
function switchView(view) {
    currentView = view;
    document.querySelector('.app-main')?.setAttribute('data-view', view);

    // Update toggle buttons
    document.getElementById('btn-map').classList.toggle('active', view === 'map');
    document.getElementById('btn-list').classList.toggle('active', view === 'list');
    document.getElementById('btn-reviews').classList.toggle('active', view === 'reviews');

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
    document.getElementById('btn-map').addEventListener('click', () => switchView('map'));
    document.getElementById('btn-list').addEventListener('click', () => switchView('list'));
    document.getElementById('btn-reviews').addEventListener('click', () => switchView('reviews'));
}

// Initialize app
async function initApp() {
    // Initialize Telegram
    const tg = initTelegram();

    // Apply theme immediately
    applyTheme();

    // Setup view toggle
    setupViewToggle();

    // Initialize map
    initMap();

    // Setup map controls
    setupMapControls();

    // Setup manual discovery triggers regardless of saved-place state
    setupSearchModal();

    // Show loading
    showLoading();

    // Fetch places and user location in parallel
    const [fetchResult, location] = await Promise.all([
        fetchPlaces(),
        requestUserLocation(false)  // Get location for distance calc, don't center map
    ]);

    // Hide loading
    hideLoading();

    // Check for API error
    if (!fetchResult.success) {
        console.error('API error:', fetchResult.error);
        showErrorState(fetchResult.error);
        return;
    }

    places = fetchResult.places;

    // Check if empty
    if (places.length === 0) {
        showEmptyState();
        return;
    }

    // Determine map initial view: center on user if within 200km of any place
    let shouldCenterOnUser = false;
    if (userLocation && places.length > 0) {
        // Check if any place is within 200km of user
        const nearbyPlace = places.find(p => {
            if (!p.latitude || !p.longitude) return false;
            const dist = calculateDistance(userLocation.lat, userLocation.lng, p.latitude, p.longitude);
            return dist <= 200;
        });
        shouldCenterOnUser = !!nearbyPlace;
    }

    // Display places on map
    if (shouldCenterOnUser) {
        // Center on user location with zoom 13, show user marker
        displayPlacesOnMap(false);  // Add markers but don't fit bounds
        map.setView([userLocation.lat, userLocation.lng], 13);

        // Add user location marker (blue dot)
        if (!userLocationMarker) {
            userLocationMarker = L.circleMarker([userLocation.lat, userLocation.lng], {
                radius: 8,
                fillColor: '#4285f4',
                color: '#fff',
                weight: 2,
                opacity: 1,
                fillOpacity: 1
            }).addTo(map).bindPopup('You are here');
        }
    } else {
        // Fall back to fitting all places in view
        displayPlacesOnMap(true);
    }

    // Setup list controls (search, filters, sort)
    setupListControls();

    // Setup notes modal
    setupNotesModal();

    // Setup review sheet
    setupReviewSheet();

    // Setup reviews view
    setupReviewsView();

    // Load reviews
    await loadReviews();

    // Render list view
    renderPlacesList(places);

    // Update all filter counts
    updateMapFilterCounts();
    updateVisitedChipCounts();

    // Show map view by default
    switchView('map');

    console.log(`Loaded ${places.length} places`);
}

// ========== REVIEW SHEET ==========

// Review state
let currentReviewPlaceId = null;
let currentReview = null;
let reviewDishes = [];
let dishIdCounter = 0;

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

// Create dish card HTML
function createDishCard(dish = {}) {
    const id = dish.id || `new-${++dishIdCounter}`;
    const name = dish.name || '';
    const rating = dish.rating || 0;
    const remarks = dish.remarks || '';
    const photos = dish.photos || [];

    const card = document.createElement('div');
    card.className = 'dish-card';
    card.dataset.dishId = id;

    card.innerHTML = `
        <div class="dish-card-header">
            <input type="text" class="dish-card-name" placeholder="What did you order?" value="${name.replace(/"/g, '&quot;')}" maxlength="100">
            <button type="button" class="dish-remove-btn" onclick="removeDishCard('${id}')">×</button>
        </div>
        <div class="dish-card-body">
            <label>Rating</label>
            <div class="dish-card-stars star-rating" data-rating="${rating}"></div>
        </div>
        <div class="dish-photos photo-grid small" data-dish-id="${id}">
            <!-- Photos will be populated by updatePhotoGrid -->
        </div>
        <div class="dish-remarks">
            <textarea placeholder="Any thoughts on this dish?" maxlength="300">${remarks}</textarea>
        </div>
    `;

    // Initialize star rating for this dish
    const starsContainer = card.querySelector('.dish-card-stars');
    initStarRating(starsContainer);

    // Initialize photo grid (max 2 photos per dish)
    const photoGrid = card.querySelector('.dish-photos');
    updatePhotoGrid(photoGrid, photos, 2, id);

    return card;
}

// Add a new dish card
function addDishCard(dish = {}) {
    const container = document.getElementById('review-dishes');
    const card = createDishCard(dish);
    container.appendChild(card);

    // Focus the name input
    card.querySelector('.dish-card-name').focus();
    hapticFeedback('light');
}

// Remove a dish card
function removeDishCard(id) {
    const card = document.querySelector(`.dish-card[data-dish-id="${id}"]`);
    if (card) {
        card.style.opacity = '0';
        card.style.transform = 'translateX(-20px)';
        setTimeout(() => card.remove(), 150);
        hapticFeedback('light');
    }
}

// Collect all dish data from the form
function collectDishData() {
    const dishes = [];
    document.querySelectorAll('.dish-card').forEach(card => {
        const id = card.dataset.dishId;
        const name = card.querySelector('.dish-card-name').value.trim();
        const rating = parseInt(card.querySelector('.star-rating').dataset.rating) || 0;
        const remarks = card.querySelector('.dish-remarks textarea').value.trim();

        // Only include dishes with a name
        if (name) {
            dishes.push({
                id: id.startsWith('new-') ? null : parseInt(id),
                name,
                rating,
                remarks: remarks || null
            });
        }
    });
    return dishes;
}

// Open review sheet for a place
async function openReviewSheet(placeId) {
    currentReviewPlaceId = placeId;
    const place = places.find(p => p.id === placeId);
    if (!place) return;

    // Set title
    document.getElementById('review-sheet-title').textContent = `Review: ${place.name}`;

    // Add or update "View Place" button
    const sheetHeader = document.querySelector('.sheet-header');
    let viewPlaceBtn = document.getElementById('view-place-btn');

    if (!viewPlaceBtn) {
        viewPlaceBtn = document.createElement('button');
        viewPlaceBtn.id = 'view-place-btn';
        viewPlaceBtn.className = 'view-place-btn';
        viewPlaceBtn.textContent = '📍 View Place';
        viewPlaceBtn.addEventListener('click', () => {
            // Close review sheet
            document.getElementById('review-sheet').style.display = 'none';

            // Switch to map view
            switchView('map');

            // Center on place marker
            if (map && place.latitude && place.longitude) {
                map.setView([place.latitude, place.longitude], 15);

                // Open marker popup
                markersLayer.eachLayer(marker => {
                    if (marker.placeData && marker.placeData.id === placeId) {
                        marker.openPopup();
                    }
                });
            }

            hapticFeedback('medium');
        });

        sheetHeader.appendChild(viewPlaceBtn);
    }

    // Show/hide View Place button based on current view
    if (currentView === 'reviews') {
        viewPlaceBtn.style.display = 'inline-block';
    } else {
        viewPlaceBtn.style.display = 'none';
    }

    // Clear dishes
    document.getElementById('review-dishes').innerHTML = '';
    dishIdCounter = 0;

    // Try to load existing review
    try {
        const response = await fetch(`${API_URL}/api/places/${placeId}/review`, {
            headers: { 'ngrok-skip-browser-warning': 'true' }
        });

        if (response.ok) {
            const data = await response.json();
            currentReview = data.review;

            // Populate dishes with photos
            if (currentReview.dishes && currentReview.dishes.length > 0) {
                currentReview.dishes.forEach(dish => {
                    addDishCard({
                        id: dish.id,
                        name: dish.name,
                        rating: dish.rating,
                        remarks: dish.remarks,
                        photos: dish.photos || []
                    });
                });
            } else {
                // Add one empty dish card
                addDishCard();
            }

            // Set overall ratings
            document.getElementById('overall-stars').dataset.rating = currentReview.overall_rating;
            document.getElementById('price-rating').dataset.rating = currentReview.price_rating;
            document.getElementById('overall-remarks').value = currentReview.overall_remarks || '';

            // Initialize overall photos grid (max 3 photos)
            const overallPhotosGrid = document.getElementById('overall-photos');
            const overallPhotos = (currentReview.photos || []).filter(p => !p.dish_id);
            updatePhotoGrid(overallPhotosGrid, overallPhotos, 3, null);

            // Show edit timestamp using consistent relative format
            if (currentReview.updated_at) {
                const date = new Date(currentReview.updated_at);
                document.getElementById('overall-edited').textContent = `Edited ${formatTimeAgo(date)}`;
            }

            // Show delete button for existing review
            document.getElementById('delete-review-btn').style.display = 'block';

            // Update save button text for edit mode
            document.getElementById('save-review-btn').textContent = 'Update Review';

        } else if (response.status === 404) {
            // No existing review - start fresh
            currentReview = null;
            addDishCard();
            document.getElementById('overall-stars').dataset.rating = 0;
            document.getElementById('price-rating').dataset.rating = 0;
            document.getElementById('overall-remarks').value = '';
            document.getElementById('overall-edited').textContent = '';
            document.getElementById('delete-review-btn').style.display = 'none';

            // Update save button text for new review
            document.getElementById('save-review-btn').textContent = 'Save Review';
            // Initialize empty overall photos grid
            updatePhotoGrid(document.getElementById('overall-photos'), [], 3, null);
        }
    } catch (error) {
        console.error('Failed to load review:', error);
        currentReview = null;
        addDishCard();
        document.getElementById('delete-review-btn').style.display = 'none';
        document.getElementById('save-review-btn').textContent = 'Save Review';
        // Initialize empty overall photos grid
        updatePhotoGrid(document.getElementById('overall-photos'), [], 3, null);
    }

    // Initialize rating components
    initStarRating(document.getElementById('overall-stars'));
    initPriceRating(document.getElementById('price-rating'));

    // Show sheet
    document.getElementById('review-sheet').style.display = 'flex';
    hapticFeedback('light');
}

// Close review sheet
function closeReviewSheet() {
    document.getElementById('review-sheet').style.display = 'none';
    currentReviewPlaceId = null;
    currentReview = null;
}

// Save review
async function saveReview() {
    if (!currentReviewPlaceId) return;

    const overallRating = parseInt(document.getElementById('overall-stars').dataset.rating) || 0;
    const priceRating = parseInt(document.getElementById('price-rating').dataset.rating) || 0;
    const overallRemarks = document.getElementById('overall-remarks').value.trim();
    const dishes = collectDishData();

    // Validation
    if (overallRating === 0) {
        showToast('Please rate the overall experience');
        return;
    }
    if (priceRating === 0) {
        showToast('Please rate the price');
        return;
    }

    hapticFeedback('medium');

    try {
        const response = await fetch(`${API_URL}/api/places/${currentReviewPlaceId}/review`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify({
                overall_rating: overallRating,
                price_rating: priceRating,
                overall_remarks: overallRemarks || null,
                dishes: dishes
            })
        });

        if (!response.ok) throw new Error('Failed to save review');

        const data = await response.json();
        showToast('Review saved! ⭐');
        closeReviewSheet();

        // Reload reviews and refresh displays
        await loadReviews();
        applyFilters();
        displayPlacesOnMap(false);

    } catch (error) {
        console.error('Failed to save review:', error);
        showToast('Failed to save review 😅', saveReview);
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
            headers: { 'ngrok-skip-browser-warning': 'true' }
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
            headers: { 'ngrok-skip-browser-warning': 'true' },
            body: formData
        });

        if (response.ok) {
            const photo = await response.json();
            showToast('Photo added!');
            return photo;
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
                        const photo = JSON.parse(xhr.responseText);
                        showToast('Photo added!');
                        resolve(photo);
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
            xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');
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
                headers: { 'ngrok-skip-browser-warning': 'true' }
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
    photos.forEach(photo => {
        const thumb = document.createElement('div');
        thumb.className = 'photo-thumb';
        thumb.dataset.photoId = photo.id;
        thumb.innerHTML = `
            <img src="${photo.url}" alt="Photo">
            <button type="button" class="photo-delete-btn" aria-label="Remove photo">×</button>
        `;

        // Delete handler
        thumb.querySelector('.photo-delete-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!currentReview?.id) return;
            if (await deletePhoto(currentReview.id, photo.id)) {
                thumb.remove();
                // Show add button if under limit
                if (container.querySelectorAll('.photo-thumb').length < maxPhotos) {
                    addPhotoButton(container, maxPhotos, dishId);
                }
            }
        });

        // Tap to view full size
        thumb.querySelector('img').addEventListener('click', () => {
            viewPhotoFullscreen(photo.url);
        });

        container.appendChild(thumb);
    });

    // Add "+" button if under limit
    if (photos.length < maxPhotos) {
        addPhotoButton(container, maxPhotos, dishId);
    }
}

/**
 * Add photo upload button to grid
 */
function addPhotoButton(container, maxPhotos, dishId) {
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

        // Need review to be saved first
        if (!currentReview?.id) {
            showToast('Please save your review first to add photos');
            e.target.value = '';
            return;
        }

        // Validate file before showing placeholder
        const validation = validateImageFile(file);
        if (!validation.valid) {
            showToast(validation.error);
            e.target.value = '';
            return;
        }

        // Create placeholder with progress indicator
        const placeholder = document.createElement('div');
        placeholder.className = 'photo-uploading';
        placeholder.innerHTML = `
            <div class="upload-spinner"></div>
            <div class="upload-progress-bar"><div class="progress-fill"></div></div>
        `;
        container.insertBefore(placeholder, label);

        // Upload with progress tracking
        const photo = await uploadPhotoWithProgress(currentReview.id, file, dishId, (progress) => {
            const fill = placeholder.querySelector('.progress-fill');
            if (fill) fill.style.width = `${progress}%`;
        });

        if (photo) {
            // Replace placeholder with actual photo
            const thumb = document.createElement('div');
            thumb.className = 'photo-thumb';
            thumb.dataset.photoId = photo.id;
            thumb.innerHTML = `
                <img src="${photo.url}" alt="Photo">
                <button type="button" class="photo-delete-btn" aria-label="Remove photo">×</button>
            `;

            // Add delete handler
            thumb.querySelector('.photo-delete-btn').addEventListener('click', async (evt) => {
                evt.stopPropagation();
                if (await deletePhoto(currentReview.id, photo.id)) {
                    thumb.remove();
                    if (container.querySelectorAll('.photo-thumb').length < maxPhotos) {
                        addPhotoButton(container, maxPhotos, dishId);
                    }
                }
            });

            // Add fullscreen handler
            thumb.querySelector('img').addEventListener('click', () => {
                viewPhotoFullscreen(photo.url);
            });

            placeholder.replaceWith(thumb);

            // Hide add button if at limit
            if (container.querySelectorAll('.photo-thumb').length >= maxPhotos) {
                label.remove();
            }
        } else {
            // Remove placeholder on error
            placeholder.remove();
        }

        // Reset input
        e.target.value = '';
    });

    container.appendChild(label);
}

/**
 * View photo in fullscreen overlay
 */
function viewPhotoFullscreen(url) {
    const overlay = document.createElement('div');
    overlay.className = 'photo-fullscreen';
    overlay.innerHTML = `
        <img src="${url}" alt="Photo">
        <button class="photo-fullscreen-close" aria-label="Close">×</button>
    `;
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
}

// Setup review sheet
function setupReviewSheet() {
    document.getElementById('review-sheet-close').addEventListener('click', closeReviewSheet);
    document.getElementById('add-dish-btn').addEventListener('click', () => addDishCard());
    document.getElementById('save-review-btn').addEventListener('click', saveReview);
    document.getElementById('delete-review-btn').addEventListener('click', deleteReview);

    // Close on backdrop click
    document.getElementById('review-sheet').addEventListener('click', (e) => {
        if (e.target.id === 'review-sheet') {
            closeReviewSheet();
        }
    });
}

// ========== REVIEWS VIEW ==========

// Get review for a place
function getPlaceReview(placeId) {
    return allReviews.find(r => r.place_id === placeId);
}

// Load reviews from API
async function loadReviews() {
    try {
        const response = await fetch(`${API_URL}/api/reviews`, {
            headers: { 'ngrok-skip-browser-warning': 'true' }
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
    const countEl = document.querySelector('.reviews-count');

    // Apply current sort and filter
    const sorted = sortReviews(allReviews);
    const filtered = filterReviews(sorted);

    // Update count
    countEl.textContent = `${filtered.length} ${filtered.length === 1 ? 'review' : 'reviews'}`;

    // Show empty state if no reviews
    if (filtered.length === 0) {
        container.innerHTML = '';
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';

    // Render cards
    container.innerHTML = filtered.map(review => createReviewCard(review)).join('');

    // Add click handlers
    container.querySelectorAll('.review-card').forEach(card => {
        card.addEventListener('click', () => {
            const placeId = parseInt(card.dataset.placeId);
            openReviewSheetFromHistory(placeId);
            hapticFeedback('light');
        });
    });
}

// Create HTML for review card
function createReviewCard(review) {
    // Calculate photo count
    const dishPhotos = review.dishes.reduce((sum, d) => sum + (d.photos?.length || 0), 0);
    const overallPhotos = review.overall_photos?.length || 0;
    const totalPhotos = dishPhotos + overallPhotos;

    // Render stars
    const stars = '⭐'.repeat(review.overall_rating) + '☆'.repeat(5 - review.overall_rating);

    // Price rating
    const priceLabels = ['', '💰 Budget', '💰💰 Affordable', '💰💰💰 Moderate', '💰💰💰💰 Pricey', '💰💰💰💰💰 Splurge'];
    const priceText = priceLabels[review.price_rating] || '';

    // Truncate remarks
    const preview = review.overall_remarks
        ? (review.overall_remarks.length > 80
            ? review.overall_remarks.slice(0, 80) + '...'
            : review.overall_remarks)
        : '';

    // Format timestamp
    const date = new Date(review.updated_at || review.created_at);
    const timeAgo = formatTimeAgo(date);

    return `
        <div class="review-card" data-place-id="${review.place_id}">
            <div class="review-card-header">
                <div class="review-card-place">${review.place_name || 'Unknown Place'}</div>
                <div class="review-card-rating">
                    <span class="review-stars">${stars}</span>
                    <span class="review-rating-num">${review.overall_rating}/5</span>
                </div>
            </div>
            ${priceText ? `<div class="review-card-price">${priceText}</div>` : ''}
            <div class="review-card-meta">
                ${totalPhotos > 0 ? `📸 ${totalPhotos} photo${totalPhotos > 1 ? 's' : ''}` : ''}
                ${totalPhotos > 0 && review.dishes.length > 0 ? ' • ' : ''}
                ${review.dishes.length} dish${review.dishes.length !== 1 ? 'es' : ''}
            </div>
            ${preview ? `<div class="review-card-preview">"${preview}"</div>` : ''}
            <div class="review-card-footer">📅 ${timeAgo}</div>
        </div>
    `;
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

// Sort reviews
function sortReviews(reviews) {
    const sortBy = document.getElementById('reviews-sort')?.value || 'newest';
    const sorted = [...reviews];

    switch (sortBy) {
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

// Filter reviews
function filterReviews(reviews) {
    const activeFilter = document.querySelector('.review-filter-chip.active')?.dataset.filter || 'all';

    return reviews.filter(review => {
        switch (activeFilter) {
            case 'all':
                return true;
            case 'photos':
                const dishPhotos = review.dishes.reduce((sum, d) => sum + (d.photos?.length || 0), 0);
                const overallPhotos = review.overall_photos?.length || 0;
                return (dishPhotos + overallPhotos) > 0;
            case '5star':
                return review.overall_rating === 5;
            case '4star':
                return review.overall_rating === 4;
            default:
                return true;
        }
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
    // Sort dropdown change handler
    document.getElementById('reviews-sort')?.addEventListener('change', renderReviews);

    // Filter chips click handlers
    document.querySelectorAll('.review-filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.review-filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            renderReviews();
            hapticFeedback('light');
        });
    });
}

// Run on DOM ready
document.addEventListener('DOMContentLoaded', initApp);
