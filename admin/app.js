let supabaseClient = null;
let adminSession = null;
let activeReportId = null;
let activeUserId = null;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function loadPublicConfig() {
    const response = await fetch('/admin/api/config');
    if (!response.ok) throw new Error('Failed to load admin config');
    return response.json();
}

async function initSupabase() {
    const config = await loadPublicConfig();
    // anon key is the Supabase publishable key — safe to bundle in frontend
    const anonKey = 'sb_publishable_efCy9RWQu8POHpBtXZ7c1g_imylroHj';
    supabaseClient = window.supabase.createClient(config.supabase_url, anonKey);
}

async function getAccessToken() {
    const { data } = await supabaseClient.auth.getSession();
    return data.session?.access_token || null;
}

async function adminFetch(path, options = {}) {
    const token = await getAccessToken();
    const headers = {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
    };
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401 || response.status === 403) {
        showLogin();
        throw new Error('Admin session expired');
    }
    return response;
}

function showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app-screen').classList.add('hidden');
}

function showApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
}

function renderOverviewCards(overview) {
    const cards = [
        ['Users', overview.users_total],
        ['New Users (7d)', overview.users_new_7d],
        ['Places Saved', overview.places_total],
        ['New Places (7d)', overview.places_new_7d ?? '—'],
        ['Visited', `${overview.places_visited_total} (${(overview.visited_rate * 100).toFixed(0)}%)`],
        ['Reviews', `${overview.reviews_total} (${(overview.review_rate * 100).toFixed(0)}%)`],
        ['Pending Reminders', overview.pending_reminders],
        ['Open Feedback', `${overview.feedback_open} / ${overview.feedback_total}`],
        ['Failed Extractions (7d)', overview.failed_extractions_7d ?? '—'],
        ['Failed Total', overview.failed_extractions_total ?? '—'],
    ];
    document.getElementById('overview-cards').innerHTML = cards.map(([label, value]) => `
        <div class="card">
            <div class="card-label">${label}</div>
            <div class="card-value">${value}</div>
        </div>
    `).join('');
}

function formatReportMeta(report) {
    const attachmentCount = report.attachments?.length || 0;
    return `
        <div class="report-meta">
            <span class="badge">${report.category}</span>
            <span class="badge">${report.status}</span>
            <span>${report.source}</span>
            <span>${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}</span>
        </div>
    `;
}

function renderReportList(reports, total) {
    document.getElementById('feedback-summary').textContent = `${total} report${total === 1 ? '' : 's'}`;
    const container = document.getElementById('report-list');
    if (!reports.length) {
        container.innerHTML = '<div class="report-item">No reports found.</div>';
        return;
    }
    container.innerHTML = reports.map(report => `
        <div class="report-item ${report.id === activeReportId ? 'active' : ''}" data-report-id="${report.id}">
            <div><strong>#${report.id}</strong> ${escapeHtml(report.title || report.body || 'Untitled report')}</div>
            ${formatReportMeta(report)}
        </div>
    `).join('');
    container.querySelectorAll('.report-item[data-report-id]').forEach(item => {
        item.addEventListener('click', () => loadReportDetail(parseInt(item.dataset.reportId, 10)));
    });
}

function renderAttachments(attachments) {
    if (!attachments?.length) return '<p>No attachments.</p>';
    return `
        <div class="attachment-grid">
            ${attachments.map((attachment) => {
                if (attachment.attachment_type === 'image' && attachment.file_url) {
                    return `<a href="${encodeURI(attachment.file_url)}" target="_blank" rel="noreferrer"><img src="${encodeURI(attachment.file_url)}" alt="attachment"></a>`;
                }
                if (attachment.attachment_type === 'link') {
                    const link = attachment.text_content || attachment.file_url || '';
                    return `<div class="card"><a href="${encodeURI(link)}" target="_blank" rel="noreferrer">${escapeHtml(link)}</a></div>`;
                }
                return `<div class="card">${escapeHtml(attachment.text_content || '')}</div>`;
            }).join('')}
        </div>
    `;
}

