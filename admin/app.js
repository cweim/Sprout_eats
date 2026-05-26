let supabaseClient = null;
let adminSession = null;
let activeReportId = null;

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
        ['Places', overview.places_total],
        ['Visited Places', overview.places_visited_total],
        ['Visited Rate', `${(overview.visited_rate * 100).toFixed(1)}%`],
        ['Reviews', overview.reviews_total],
        ['Review Rate', `${(overview.review_rate * 100).toFixed(1)}%`],
        ['Pending Reminders', overview.pending_reminders],
        ['Feedback', overview.feedback_total],
        ['Open Feedback', overview.feedback_open],
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
        });
    });
}

// ── Failed Links ──────────────────────────────────────────────────────────────

let failedLinksOffset = 0;
const FAILED_PAGE_SIZE = 50;

async function loadFailedLinks() {
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
            <td><a href="${url}" target="_blank" rel="noopener">${url.length > 60 ? url.slice(0, 60) + '…' : url}</a></td>
            <td class="caption-cell" title="${preview}">${preview.length > 120 ? preview.slice(0, 120) + '…' : preview}</td>
        </tr>`;
    }).join('');

    // Pagination
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
        showLogin();
    });
}

async function init() {
    await initSupabase();
    bindLogin();
    bindFilters();
    bindTabs();
    bindFailedLinks();
    await validateAdminSession();
}

init().catch((error) => {
    console.error(error);
    document.getElementById('login-error').textContent = 'Failed to initialize admin dashboard';
});
