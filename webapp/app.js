// Configuration
const API_URL = ''; // Set to your API URL, e.g., 'http://localhost:8000'

// State
let places = [];
let currentView = 'map';
let map = null;
let markersLayer = null;
let userLocationMarker = null;

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
                source_platform: 'instagram'
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
                source_platform: 'tiktok'
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
    let html = '<div class="place-popup">';

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

    // Show map view by default
    switchView('map');

    console.log(`Loaded ${places.length} places`);
}

// Run on DOM ready
document.addEventListener('DOMContentLoaded', initApp);