function renderReportDetail(report) {
    const detail = document.getElementById('report-detail');
    detail.classList.remove('empty');
    detail.innerHTML = `
        <div class="detail-section">
            <h3>Report #${report.id}</h3>
            ${formatReportMeta(report)}
        </div>
        <div class="detail-section">
            <div class="detail-label">Body</div>
            <div>${escapeHtml(report.body || 'No primary body.')}</div>
        </div>
        <div class="detail-section">
            <div class="detail-label">Source Link</div>
            <div>${report.source_link ? `<a href="${encodeURI(report.source_link)}" target="_blank" rel="noreferrer">${escapeHtml(report.source_link)}</a>` : 'None'}</div>
        </div>
        <div class="detail-section">
            <div class="detail-label">Attachments</div>
            ${renderAttachments(report.attachments)}
        </div>
        <div class="detail-section detail-actions">
            <div class="detail-label">Triage</div>
            <select id="detail-status">
                ${['new', 'triaged', 'in_progress', 'resolved', 'wont_fix'].map(v => `<option value="${v}" ${report.status === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
            <select id="detail-severity">
                <option value="">No severity</option>
                ${['low', 'medium', 'high'].map(v => `<option value="${v}" ${report.severity === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
            <textarea id="detail-admin-notes" placeholder="Admin notes"></textarea>
            <button id="save-report">Save Changes</button>
        </div>
    `;
    document.getElementById('detail-admin-notes').value = report.admin_notes || '';
    document.getElementById('save-report').addEventListener('click', async () => {
        await saveReportDetail(report.id);
    });
}

async function loadOverview() {
    const response = await adminFetch('/admin/api/dashboard/overview');
    const overview = await response.json();
    renderOverviewCards(overview);
}

async function loadReports() {
    const params = new URLSearchParams();
    const status = document.getElementById('filter-status').value;
    const category = document.getElementById('filter-category').value;
    const source = document.getElementById('filter-source').value;
    const search = document.getElementById('filter-search').value.trim();
    if (status) params.set('status', status);
    if (category) params.set('category', category);
    if (source) params.set('source', source);
    if (search) params.set('search', search);

    const response = await adminFetch(`/admin/api/feedback?${params.toString()}`);
    const data = await response.json();
    renderReportList(data.reports, data.total);
}

async function loadReportDetail(reportId) {
    activeReportId = reportId;
    await loadReports();
    const response = await adminFetch(`/admin/api/feedback/${reportId}`);
    const data = await response.json();
    renderReportDetail(data.report);
}

async function saveReportDetail(reportId) {
    const payload = {
        status: document.getElementById('detail-status').value,
        severity: document.getElementById('detail-severity').value || null,
        admin_notes: document.getElementById('detail-admin-notes').value.trim() || null,
    };
    const response = await adminFetch(`/admin/api/feedback/${reportId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        alert('Failed to save report');
        return;
    }
    await loadReportDetail(reportId);
}

async function validateAdminSession() {
    const { data } = await supabaseClient.auth.getSession();
    if (!data.session) {
        showLogin();
        return;
    }
    try {
        const response = await adminFetch('/admin/api/session');
        const payload = await response.json();
        adminSession = payload.admin;
        document.getElementById('admin-email').textContent = payload.admin.email;
        showApp();
        await Promise.all([loadOverview(), loadReports()]);
    } catch (error) {
        showLogin();
    }
}

function bindFilters() {
    ['filter-status', 'filter-category', 'filter-source'].forEach((id) => {
        document.getElementById(id).addEventListener('change', loadReports);
    });
    document.getElementById('filter-search').addEventListener('input', () => {
        window.clearTimeout(window._searchDebounce);
        window._searchDebounce = window.setTimeout(loadReports, 300);
    });
}

// ── Tab navigation ────────────────────────────────────────────────────────────

function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
            btn.classList.add('active');
            const panel = document.querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`);
            if (panel) panel.classList.remove('hidden');
            if (btn.dataset.tab === 'failed-links') loadFailedLinks();
            if (btn.dataset.tab === 'users') loadUsers();
            if (btn.dataset.tab === 'places') loadPlaces();
            if (btn.dataset.tab === 'restaurants') loadRestaurants();
        });
    });
}

// ── Failed Links ──────────────────────────────────────────────────────────────

let failedLinksOffset = 0;
const FAILED_PAGE_SIZE = 50;

async function loadFailedLinks() {
    const tbody = document.getElementById('failed-tbody');
    tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">Loading…</td></tr>`;
    const platform = document.getElementById('failed-filter-platform').value;
    const params = new URLSearchParams({ limit: FAILED_PAGE_SIZE, offset: failedLinksOffset });
    if (platform) params.set('platform', platform);
    const response = await adminFetch(`/admin/api/failed-extractions?${params}`);
    if (!response.ok) return;
    const data = await response.json();
    renderFailedLinks(data.rows, data.total);
}

