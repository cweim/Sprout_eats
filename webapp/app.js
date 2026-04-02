// Configuration
const API_URL = ''; // Set to your API URL, e.g., 'http://localhost:8000'

// State
let places = [];
let currentView = 'map';
let map = null;
let markersLayer = null;

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
                address: '123 Main Street',
                latitude: 35.6762,
                longitude: 139.6503,
                place_types: 'cafe,restaurant',
                place_rating: 4.5,
                place_rating_count: 120,
                source_url: 'https://instagram.com/p/example',
                source_platform: 'instagram'
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
            marker.placeData = place; // Store place data on marker
            markersLayer.addLayer(marker);
        }
    });

    // Fit map to show all markers
    if (markersLayer.getLayers().length > 0) {
        const bounds = markersLayer.getBounds();
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    }
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
