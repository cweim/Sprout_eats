// Configuration
const API_URL = ''; // Set to your API URL, e.g., 'http://localhost:8000'

// State
let places = [];
let currentView = 'map';
let map = null;
let markersLayer = null;
let userLocationMarker = null;

// Filter state
let searchQuery = '';
let activeCategories = new Set();
let sortBy = 'newest';
let searchDebounceTimer = null;

// Notes modal state
let currentEditingPlaceId = null;

// Location state
let userLocation = null;

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
function requestUserLocation() {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
        (position) => {
            userLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
            };
            console.log('User location acquired:', userLocation);
            // Re-render with distances
            applyFilters();
            displayPlacesOnMap();
        },
        (error) => {
            // Silently fail - user can manually request location later
            console.log('Location not available:', error.message);
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
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

        return tg;
    } else {
        console.log('Not running in Telegram WebApp context');
        return null;
    }
}

// Fetch places from API
async function fetchPlaces() {
    if (!API_URL) {
        console.log('API_URL not configured, using mock data');
        // Return mock data for testing
        return [
            {
                id: 1,
                name: 'Sample Cafe',
                address: '123 Main Street, Tokyo',
                latitude: 35.6762,
                longitude: 139.6503,
                google_place_id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
                place_types: 'cafe,restaurant',
                place_rating: 4.5,
                place_rating_count: 120,
                source_url: 'https://instagram.com/p/example',
                source_platform: 'instagram',
                created_at: '2026-04-01',
                is_visited: true,
                notes: 'Great coffee and cozy atmosphere!'
            },
            {
                id: 2,
                name: 'Mountain View Restaurant',
                address: '456 Hill Road, Kyoto',
                latitude: 35.0116,
                longitude: 135.7681,
                google_place_id: 'ChIJ8cM8zdaoAWARPR27azYdlsA',
                place_types: 'restaurant,japanese_restaurant',
                place_rating: 4.8,
                place_rating_count: 250,
                source_url: 'https://tiktok.com/@user/video/123',
                source_platform: 'tiktok',
                created_at: '2026-04-02',
                is_visited: false,
                notes: null
            },
            {
                id: 3,
                name: 'Sunset Bar',
                address: '789 Beach Road, Osaka',
                latitude: 34.6937,
                longitude: 135.5023,
                google_place_id: 'ChIJA2xB3rDmAGARo1IV2P6BSD4',
                place_types: 'bar,night_club',
                place_rating: 4.2,
                place_rating_count: 85,
                source_url: 'https://instagram.com/p/sunset',
                source_platform: 'instagram',
                created_at: '2026-03-30',
                is_visited: false,
                notes: null
            }
        ];
    }

    try {
        const response = await fetch(`${API_URL}/api/places`);
        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status}`);
        }
        const data = await response.json();
        return data.places || [];
    } catch (error) {
        console.error('Failed to fetch places:', error);
        return [];
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

// Initialize Leaflet map
function initMap() {
    // Create map centered at [0, 0] with low zoom (will fit bounds later)
    map = L.map('map', {
        zoomControl: true,
        attributionControl: true
    }).setView([0, 0], 2);

    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(map);

    // Create layer group for markers
    markersLayer = L.layerGroup().addTo(map);

    return map;
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

    // Meta info (rating and types)
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
    if (metaHtml) {
        html += `<div class="place-popup-meta">${metaHtml}</div>`;
    }

    // Visited toggle
    const visitedClass = place.is_visited ? ' active' : '';
    const visitedText = place.is_visited ? '✓ Visited' : 'Mark visited';
    html += `<div class="visited-toggle">
        <button class="visited-toggle-btn${visitedClass}" onclick="toggleVisited(${place.id})">${visitedText}</button>
        <button class="add-notes-btn" onclick="openNotesForPlace(${place.id})">📝 ${place.notes ? 'Edit notes' : 'Add notes'}</button>
    </div>`;

    // Notes preview
    if (place.notes) {
        const truncated = place.notes.length > 60 ? place.notes.substring(0, 60) + '...' : place.notes;
        html += `<div class="notes-preview">${truncated}</div>`;
    }

    // Action buttons
    html += '<div class="place-popup-actions">';

    // Google Maps link
    if (place.google_place_id) {
        html += `<a href="https://www.google.com/maps/place/?q=place_id:${place.google_place_id}"
                    target="_blank" class="popup-action-btn primary">📍 Google Maps</a>`;
    } else if (place.latitude && place.longitude) {
        html += `<a href="https://www.google.com/maps?q=${place.latitude},${place.longitude}"
                    target="_blank" class="popup-action-btn primary">📍 Google Maps</a>`;
    }

    // Original reel link
    if (place.source_url) {
        html += `<a href="${place.source_url}" target="_blank" class="popup-action-btn">▶ Original</a>`;
    }

    html += '</div></div>';

    return html;
}

// Toggle visited status from popup
function toggleVisited(placeId) {
    const place = places.find(p => p.id === placeId);
    if (place) {
        updatePlaceVisited(placeId, !place.is_visited);
    }
}

// Open notes modal from popup
function openNotesForPlace(placeId) {
    const place = places.find(p => p.id === placeId);
    if (place) {
        openNotesModal(place);
    }
}

// Add markers for all places
function displayPlacesOnMap() {
    if (!map || !markersLayer) return;

    // Clear existing markers
    markersLayer.clearLayers();

    if (places.length === 0) {
        // No places - show world view
        map.setView([20, 0], 2);
        return;
    }

    // Add marker for each place
    places.forEach(place => {
        if (place.latitude && place.longitude) {
            const marker = L.marker([place.latitude, place.longitude]);
            marker.placeData = place;

            // Bind popup with place details
            marker.bindPopup(createPopupContent(place), {
                maxWidth: 280,
                className: 'custom-popup'
            });

            markersLayer.addLayer(marker);
        }
    });

    // Fit map to show all markers
    if (markersLayer.getLayers().length > 0) {
        const bounds = markersLayer.getBounds();
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    }
}

// Show toast message
function showToast(message) {
    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    // Animate in
    setTimeout(() => toast.classList.add('show'), 10);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
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
            map.setView([latitude, longitude], 14);

            showToast("Here you are!");

            // Re-render views with distances
            applyFilters();
            displayPlacesOnMap();
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

    // Name row with platform icon
    let nameHtml = `<div class="place-card-header">`;
    nameHtml += `<span class="place-card-name">${place.name}</span>`;
    nameHtml += `<span class="place-card-platform">${getPlatformIcon(place.source_platform)}</span>`;
    nameHtml += `</div>`;

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

    // Footer with visited badge and notes indicator
    let footerHtml = '';
    if (place.is_visited || place.notes) {
        footerHtml = '<div class="place-card-footer">';
        if (place.is_visited) {
            footerHtml += '<span class="visited-badge">✓ Visited</span>';
        }
        if (place.notes) {
            footerHtml += '<span class="notes-indicator">📝 Has notes</span>';
        }
        footerHtml += '</div>';
    }

    card.innerHTML = nameHtml + addressHtml + metaHtml + footerHtml;

    // Click handler - show on map
    card.addEventListener('click', () => showPlaceOnMap(place));

    return card;
}

// Show a specific place on the map
function showPlaceOnMap(place) {
    if (!place.latitude || !place.longitude) {
        showToast("No location data for this place");
        return;
    }

    // Switch to map view
    switchView('map');

    // Find and open the marker for this place
    setTimeout(() => {
        markersLayer.eachLayer(marker => {
            if (marker.placeData && marker.placeData.id === place.id) {
                // Pan to marker and open popup
                map.setView([place.latitude, place.longitude], 15);
                marker.openPopup();
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
    if (showing === total) {
        countEl.textContent = `${total} places`;
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

// Render category filter chips
function renderFilterChips() {
    const container = document.getElementById('filter-chips');
    container.innerHTML = '';

    // "All" chip
    const allChip = document.createElement('button');
    allChip.className = 'filter-chip' + (activeCategories.size === 0 ? ' active' : '');
    allChip.textContent = 'All';
    allChip.addEventListener('click', () => {
        activeCategories.clear();
        applyFilters();
    });
    container.appendChild(allChip);

    // Category chips
    const categories = getUniqueCategories();
    categories.forEach(category => {
        const chip = document.createElement('button');
        chip.className = 'filter-chip' + (activeCategories.has(category) ? ' active' : '');
        chip.textContent = category.charAt(0).toUpperCase() + category.slice(1);
        chip.addEventListener('click', () => {
            if (activeCategories.has(category)) {
                activeCategories.delete(category);
            } else {
                activeCategories.add(category);
            }
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

// Filter places by categories
function filterByCategory(placesToFilter) {
    if (activeCategories.size === 0) return placesToFilter;

    return placesToFilter.filter(place => {
        const primary = getPrimaryCategory(place.place_types);
        return primary && activeCategories.has(primary);
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

    // Apply search filter
    filtered = filterBySearch(filtered);

    // Apply category filter
    filtered = filterByCategory(filtered);

    // Apply sort
    filtered = sortPlaces(filtered);

    // Re-render list
    renderPlacesList(filtered);

    // Update filter chips to show active state
    renderFilterChips();

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

// Setup sort functionality
function setupSort() {
    const sortSelect = document.getElementById('sort-select');
    sortSelect.addEventListener('change', (e) => {
        sortBy = e.target.value;
        applyFilters();
    });
}

// Setup list controls (search, filters, sort)
function setupListControls() {
    setupSearch();
    setupSort();
    renderFilterChips();
}

// ========== VISITED & NOTES FUNCTIONALITY ==========

// Trigger haptic feedback if available
function hapticFeedback(style = 'light') {
    if (window.Telegram?.WebApp?.HapticFeedback) {
        window.Telegram.WebApp.HapticFeedback.impactOccurred(style);
    }
}

// Update place visited status via API
async function updatePlaceVisited(placeId, isVisited) {
    // Update local state immediately
    const place = places.find(p => p.id === placeId);
    if (place) {
        place.is_visited = isVisited;
    }

    // Haptic feedback
    hapticFeedback('light');

    // Show feedback
    showToast(isVisited ? '✓ Marked as visited!' : 'Unmarked');

    // If API is configured, persist to server
    if (API_URL) {
        try {
            const response = await fetch(`${API_URL}/api/places/${placeId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
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
    }

    // Re-render affected views
    applyFilters();
    displayPlacesOnMap();
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
    showToast('Notes saved!');

    // If API is configured, persist to server
    if (API_URL) {
        try {
            const response = await fetch(`${API_URL}/api/places/${placeId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notes: notes })
            });
            if (!response.ok) {
                throw new Error('Failed to update');
            }
        } catch (error) {
            console.error('Failed to update notes:', error);
            showToast('Failed to save notes');
        }
    }

    // Re-render affected views
    applyFilters();
    displayPlacesOnMap();
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

    updatePlaceNotes(currentEditingPlaceId, notes || null);
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

// Switch view
function switchView(view) {
    currentView = view;

    // Update toggle buttons
    document.getElementById('btn-map').classList.toggle('active', view === 'map');
    document.getElementById('btn-list').classList.toggle('active', view === 'list');

    // Update view visibility
    document.getElementById('map-view').classList.toggle('active', view === 'map');
    document.getElementById('list-view').classList.toggle('active', view === 'list');

    // Invalidate map size when switching to map view
    if (view === 'map' && map) {
        setTimeout(() => map.invalidateSize(), 100);
    }
}

// View toggle event listeners
function setupViewToggle() {
    document.getElementById('btn-map').addEventListener('click', () => switchView('map'));
    document.getElementById('btn-list').addEventListener('click', () => switchView('list'));
}

// Initialize app
async function initApp() {
    // Initialize Telegram
    const tg = initTelegram();

    // Setup view toggle
    setupViewToggle();

    // Initialize map
    initMap();

    // Setup map controls
    setupMapControls();

    // Show loading
    showLoading();

    // Fetch places
    places = await fetchPlaces();

    // Hide loading
    hideLoading();

    // Check if empty
    if (places.length === 0) {
        showEmptyState();
        return;
    }

    // Display places on map
    displayPlacesOnMap();

    // Request user location (non-blocking)
    requestUserLocation();

    // Setup list controls (search, filters, sort)
    setupListControls();

    // Setup notes modal
    setupNotesModal();

    // Render list view
    renderPlacesList(places);

    // Show map view by default
    switchView('map');

    console.log(`Loaded ${places.length} places`);
}

// Run on DOM ready
document.addEventListener('DOMContentLoaded', initApp);