function renderFailedLinks(rows, total) {
    const tbody = document.getElementById('failed-tbody');
    const empty = document.getElementById('failed-empty');
    const summary = document.getElementById('failed-summary');
    const pagination = document.getElementById('failed-pagination');

    summary.textContent = `${total} failed extraction${total === 1 ? '' : 's'} recorded`;

    if (!rows.length) {
        tbody.innerHTML = '';
        empty.classList.remove('hidden');
        pagination.innerHTML = '';
        return;
    }
    empty.classList.add('hidden');

    tbody.innerHTML = rows.map((row) => {
        const date = new Date(row.created_at).toLocaleString();
        const url = escapeHtml(row.url);
        const preview = escapeHtml(row.caption_preview || '—');
        const reason = row.reason === 'no_slots' ? 'No slots' : row.reason === 'no_google_match' ? 'No Google match' : escapeHtml(row.reason || '—');
        return `<tr>
            <td>${escapeHtml(date)}</td>
            <td>${escapeHtml(row.platform || '—')}</td>
            <td><span class="badge">${reason}</span></td>
            <td class="cell-url"><a href="${url}" target="_blank" rel="noopener">${url.length > 60 ? url.slice(0, 60) + '…' : url}</a></td>
            <td class="cell-preview" title="${preview}">${preview.length > 120 ? preview.slice(0, 120) + '…' : preview}</td>
        </tr>`;
    }).join('');

    const totalPages = Math.ceil(total / FAILED_PAGE_SIZE);
    const currentPage = Math.floor(failedLinksOffset / FAILED_PAGE_SIZE) + 1;
    pagination.innerHTML = totalPages > 1
        ? `<button ${currentPage === 1 ? 'disabled' : ''} onclick="failedPage(-1)">← Prev</button>
           <span>Page ${currentPage} of ${totalPages}</span>
           <button ${currentPage === totalPages ? 'disabled' : ''} onclick="failedPage(1)">Next →</button>`
        : '';
}

function failedPage(direction) {
    failedLinksOffset = Math.max(0, failedLinksOffset + direction * FAILED_PAGE_SIZE);
    loadFailedLinks();
}

function bindFailedLinks() {
    document.getElementById('failed-filter-platform').addEventListener('change', () => {
        failedLinksOffset = 0;
        loadFailedLinks();
    });
    document.getElementById('failed-refresh-btn').addEventListener('click', () => {
        failedLinksOffset = 0;
        loadFailedLinks();
    });
}

// ── Users ─────────────────────────────────────────────────────────────────────

async function loadUsers() {
    const list = document.getElementById('users-list');
    list.innerHTML = `<div class="report-item" style="color:#6a5646;font-size:.85rem;padding:16px">Loading…</div>`;
    const response = await adminFetch('/admin/api/users?limit=200');
    if (!response.ok) return;
    const data = await response.json();
    renderUserList(data.users || []);
}

function renderUserList(users) {
    const list = document.getElementById('users-list');
    const empty = document.getElementById('users-empty');
    const summary = document.getElementById('users-summary');
    summary.textContent = `${users.length} user${users.length === 1 ? '' : 's'}`;
    if (!users.length) {
        empty.classList.remove('hidden');
        list.innerHTML = '';
        return;
    }
    empty.classList.add('hidden');
    list.innerHTML = users.map((u) => {
        const name = escapeHtml(u.display_name);
        const username = u.username ? `@${escapeHtml(u.username)}` : '';
        const joined = new Date(u.created_at).toLocaleDateString();
        return `<div class="report-item ${u.id === activeUserId ? 'active' : ''}" data-user-id="${u.id}">
            <div><strong>${name}</strong>${username ? ` <span class="cell-muted">${username}</span>` : ''}</div>
            <div class="report-meta">
                <span class="badge">${u.places_count} places</span>
                <span class="badge">${u.reviews_count} reviews</span>
                <span class="cell-muted">Joined ${joined}</span>
            </div>
        </div>`;
    }).join('');
    list.querySelectorAll('.report-item[data-user-id]').forEach((item) => {
        item.addEventListener('click', () => loadUserDetail(parseInt(item.dataset.userId, 10), users));
    });
}

async function loadUserDetail(userId, users) {
    activeUserId = userId;
    // Re-render list to update active state
    renderUserList(users);

    const detail = document.getElementById('user-detail');
    detail.classList.remove('empty');
    detail.innerHTML = `<div class="loading-cell">Loading saves…</div>`;

    const user = users.find((u) => u.id === userId);
    const response = await adminFetch(`/admin/api/users/${userId}/places?limit=100`);
    if (!response.ok) { detail.innerHTML = '<div class="loading-cell">Failed to load.</div>'; return; }
    const data = await response.json();
    const places = data.places || [];

    const name = escapeHtml(user?.display_name || `User ${userId}`);
    const username = user?.username ? ` (@${escapeHtml(user.username)})` : '';
    const joined = user ? new Date(user.created_at).toLocaleDateString() : '—';

    detail.innerHTML = `
        <div class="detail-section">
            <h3>${name}${username}</h3>
            <div class="report-meta">
                <span class="cell-muted">ID: ${userId}</span>
                <span class="cell-muted">Joined ${joined}</span>
                <span class="badge">${places.length} saves</span>
            </div>
        </div>
        <div class="detail-section">
            <div class="detail-label">Saved Places</div>
            ${places.length === 0 ? '<p style="color:#6a5646;font-size:.88rem">No places saved yet.</p>' : `
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Name</th>
                        <th>Address</th>
                        <th>Platform</th>
                        <th>Visited</th>
                    </tr>
                </thead>
                <tbody>
                    ${places.map((p) => {
                        const date = new Date(p.created_at).toLocaleDateString();
                        const src = p.source_url
                            ? `<a href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>`
                            : escapeHtml(p.name);
                        return `<tr>
                            <td class="cell-muted">${escapeHtml(date)}</td>
                            <td><strong>${src}</strong></td>
                            <td class="cell-muted">${escapeHtml(p.address || '—')}</td>
                            <td>${escapeHtml(p.source_platform || '—')}</td>
                            <td>${p.is_visited ? '✓' : ''}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>`}
        </div>
    `;
}

function bindUsers() {
    document.getElementById('users-refresh-btn').addEventListener('click', () => {
        activeUserId = null;
        document.getElementById('user-detail').classList.add('empty');
        document.getElementById('user-detail').innerHTML = '<p>Select a user to see their saves.</p>';
        loadUsers();
    });
}

// ── Places ────────────────────────────────────────────────────────────────────

let placesOffset = 0;
const PLACES_PAGE_SIZE = 100;

async function loadPlaces() {
    const tbody = document.getElementById('places-tbody');
    tbody.innerHTML = `<tr><td colspan="6" class="loading-cell">Loading…</td></tr>`;
    const platform = document.getElementById('places-filter-platform').value;
    const params = new URLSearchParams({ limit: PLACES_PAGE_SIZE, offset: placesOffset });
    if (platform) params.set('platform', platform);
    const response = await adminFetch(`/admin/api/places?${params}`);
    if (!response.ok) return;
    const data = await response.json();
    renderPlaces(data.places, data.total);
}

function renderPlaces(places, total) {
    const tbody = document.getElementById('places-tbody');
    const empty = document.getElementById('places-empty');
    const summary = document.getElementById('places-summary');
    const pagination = document.getElementById('places-pagination');
    summary.textContent = `${total} place${total === 1 ? '' : 's'} saved`;
    if (!places.length) { empty.classList.remove('hidden'); tbody.innerHTML = ''; pagination.innerHTML = ''; return; }
    empty.classList.add('hidden');
    tbody.innerHTML = places.map((p) => {
        const date = new Date(p.created_at).toLocaleDateString();
        const src = p.source_url
            ? `<a href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener">link</a>`
            : '—';
        return `<tr>
            <td class="cell-muted">${escapeHtml(date)}</td>
            <td><strong>${escapeHtml(p.name)}</strong></td>
            <td class="cell-muted">${escapeHtml(p.address || '—')}</td>
            <td>${escapeHtml(p.source_platform || '—')}</td>
            <td>${p.is_visited ? '✓' : ''}</td>
            <td>${src}</td>
        </tr>`;
    }).join('');
    const totalPages = Math.ceil(total / PLACES_PAGE_SIZE);
    const currentPage = Math.floor(placesOffset / PLACES_PAGE_SIZE) + 1;
    pagination.innerHTML = totalPages > 1
        ? `<button ${currentPage === 1 ? 'disabled' : ''} onclick="placesPage(-1)">← Prev</button>
           <span>Page ${currentPage} of ${totalPages}</span>
           <button ${currentPage === totalPages ? 'disabled' : ''} onclick="placesPage(1)">Next →</button>`
        : '';
}

function placesPage(direction) {
    placesOffset = Math.max(0, placesOffset + direction * PLACES_PAGE_SIZE);
    loadPlaces();
}

function bindPlaces() {
    document.getElementById('places-filter-platform').addEventListener('change', () => {
        placesOffset = 0;
        loadPlaces();
    });
    document.getElementById('places-refresh-btn').addEventListener('click', () => {
        placesOffset = 0;
        loadPlaces();
    });
}

// ── Restaurants ───────────────────────────────────────────────────────────────

let restaurantsOffset = 0;
const RESTAURANTS_PAGE_SIZE = 50;

async function loadRestaurants() {
    const tbody = document.getElementById('restaurants-tbody');
    tbody.innerHTML = `<tr><td colspan="6" class="loading-cell">Loading…</td></tr>`;
    const platform = document.getElementById('restaurants-filter-platform').value;
    const params = new URLSearchParams({ limit: RESTAURANTS_PAGE_SIZE, offset: restaurantsOffset });
    if (platform) params.set('platform', platform);
    const response = await adminFetch(`/admin/api/restaurants?${params}`);
    if (!response.ok) return;
    const data = await response.json();
    renderRestaurants(data.restaurants, data.total);
}

function renderRestaurants(restaurants, total) {
    const tbody = document.getElementById('restaurants-tbody');
    const empty = document.getElementById('restaurants-empty');
    const summary = document.getElementById('restaurants-summary');
    const pagination = document.getElementById('restaurants-pagination');
    summary.textContent = `${total} unique place${total === 1 ? '' : 's'} saved across all users`;
    if (!restaurants.length) { empty.classList.remove('hidden'); tbody.innerHTML = ''; pagination.innerHTML = ''; return; }
    empty.classList.add('hidden');
    tbody.innerHTML = restaurants.map((r) => {
        const lastSaved = new Date(r.last_saved_at).toLocaleDateString();
        const savers = escapeHtml(r.savers.join(', '));
        const saveBadgeClass = r.save_count >= 3 ? 'green' : '';
        return `<tr>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td class="cell-muted">${escapeHtml(r.address || '—')}</td>
            <td><span class="badge ${saveBadgeClass}">${r.save_count}</span></td>
            <td>${r.user_count}</td>
            <td class="cell-preview" title="${savers}">${savers.length > 60 ? savers.slice(0, 60) + '…' : savers}</td>
            <td class="cell-muted">${escapeHtml(lastSaved)}</td>
        </tr>`;
    }).join('');
    const totalPages = Math.ceil(total / RESTAURANTS_PAGE_SIZE);
    const currentPage = Math.floor(restaurantsOffset / RESTAURANTS_PAGE_SIZE) + 1;
    pagination.innerHTML = totalPages > 1
        ? `<button ${currentPage === 1 ? 'disabled' : ''} onclick="restaurantsPage(-1)">← Prev</button>
           <span>Page ${currentPage} of ${totalPages}</span>
           <button ${currentPage === totalPages ? 'disabled' : ''} onclick="restaurantsPage(1)">Next →</button>`
        : '';
}

function restaurantsPage(direction) {
    restaurantsOffset = Math.max(0, restaurantsOffset + direction * RESTAURANTS_PAGE_SIZE);
    loadRestaurants();
}

function bindRestaurants() {
    document.getElementById('restaurants-filter-platform').addEventListener('change', () => {
        restaurantsOffset = 0;
        loadRestaurants();
    });
    document.getElementById('restaurants-refresh-btn').addEventListener('click', () => {
        restaurantsOffset = 0;
        loadRestaurants();
    });
}

function bindLogin() {
    document.getElementById('login-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        document.getElementById('login-error').textContent = '';
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) {
            document.getElementById('login-error').textContent = error.message;
            return;
        }
        await validateAdminSession();
    });

    document.getElementById('sign-out').addEventListener('click', async () => {
        await supabaseClient.auth.signOut();
        adminSession = null;
        activeReportId = null;
        activeUserId = null;
        showLogin();
    });
}

async function init() {
    await initSupabase();
    bindLogin();
    bindFilters();
    bindTabs();
    bindFailedLinks();
    bindUsers();
    bindPlaces();
    bindRestaurants();
    await validateAdminSession();
}

init().catch((error) => {
    console.error(error);
    document.getElementById('login-error').textContent = 'Failed to initialize admin dashboard';
});
