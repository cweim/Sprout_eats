let supabaseClient = null;
let adminSession = null;
let activeReportId = null;
let activeUserId = null;
let analyticsData = null;
let insightRows = [];
let contentOffset = 0;
let contentView = 'posts';
const CONTENT_PAGE_SIZE = 50;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeHttpUrl(value) {
    if (!value) return null;
    try {
        const url = new URL(value, window.location.origin);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch (_) {
        return null;
    }
}

async function loadPublicConfig() {
    const response = await fetch('/admin/api/config');
    if (!response.ok) throw new Error('Failed to load admin config');
    return response.json();
}

async function initSupabase() {
    const config = await loadPublicConfig();
    supabaseClient = window.supabase.createClient(config.supabase_url, config.supabase_anon_key);
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

const numberFmt = new Intl.NumberFormat();
const percentFmt = (value) => value == null ? '—' : `${Math.round(Number(value) * 100)}%`;

function metricDelta(key) {
    const comparison = analyticsData?.comparison?.[key];
    if (!comparison || comparison.percent == null) return '<span class="delta neutral">Newly tracked</span>';
    const direction = comparison.percent > 0 ? 'up' : comparison.percent < 0 ? 'down' : 'neutral';
    const prefix = comparison.percent > 0 ? '+' : '';
    return `<span class="delta ${direction}">${prefix}${comparison.percent}% vs prior</span>`;
}

function kpiCard(label, value, key, note = '') {
    return `<div class="card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${escapeHtml(value)}</div><div class="card-sub">${note || metricDelta(key)}</div></div>`;
}

function renderLineChart(rows) {
    if (!rows?.length) return '<div class="chart-empty">No activity in this period yet.</div>';
    const width = 760, height = 220, pad = 28;
    const max = Math.max(1, ...rows.flatMap(r => [Number(r.value_users || 0), Number(r.saves || 0)]));
    const point = (value, index) => `${pad + index * ((width - pad * 2) / Math.max(rows.length - 1, 1))},${height - pad - (Number(value || 0) / max) * (height - pad * 2)}`;
    const valuePoints = rows.map((r, i) => point(r.value_users, i)).join(' ');
    const savePoints = rows.map((r, i) => point(r.saves, i)).join(' ');
    const labels = rows.filter((_, i) => i === 0 || i === rows.length - 1 || i % Math.ceil(rows.length / 5) === 0).map((r) => {
        const index = rows.indexOf(r); const [x] = point(0, index).split(',');
        return `<text x="${x}" y="215" text-anchor="middle">${new Date(`${r.date}T00:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</text>`;
    }).join('');
    return `<svg class="line-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Value users and saves over time"><line x1="${pad}" y1="${height-pad}" x2="${width-pad}" y2="${height-pad}" stroke="#dfded5"/><polyline points="${savePoints}" fill="none" stroke="#e8a87c" stroke-width="3" vector-effect="non-scaling-stroke"/><polyline points="${valuePoints}" fill="none" stroke="#1e3a2b" stroke-width="4" vector-effect="non-scaling-stroke"/>${labels}</svg>`;
}

function renderSentiment(sentiment = {}) {
    const loved = Number(sentiment.loved || 0), okay = Number(sentiment.okay || 0), meh = Number(sentiment.meh || 0), total = loved + okay + meh;
    if (!total) return '<div class="chart-empty">Reviews with sentiment will appear here.</div>';
    const pct = n => Math.round(n / total * 100);
    return `<div class="sentiment-total"><strong>${total}</strong><span>public + private reviews in period</span></div><div class="stacked-bar" aria-label="Review sentiment mix"><span style="width:${pct(loved)}%;background:#73b98a"></span><span style="width:${pct(okay)}%;background:#e8c878"></span><span style="width:${pct(meh)}%;background:#e8a87c"></span></div><div class="sentiment-legend"><div class="sentiment-row"><span>🔥 Loved</span><strong>${pct(loved)}%</strong></div><div class="sentiment-row"><span>🙂 Okay</span><strong>${pct(okay)}%</strong></div><div class="sentiment-row"><span>😐 Meh / bad</span><strong>${pct(meh)}%</strong></div></div>`;
}

function renderFunnel(rows = []) {
    const first = Number(rows[0]?.count || 0);
    return rows.map((row, index) => {
        const count = Number(row.count || 0);
        const conversion = index === 0 ? 100 : (first ? Math.round(count / first * 100) : 0);
        return `<div class="funnel-step"><span>${escapeHtml(row.stage)}</span><strong>${numberFmt.format(count)}</strong><small>${conversion}% of start</small></div>`;
    }).join('') || '<div class="chart-empty">No journey activity yet.</div>';
}

function renderBars(rows = [], labelKey, valueKey) {
    const max = Math.max(1, ...rows.map(r => Number(r[valueKey] || 0)));
    return `<div class="bar-list">${rows.map(row => `<div class="bar-row"><label title="${escapeHtml(row[labelKey])}">${escapeHtml(row[labelKey] || 'Unknown')}</label><div class="bar-track"><div class="bar-fill" style="width:${Number(row[valueKey] || 0) / max * 100}%"></div></div><strong>${numberFmt.format(row[valueKey] || 0)}</strong></div>`).join('') || '<div class="chart-empty">Nothing to show yet.</div>'}</div>`;
}

function renderAnalytics(data) {
    analyticsData = data;
    const k = data.kpis || {};
    document.getElementById('north-star-value').textContent = numberFmt.format(k.weekly_value_users || 0);
    document.getElementById('north-star-delta').outerHTML = metricDelta('weekly_value_users').replace('<span', '<span id="north-star-delta"');
    document.getElementById('overview-cards').innerHTML = [
        kpiCard('Activation', percentFmt(k.activation_rate), 'activation_rate'),
        kpiCard('Save → visit (30d)', percentFmt(k.save_visit_rate), 'save_visit_rate', k.save_visit_eligible ? `${k.save_visit_eligible} mature saves` : 'Waiting for 30-day follow-up'),
        kpiCard('Visit → review', percentFmt(k.review_completion_rate), 'review_completion_rate'),
        kpiCard('Extraction success', percentFmt(k.extraction_success_rate), 'extraction_success_rate'),
    ].join('');
    document.getElementById('growth-cards').innerHTML = [kpiCard('New users', numberFmt.format(k.new_users || 0), 'new_users'),kpiCard('Activated', numberFmt.format(k.activated_users || 0), 'activated_users'),kpiCard('Activation rate', percentFmt(k.activation_rate), 'activation_rate'),kpiCard('Value users', numberFmt.format(k.weekly_value_users || 0), 'weekly_value_users')].join('');
    document.getElementById('revenue-cards').innerHTML = [kpiCard('Qualified intent', numberFmt.format(k.qualified_intent || 0), 'qualified_intent'),kpiCard('Visits', numberFmt.format(k.visits || 0), 'visits'),kpiCard('Saves', numberFmt.format(k.saves || 0), 'saves'),kpiCard('Reviews', numberFmt.format(k.reviews || 0), 'reviews')].join('');
    document.getElementById('activity-chart').innerHTML = renderLineChart(data.timeline);
    document.getElementById('sentiment-chart').innerHTML = renderSentiment(data.sentiment);
    document.getElementById('overview-funnel').innerHTML = renderFunnel(data.funnel);
    document.getElementById('journey-funnel').innerHTML = renderFunnel(data.funnel);
    document.getElementById('source-bars').innerHTML = renderBars(data.sources, 'source', 'saves');
    document.getElementById('failure-bars').innerHTML = renderBars(data.failure_reasons, 'reason', 'count');
    document.getElementById('cuisine-bars').innerHTML = renderBars(data.top_cuisines, 'label', 'count');
    document.getElementById('city-bars').innerHTML = renderBars(data.top_cities, 'label', 'count');
    const notice = document.getElementById('analytics-notice');
    if (data.tracking_since) {
        notice.textContent = `Interaction metrics are tracked from ${new Date(data.tracking_since).toLocaleDateString()}. Saves, visits, and reviews include historical table data.`;
        notice.classList.remove('hidden');
    }
}

function analyticsParams() {
    const params = new URLSearchParams();
    const start = document.getElementById('analytics-start').value;
    const end = document.getElementById('analytics-end').value;
    if (start) params.set('start', `${start}T00:00:00Z`);
    if (end) { const d = new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); params.set('end', d.toISOString()); }
    const source = document.getElementById('analytics-source').value;
    const city = document.getElementById('analytics-city').value.trim();
    if (source) params.set('source', source); if (city) params.set('city', city);
    return params;
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
        <div class="detail-section thread-section">
            <div class="thread-header">
                <span class="detail-label" style="margin:0">Follow-up thread</span>
                <button class="thread-refresh" onclick="loadFeedbackThread(${report.id})">↻ Refresh</button>
            </div>
            <div id="thread-messages" class="thread-messages"></div>
            <div class="thread-compose">
                <textarea id="thread-input" placeholder="Type a follow-up message to send to the user via Telegram..." rows="3"></textarea>
                <button id="thread-send" onclick="sendThreadMessage(${report.id})">Send to user</button>
            </div>
        </div>
    `;
    document.getElementById('detail-admin-notes').value = report.admin_notes || '';
    document.getElementById('save-report').addEventListener('click', async () => {
        await saveReportDetail(report.id);
    });
}

async function loadOverview() {
    const notice = document.getElementById('analytics-notice');
    try {
        const response = await adminFetch(`/admin/api/analytics/overview?${analyticsParams()}`);
        if (!response.ok) throw new Error('Analytics SQL is not installed');
        renderAnalytics(await response.json());
        await Promise.all([loadRetention(), loadInsightRankings()]);
    } catch (error) {
        const fallback = await adminFetch('/admin/api/dashboard/overview');
        const old = await fallback.json();
        analyticsData = { kpis: { weekly_value_users: 0, new_users: old.users_new_7d, saves: old.places_new_7d, visits: old.places_visited_total, reviews: old.reviews_total } };
        renderAnalytics(analyticsData);
        notice.textContent = 'Analytics migration not available yet. Showing legacy operational totals; run the new Supabase SQL migrations to unlock funnels, retention, and insights.';
        notice.classList.remove('hidden');
    }
}

async function loadRetention() {
    const response = await adminFetch('/admin/api/analytics/retention?weeks=10');
    if (!response.ok) return;
    const rows = (await response.json()).cohorts || [];
    document.getElementById('retention-table').innerHTML = rows.length ? `<table class="retention-table"><thead><tr><th>Cohort</th><th>Activated</th><th>D7 retained</th><th>D7 rate</th><th>D30 retained</th><th>D30 rate</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(new Date(`${row.cohort_week}T00:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric'}))}</td><td>${row.activated_users}</td><td>${row.d7_retained}</td><td class="heat-cell" style="background:rgba(168,213,184,${Math.max(.12,Number(row.d7_rate||0))})">${percentFmt(row.d7_rate)}</td><td>${row.d30_retained}</td><td class="heat-cell" style="background:rgba(232,168,124,${Math.max(.12,Number(row.d30_rate||0))})">${percentFmt(row.d30_rate)}</td></tr>`).join('')}</tbody></table>` : '<div class="chart-empty">Cohorts appear after users activate.</div>';
}

function rankingParams(overrides = {}) {
    const params = new URLSearchParams({
        metric: overrides.metric || document.getElementById('insight-metric').value,
        min_reviews: overrides.min || document.getElementById('insight-min').value,
        limit: '10',
    });
    const city = overrides.city ?? document.getElementById('insight-city').value.trim();
    const cuisine = overrides.cuisine ?? document.getElementById('insight-cuisine').value.trim();
    if (city) params.set('city', city); if (cuisine) params.set('cuisine', cuisine);
    return params;
}

function renderRankingRows(rows) {
    return `<div class="ranking-list">${rows.map((row,index) => `<div class="ranking-row"><span class="rank-number">${index+1}</span><div><h3>${escapeHtml(row.name)}</h3><p>${escapeHtml([row.cuisine,row.city].filter(Boolean).join(' · ') || row.address || '')} · ${row.review_count} independent review${row.review_count===1?'':'s'} · ${row.loved_rate||0}% loved</p><span class="publish-chip ${row.publishable?'':'internal'}">${row.publishable?'Ready to publish':'Internal preview only'}</span></div><div class="rank-score"><strong>${Number(row.adjusted_score||0).toFixed(1)}</strong><span>adjusted</span></div></div>`).join('') || '<div class="chart-empty">No restaurants meet this sample threshold yet.</div>'}</div>`;
}

async function loadInsightRankings() {
    const response = await adminFetch(`/admin/api/insights/rankings?${rankingParams()}`);
    if (!response.ok) return;
    const data = await response.json(); insightRows = data.rankings || [];
    document.getElementById('insight-method').textContent = data.methodology;
    document.getElementById('insight-rankings').innerHTML = renderRankingRows(insightRows);
    const metricText = document.getElementById('insight-metric').selectedOptions[0].textContent;
    const city = document.getElementById('insight-city').value.trim();
    const cuisine = document.getElementById('insight-cuisine').value.trim();
    document.getElementById('story-title').textContent = `${metricText}${cuisine ? ` ${cuisine}` : ''} restaurants${city ? ` in ${city}` : ''}`;
    document.getElementById('story-list').innerHTML = insightRows.slice(0,5).map((row,index) => `<div class="story-item"><span>${index+1}</span><strong>${escapeHtml(row.name)}</strong><em>${Number(row.adjusted_score||0).toFixed(1)}</em></div>`).join('') || '<p>Not enough public reviews yet.</p>';
    document.getElementById('story-footnote').textContent = `Public reviews · Bayesian adjusted · ${new Date().toLocaleDateString()}`;
    document.getElementById('download-insight').disabled = insightRows.length === 0 || insightRows.some(row => !row.publishable);
    const revenue = await adminFetch(`/admin/api/insights/rankings?${rankingParams({metric:'saves',min:'1'})}`);
    if (revenue.ok) document.getElementById('revenue-rankings').innerHTML = renderRankingRows((await revenue.json()).rankings || []);
}

function downloadInsightCard() {
    if (!insightRows.length || insightRows.some(row => !row.publishable)) return;
    const canvas = document.getElementById('export-canvas'), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1E3A2B'; ctx.fillRect(0,0,1080,1350);
    ctx.fillStyle = '#A8D5B8'; ctx.beginPath(); ctx.arc(960,100,260,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '800 48px Nunito, sans-serif'; ctx.fillText('sprout ✦',80,105);
    ctx.fillStyle = '#A8D5B8'; ctx.font = '800 25px Nunito, sans-serif'; ctx.fillText('DINER-POWERED PICKS',80,210);
    const title = document.getElementById('story-title').textContent; ctx.fillStyle='#fff'; ctx.font='800 60px Nunito, sans-serif';
    const words=title.split(' '); let line='', y=290; for(const word of words){const test=`${line}${word} `;if(ctx.measureText(test).width>900&&line){ctx.fillText(line,80,y);line=`${word} `;y+=70}else line=test}ctx.fillText(line,80,y);y+=85;
    insightRows.slice(0,5).forEach((row,index)=>{ctx.fillStyle='#A8D5B8';ctx.font='800 34px Nunito';ctx.fillText(`${index+1}`,80,y);ctx.fillStyle='#fff';ctx.font='700 32px Nunito';ctx.fillText(row.name.slice(0,36),140,y);ctx.textAlign='right';ctx.fillText(Number(row.adjusted_score||0).toFixed(1),995,y);ctx.textAlign='left';ctx.strokeStyle='rgba(255,255,255,.18)';ctx.beginPath();ctx.moveTo(80,y+28);ctx.lineTo(995,y+28);ctx.stroke();y+=105});
    ctx.fillStyle='#C5D7CB';ctx.font='600 22px Nunito';ctx.fillText(`Public reviews · Bayesian adjusted · n ≥ 10 · ${new Date().toLocaleDateString()}`,80,1280);
    const link=document.createElement('a');link.download=`sprout-insight-${new Date().toISOString().slice(0,10)}.png`;link.href=canvas.toDataURL('image/png');link.click();
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
    await loadFeedbackThread(reportId);
}

async function loadFeedbackThread(reportId) {
    const container = document.getElementById('thread-messages');
    if (!container) return;
    const res = await adminFetch(`/admin/api/feedback/${reportId}/thread`);
    if (!res.ok) return;
    const { messages } = await res.json();
    if (!messages || !messages.length) {
        container.innerHTML = '<p class="thread-empty">No messages yet. Send one below to follow up with the user.</p>';
        return;
    }
    container.innerHTML = messages.map(m => {
        const who = m.sender === 'admin' ? (m.admin_email || 'Admin') : 'User';
        const time = new Date(m.created_at).toLocaleString();
        const sentBadge = m.sender === 'admin' && m.telegram_message_id
            ? '<span class="thread-sent-badge">✓ sent</span>' : '';
        return `<div class="thread-bubble thread-bubble--${m.sender}">
            <div class="thread-bubble-text">${escapeHtml(m.message)}</div>
            <div class="thread-bubble-meta">${escapeHtml(who)} · ${escapeHtml(time)}${sentBadge}</div>
        </div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
}

async function sendThreadMessage(reportId) {
    const input = document.getElementById('thread-input');
    const btn = document.getElementById('thread-send');
    const message = (input?.value || '').trim();
    if (!message) return;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
        const res = await adminFetch(`/admin/api/feedback/${reportId}/thread`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
        });
        if (!res.ok) throw new Error('Failed to send');
        input.value = '';
        await loadFeedbackThread(reportId);
    } catch {
        alert('Failed to send message. Please try again.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Send to user';
    }
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
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            const detail = body.detail || `Server returned ${response.status}`;
            document.getElementById('login-error').textContent = detail;
            await supabaseClient.auth.signOut();
            showLogin();
            return;
        }
        const payload = await response.json();
        adminSession = payload.admin;
        document.getElementById('admin-email').textContent = payload.admin.email;
        showApp();
        await Promise.all([loadOverview(), loadReports()]);
        const requestedRestaurant = new URLSearchParams(window.location.search).get('restaurant');
        if (requestedRestaurant) await openRestaurantDetail(requestedRestaurant);
    } catch (error) {
        document.getElementById('login-error').textContent = `Session error: ${error.message}`;
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
    document.getElementById('analytics-apply').addEventListener('click', loadOverview);
    document.getElementById('insight-apply').addEventListener('click', loadInsightRankings);
    document.getElementById('download-insight').addEventListener('click', downloadInsightCard);
}

// ── Tab navigation ────────────────────────────────────────────────────────────

function activateTab(tab, { scroll = true } = {}) {
    const button = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    const panel = document.querySelector(`.tab-panel[data-panel="${tab}"]`);
    if (!button || !panel) return;
    document.querySelectorAll('.tab-btn').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.tab-panel').forEach((item) => item.classList.toggle('hidden', item !== panel));
    document.getElementById('page-heading').textContent = button.textContent.trim();
    document.getElementById('mobile-tab-select').value = tab;
    if (tab === 'failed-links') loadFailedLinks();
    if (tab === 'users') loadUsers();
    if (tab === 'places') loadPlaces();
    if (tab === 'restaurants') loadRestaurants();
    if (tab === 'insights') loadInsightRankings();
    if (tab === 'content') loadContentAnalytics();
    if (scroll && window.matchMedia('(max-width: 760px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => activateTab(btn.dataset.tab, { scroll: false })));
    document.getElementById('mobile-tab-select').addEventListener('change', (event) => activateTab(event.target.value));

    const filterToggle = document.getElementById('mobile-filter-toggle');
    const filters = document.getElementById('global-filters');
    filterToggle.addEventListener('click', () => {
        const isOpen = filters.classList.toggle('is-open');
        filterToggle.setAttribute('aria-expanded', String(isOpen));
        filterToggle.querySelector('span').textContent = isOpen ? '⌃' : '⌄';
    });
}

function annotateResponsiveTables(root = document) {
    const tables = root.matches?.('table') ? [root] : Array.from(root.querySelectorAll('table'));
    tables.forEach((table) => {
        const labels = Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent.trim());
        table.querySelectorAll('tbody tr').forEach((row) => {
            Array.from(row.children).forEach((cell, index) => {
                if (cell.tagName === 'TD' && !cell.hasAttribute('colspan')) cell.dataset.label = labels[index] || '';
            });
        });
    });
}

function watchResponsiveTables() {
    annotateResponsiveTables();
    const observer = new MutationObserver((mutations) => mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.matches?.('table, tr, td') || node.querySelector?.('table, tr, td')) annotateResponsiveTables(node.closest?.('table') || node);
    })));
    observer.observe(document.getElementById('app-screen'), { childList: true, subtree: true });
    observer.observe(document.getElementById('restaurant-drawer'), { childList: true, subtree: true });
    observer.observe(document.getElementById('content-drawer'), { childList: true, subtree: true });
}

// ── Failed Links ──────────────────────────────────────────────────────────────

let failedLinksOffset = 0;
const FAILED_PAGE_SIZE = 50;

async function loadFailedLinks() {
    const tbody = document.getElementById('failed-tbody');
    tbody.innerHTML = `<tr><td colspan="6" class="loading-cell">Loading…</td></tr>`;
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
        const reasonLabels = {
            no_slots: 'No place name',
            no_google_match: 'No Google match',
            needs_confirmation: 'Needs confirmation',
            metadata_failed: 'Metadata failed',
            metadata_timeout: 'Metadata timeout',
            resolution_timeout: 'Resolution timeout',
            extraction_timeout: 'Overall timeout',
            extraction_exception: 'Unexpected error',
            unsupported_platform: 'Unsupported platform',
            save_failed: 'Database save failed',
        };
        const reason = escapeHtml(reasonLabels[row.reason] || row.reason || '—');
        const error = escapeHtml(row.error_message || '');
        const details = row.details && Object.keys(row.details).length
            ? escapeHtml(JSON.stringify(row.details)) : '';
        const diagnostics = [preview !== '—' ? preview : '', error, details].filter(Boolean).join(' · ') || '—';
        return `<tr>
            <td>${escapeHtml(date)}</td>
            <td>${escapeHtml(row.platform || '—')}<br><small>${escapeHtml(row.flow || 'private')}</small></td>
            <td>${escapeHtml(row.failure_stage || 'extraction')}</td>
            <td><span class="badge">${reason}</span></td>
            <td class="cell-url"><a href="${url}" target="_blank" rel="noopener">${url.length > 60 ? url.slice(0, 60) + '…' : url}</a></td>
            <td class="cell-preview" title="${diagnostics}">${diagnostics.length > 160 ? diagnostics.slice(0, 160) + '…' : diagnostics}</td>
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

// ── Global Save Activity ─────────────────────────────────────────────────────

let placesOffset = 0;
const PLACES_PAGE_SIZE = 100;

async function loadPlaces() {
    const tbody = document.getElementById('places-tbody');
    tbody.innerHTML = `<tr><td colspan="7" class="loading-cell">Loading saves across all users…</td></tr>`;
    const platform = document.getElementById('places-filter-platform').value;
    const city = document.getElementById('places-filter-city').value.trim();
    const search = document.getElementById('places-filter-search').value.trim();
    const params = new URLSearchParams({ limit: PLACES_PAGE_SIZE, offset: placesOffset });
    if (platform) params.set('platform', platform);
    if (city) params.set('city', city);
    if (search) params.set('search', search);
    const response = await adminFetch(`/admin/api/save-activity?${params}`);
    if (!response.ok) {
        tbody.innerHTML = `<tr><td colspan="7" class="loading-cell">Could not load save activity. Confirm the latest Supabase migration is installed.</td></tr>`;
        return;
    }
    const data = await response.json();
    renderPlaces(data.places, data.total);
}

function renderPlaces(places, total) {
    const tbody = document.getElementById('places-tbody');
    const empty = document.getElementById('places-empty');
    const summary = document.getElementById('places-summary');
    const pagination = document.getElementById('places-pagination');
    summary.textContent = `${numberFmt.format(total)} save${total === 1 ? '' : 's'} across all users`;
    if (!places.length) { empty.classList.remove('hidden'); tbody.innerHTML = ''; pagination.innerHTML = ''; return; }
    empty.classList.add('hidden');
    tbody.innerHTML = places.map((p) => {
        const date = new Date(p.created_at).toLocaleString();
        const sourceUrl = safeHttpUrl(p.source_url);
        const src = sourceUrl
            ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open</a>`
            : '—';
        return `<tr>
            <td class="cell-muted">${escapeHtml(date)}</td>
            <td><strong>${escapeHtml(p.user_name || `User ${p.user_id}`)}</strong></td>
            <td><button class="table-link" type="button" data-restaurant-key="${escapeHtml(p.restaurant_key)}">${escapeHtml(p.name)}</button><small class="table-subline">${escapeHtml(p.address || '')}</small></td>
            <td class="cell-muted">${escapeHtml(p.city || '—')}</td>
            <td>${escapeHtml(p.source_platform || '—')}</td>
            <td>${p.is_visited ? '<span class="badge green">Visited</span>' : '—'}</td>
            <td>${src}</td>
        </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-restaurant-key]').forEach((button) => {
        button.addEventListener('click', () => openRestaurantDetail(button.dataset.restaurantKey));
    });
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
    ['places-filter-platform', 'places-filter-city'].forEach((id) => document.getElementById(id).addEventListener('change', () => {
        placesOffset = 0;
        loadPlaces();
    }));
    document.getElementById('places-filter-search').addEventListener('input', () => {
        window.clearTimeout(window._placesSearchDebounce);
        window._placesSearchDebounce = window.setTimeout(() => { placesOffset = 0; loadPlaces(); }, 300);
    });
    document.getElementById('places-refresh-btn').addEventListener('click', () => {
        placesOffset = 0;
        loadPlaces();
    });
}

// ── Restaurants ───────────────────────────────────────────────────────────────

let restaurantsOffset = 0;
const RESTAURANTS_PAGE_SIZE = 50;
let activeRestaurantKey = null;
let restaurantReviewsOffset = 0;
const RESTAURANT_REVIEWS_PAGE_SIZE = 20;

async function loadRestaurants() {
    const tbody = document.getElementById('restaurants-tbody');
    tbody.innerHTML = `<tr><td colspan="8" class="loading-cell">Aggregating restaurant activity…</td></tr>`;
    const platform = document.getElementById('restaurants-filter-platform').value;
    const city = document.getElementById('restaurants-filter-city').value.trim();
    const search = document.getElementById('restaurants-filter-search').value.trim();
    const sort = document.getElementById('restaurants-sort').value;
    const params = new URLSearchParams({ limit: RESTAURANTS_PAGE_SIZE, offset: restaurantsOffset, sort });
    if (platform) params.set('platform', platform);
    if (city) params.set('city', city);
    if (search) params.set('search', search);
    const response = await adminFetch(`/admin/api/restaurants?${params}`);
    if (!response.ok) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading-cell">Could not load restaurant aggregates. Confirm the latest Supabase migration is installed.</td></tr>`;
        return;
    }
    const data = await response.json();
    renderRestaurants(data.restaurants, data.total);
}

function renderRestaurants(restaurants, total) {
    const tbody = document.getElementById('restaurants-tbody');
    const empty = document.getElementById('restaurants-empty');
    const summary = document.getElementById('restaurants-summary');
    const pagination = document.getElementById('restaurants-pagination');
    summary.textContent = `${numberFmt.format(total)} unique restaurant${total === 1 ? '' : 's'} across all users`;
    if (!restaurants.length) { empty.classList.remove('hidden'); tbody.innerHTML = ''; pagination.innerHTML = ''; return; }
    empty.classList.add('hidden');
    tbody.innerHTML = restaurants.map((r) => {
        const lastSaved = r.last_saved_at ? new Date(r.last_saved_at).toLocaleDateString() : '—';
        const saveBadgeClass = r.save_count >= 3 ? 'green' : '';
        const context = [r.city, r.cuisine].filter(Boolean).join(' · ') || r.address || '—';
        const directoryScore = r.adjusted_score ?? r.overall_score;
        const score = directoryScore == null ? '—' : Number(directoryScore).toFixed(1);
        return `<tr class="clickable-row" tabindex="0" data-restaurant-key="${escapeHtml(r.restaurant_key)}" aria-label="Open ${escapeHtml(r.name)} restaurant overview">
            <td><strong>${escapeHtml(r.name)}</strong>${r.needs_matching ? '<span class="match-warning">Needs matching</span>' : ''}<small class="table-subline">${escapeHtml(r.address || '')}</small></td>
            <td class="cell-muted">${escapeHtml(context)}</td>
            <td><span class="badge ${saveBadgeClass}">${r.save_count}</span></td>
            <td>${r.unique_savers}</td>
            <td>${r.visited_users}</td>
            <td>${r.review_count}</td>
            <td><strong>${score}</strong></td>
            <td class="cell-muted">${escapeHtml(lastSaved)}</td>
        </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-restaurant-key]').forEach((row) => {
        const open = () => openRestaurantDetail(row.dataset.restaurantKey);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
        });
    });
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
    ['restaurants-filter-platform', 'restaurants-filter-city', 'restaurants-sort'].forEach((id) => document.getElementById(id).addEventListener('change', () => {
        restaurantsOffset = 0;
        loadRestaurants();
    }));
    document.getElementById('restaurants-filter-search').addEventListener('input', () => {
        window.clearTimeout(window._restaurantsSearchDebounce);
        window._restaurantsSearchDebounce = window.setTimeout(() => { restaurantsOffset = 0; loadRestaurants(); }, 300);
    });
    document.getElementById('restaurants-refresh-btn').addEventListener('click', () => {
        restaurantsOffset = 0;
        loadRestaurants();
    });
    document.getElementById('restaurant-drawer-close').addEventListener('click', closeRestaurantDetail);
    document.getElementById('restaurant-drawer-backdrop').addEventListener('click', closeRestaurantDetail);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && activeRestaurantKey) closeRestaurantDetail();
    });
}

function restaurantMetric(label, value, note = '') {
    return `<div class="restaurant-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`;
}

function renderMiniBars(rows, labelKey, valueKey) {
    const max = Math.max(1, ...rows.map(row => Number(row[valueKey] || 0)));
    return rows.map(row => `<div class="mini-bar-row"><span>${escapeHtml(row[labelKey] || 'Unknown')}</span><div><i style="width:${Number(row[valueKey] || 0) / max * 100}%"></i></div><strong>${numberFmt.format(row[valueKey] || 0)}</strong></div>`).join('') || '<p class="muted">No data yet.</p>';
}

function renderRestaurantDetail(detail) {
    const body = document.getElementById('restaurant-drawer-body');
    document.getElementById('restaurant-drawer-title').textContent = detail.name || 'Restaurant';
    const sentimentTotal = Number(detail.review_count || 0);
    const sentiment = [
        ['Loved', Number(detail.loved_rate || 0), '#73b98a'],
        ['Okay', Number(detail.okay_rate || 0), '#e8c878'],
        ['Meh', Number(detail.meh_rate || 0), '#e8a87c'],
    ];
    const mapsUrl = detail.google_place_id
        ? `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(detail.google_place_id)}&query=${encodeURIComponent(detail.name || '')}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([detail.name, detail.address].filter(Boolean).join(' '))}`;
    const score = value => value == null ? '—' : Number(value).toFixed(1);
    const reviewRate = Number(detail.visit_review_rate || 0);
    body.innerHTML = `
        <section class="restaurant-identity">
            <div><p>${escapeHtml(detail.address || 'Address unavailable')}</p><div class="identity-tags">${detail.city ? `<span>${escapeHtml(detail.city)}</span>` : ''}${detail.cuisine ? `<span>${escapeHtml(String(detail.cuisine).replaceAll('_', ' '))}</span>` : ''}${detail.needs_matching ? '<span class="warning">Needs Google matching</span>' : ''}</div></div>
            <a class="button-link" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener noreferrer">Open in Maps ↗</a>
        </section>
        <section><div class="drawer-section-heading"><span class="eyebrow">Cross-user funnel</span><h3>From inspiration to trusted review</h3></div><div class="restaurant-metric-grid">
            ${restaurantMetric('Unique savers', numberFmt.format(detail.unique_savers || 0), `${detail.save_count || 0} active saves`)}
            ${restaurantMetric('Visited', numberFmt.format(detail.visited_users || 0), `${Math.round(Number(detail.save_visit_rate || 0) * 100)}% of savers`)}
            ${restaurantMetric('Public reviews', numberFmt.format(detail.review_count || 0), `${Math.round(reviewRate * 100)}% of visitors`)}
            ${restaurantMetric('Source posts', numberFmt.format(detail.source_post_count || 0), 'distinct links')}
        </div></section>
        <section><div class="drawer-section-heading"><span class="eyebrow">Sprout score</span><h3>What diners thought</h3></div><div class="score-grid">
            ${restaurantMetric('Adjusted', score(detail.adjusted_score), detail.publishable ? 'Ready to publish' : 'Internal preview')}
            ${restaurantMetric('Food', score(detail.food_score))}
            ${restaurantMetric('Vibe', score(detail.vibe_score))}
            ${restaurantMetric('Value', score(detail.value_score))}
        </div>
        <div class="detail-sentiment"><div class="stacked-bar">${sentiment.map(([label, pct, color]) => `<span title="${label} ${pct.toFixed(0)}%" style="width:${pct}%;background:${color}"></span>`).join('')}</div><div class="sentiment-detail-legend">${sentiment.map(([label, pct]) => `<span>${label} <strong>${sentimentTotal ? pct.toFixed(0) : 0}%</strong></span>`).join('')}</div></div></section>
        <section class="drawer-two-column"><div><div class="drawer-section-heading"><span class="eyebrow">Last 12 weeks</span><h3>Save momentum</h3></div><div class="mini-bars">${renderMiniBars(detail.weekly_saves || [], 'week', 'saves')}</div></div><div><div class="drawer-section-heading"><span class="eyebrow">Discovery</span><h3>Save sources</h3></div><div class="mini-bars">${renderMiniBars(detail.source_mix || [], 'source', 'saves')}</div></div></section>
        <section><div class="drawer-section-heading"><span class="eyebrow">Content attribution</span><h3>How diners found this restaurant</h3></div><div id="restaurant-source-list" class="source-card-list"><div class="loading-cell">Loading discovery sources…</div></div></section>
        <section><div class="drawer-section-heading"><span class="eyebrow">Latest public review per diner</span><h3>Reviews</h3></div><div id="restaurant-review-list"><div class="loading-cell">Loading reviews…</div></div><div id="restaurant-review-pagination" class="pagination"></div></section>`;
}

async function openRestaurantDetail(restaurantKey) {
    if (!restaurantKey) return;
    activeRestaurantKey = restaurantKey;
    restaurantReviewsOffset = 0;
    document.getElementById('restaurant-drawer-backdrop').classList.remove('hidden');
    document.getElementById('restaurant-drawer').classList.remove('hidden');
    document.body.classList.add('drawer-open');
    document.getElementById('restaurant-drawer-body').innerHTML = '<div class="loading-cell">Loading restaurant story…</div>';
    const url = new URL(window.location.href); url.searchParams.set('restaurant', restaurantKey); history.replaceState({}, '', url);
    const response = await adminFetch(`/admin/api/restaurants/${encodeURIComponent(restaurantKey)}`);
    if (!response.ok) {
        document.getElementById('restaurant-drawer-body').innerHTML = '<div class="drawer-error">Could not load this restaurant. Confirm the latest Supabase migration is installed.</div>';
        return;
    }
    const data = await response.json();
    renderRestaurantDetail(data.restaurant);
    await Promise.all([loadRestaurantReviews(), loadRestaurantSources()]);
    document.getElementById('restaurant-drawer-close').focus();
}

function closeRestaurantDetail() {
    activeRestaurantKey = null;
    document.getElementById('restaurant-drawer-backdrop').classList.add('hidden');
    document.getElementById('restaurant-drawer').classList.add('hidden');
    document.body.classList.remove('drawer-open');
    const url = new URL(window.location.href); url.searchParams.delete('restaurant'); history.replaceState({}, '', url);
}

async function loadRestaurantReviews() {
    if (!activeRestaurantKey) return;
    const list = document.getElementById('restaurant-review-list');
    const params = new URLSearchParams({ limit: RESTAURANT_REVIEWS_PAGE_SIZE, offset: restaurantReviewsOffset });
    const response = await adminFetch(`/admin/api/restaurants/${encodeURIComponent(activeRestaurantKey)}/reviews?${params}`);
    if (!response.ok) { list.innerHTML = '<p class="muted">Could not load reviews.</p>'; return; }
    const data = await response.json();
    list.innerHTML = data.reviews.length ? data.reviews.map(review => {
        const scores = [['Food',review.food_score],['Vibe',review.vibe_score],['Value',review.value_score]].filter(([,value]) => value != null);
        return `<article class="admin-review"><div class="admin-review-heading"><div><strong>${escapeHtml(review.reviewer_name)}</strong><span class="sentiment-chip ${escapeHtml(review.sentiment || '')}">${escapeHtml(review.sentiment || 'Reviewed')}</span></div><time>${escapeHtml(new Date(review.reviewed_at).toLocaleDateString())}</time></div>${scores.length ? `<div class="review-scores">${scores.map(([label,value]) => `<span>${label} <strong>${Number(value).toFixed(1)}</strong></span>`).join('')}</div>` : ''}${review.review_text ? `<p>${escapeHtml(review.review_text)}</p>` : '<p class="muted">No written note.</p>'}</article>`;
    }).join('') : '<div class="chart-empty">No public reviews yet.</div>';
    const totalPages = Math.ceil(data.total / RESTAURANT_REVIEWS_PAGE_SIZE);
    const currentPage = Math.floor(restaurantReviewsOffset / RESTAURANT_REVIEWS_PAGE_SIZE) + 1;
    document.getElementById('restaurant-review-pagination').innerHTML = totalPages > 1
        ? `<button ${currentPage === 1 ? 'disabled' : ''} onclick="restaurantReviewsPage(-1)">← Prev</button><span>Page ${currentPage} of ${totalPages}</span><button ${currentPage === totalPages ? 'disabled' : ''} onclick="restaurantReviewsPage(1)">Next →</button>` : '';
}

function restaurantReviewsPage(direction) {
    restaurantReviewsOffset = Math.max(0, restaurantReviewsOffset + direction * RESTAURANT_REVIEWS_PAGE_SIZE);
    loadRestaurantReviews();
}

async function loadRestaurantSources() {
    if (!activeRestaurantKey) return;
    const list = document.getElementById('restaurant-source-list');
    const response = await adminFetch(`/admin/api/restaurants/${encodeURIComponent(activeRestaurantKey)}/sources?limit=20`);
    if (!response.ok) { list.innerHTML = '<p class="muted">Content attribution migration is not available yet.</p>'; return; }
    const data = await response.json();
    list.innerHTML = data.sources.length ? data.sources.map(source => {
        const link = safeHttpUrl(source.canonical_url);
        const outcome = source.adjusted_score == null ? '—' : Number(source.adjusted_score).toFixed(1);
        return `<article class="source-card"><div class="source-card-head"><div><span class="platform-chip">${escapeHtml(source.platform)}</span><h4>${escapeHtml(source.title || 'Untitled post')}</h4><p>${escapeHtml(source.source_account ? `@${source.source_account}` : 'Unknown source account')}</p></div>${link ? `<a class="button-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}</div><div class="source-card-metrics"><span>${source.new_saves} saves</span><span>${source.rediscoveries} rediscoveries</span><span>${source.visits} visits</span><span>${source.reviews} reviews</span><span>${source.loved_rate || 0}% loved</span><span>${outcome} outcome</span></div></article>`;
    }).join('') : '<div class="chart-empty">No attributed Instagram or TikTok posts yet.</div>';
}

// ── Content attribution ──────────────────────────────────────────────────────

function contentParams() {
    const params = new URLSearchParams({ limit: CONTENT_PAGE_SIZE, offset: contentOffset, sort: document.getElementById('content-sort').value });
    const platform = document.getElementById('content-platform').value;
    const account = document.getElementById('content-account').value.trim();
    if (platform) params.set('platform', platform);
    if (account) params.set(contentView === 'posts' ? 'account' : 'search', account);
    if (contentView === 'posts') {
        const city = document.getElementById('content-city').value.trim();
        const cuisine = document.getElementById('content-cuisine').value.trim();
        if (city) params.set('city', city); if (cuisine) params.set('cuisine', cuisine);
    }
    return params;
}

async function loadContentAnalytics() {
    const postsBody = document.getElementById('content-posts-tbody');
    const accountsBody = document.getElementById('content-accounts-tbody');
    (contentView === 'posts' ? postsBody : accountsBody).innerHTML = `<tr><td colspan="10" class="loading-cell">Calculating attributed outcomes…</td></tr>`;
    const endpoint = contentView === 'posts' ? 'posts' : 'accounts';
    const response = await adminFetch(`/admin/api/content/${endpoint}?${contentParams()}`);
    if (!response.ok) {
        (contentView === 'posts' ? postsBody : accountsBody).innerHTML = `<tr><td colspan="10" class="loading-cell">Content attribution is unavailable. Run the latest Supabase migration.</td></tr>`;
        return;
    }
    const data = await response.json();
    document.getElementById('content-summary').textContent = `${numberFmt.format(data.total)} ${contentView === 'posts' ? 'observed posts' : 'source accounts'} · Sprout-attributed actions only`;
    if (contentView === 'posts') renderContentPosts(data.posts || [], data.total);
    else renderSourceAccounts(data.accounts || [], data.total);
}

function renderContentPosts(posts, total) {
    const body = document.getElementById('content-posts-tbody');
    body.innerHTML = posts.map(post => {
        const outcome = post.adjusted_score == null ? '—' : Number(post.adjusted_score).toFixed(1);
        return `<tr class="clickable-row" tabindex="0" data-content-id="${post.content_source_id}"><td><span class="platform-chip">${escapeHtml(post.platform)}</span><strong class="content-title">${escapeHtml(post.title || post.canonical_url)}</strong></td><td>${escapeHtml(post.source_account ? `@${post.source_account}` : 'Unknown')}</td><td>${escapeHtml(String(post.content_format || '').replaceAll('_',' '))}</td><td><span class="badge green">${post.new_saves}</span></td><td>${post.rediscoveries}</td><td>${post.visits}</td><td>${post.reviews}</td><td>${post.loved_rate || 0}%</td><td><strong>${outcome}</strong></td></tr>`;
    }).join('') || '<tr><td colspan="9" class="loading-cell">No attributed posts match these filters.</td></tr>';
    body.querySelectorAll('[data-content-id]').forEach(row => {
        const open = () => openContentDetail(Number(row.dataset.contentId));
        row.addEventListener('click', open); row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    renderContentPagination(total);
}

function renderSourceAccounts(accounts, total) {
    document.getElementById('content-accounts-tbody').innerHTML = accounts.map(account => {
        const outcome = account.adjusted_score == null ? '—' : Number(account.adjusted_score).toFixed(1);
        return `<tr><td><span class="platform-chip">${escapeHtml(account.platform)}</span> <strong>@${escapeHtml(account.source_account)}</strong></td><td>${account.post_count}</td><td><span class="badge green">${account.new_saves}</span></td><td>${account.rediscoveries}</td><td>${account.unique_users}</td><td>${account.restaurant_count}</td><td>${account.visits}</td><td>${account.reviews}</td><td>${account.loved_rate || 0}%</td><td><strong>${outcome}</strong></td></tr>`;
    }).join('') || '<tr><td colspan="10" class="loading-cell">No source accounts match these filters.</td></tr>';
    renderContentPagination(total);
}

function renderContentPagination(total) {
    const pages = Math.ceil(total / CONTENT_PAGE_SIZE), page = Math.floor(contentOffset / CONTENT_PAGE_SIZE) + 1;
    document.getElementById('content-pagination').innerHTML = pages > 1 ? `<button ${page===1?'disabled':''} onclick="contentPage(-1)">← Prev</button><span>Page ${page} of ${pages}</span><button ${page===pages?'disabled':''} onclick="contentPage(1)">Next →</button>` : '';
}

function contentPage(direction) { contentOffset = Math.max(0, contentOffset + direction * CONTENT_PAGE_SIZE); loadContentAnalytics(); }

async function openContentDetail(id) {
    document.getElementById('content-drawer-backdrop').classList.remove('hidden');
    document.getElementById('content-drawer').classList.remove('hidden');
    document.body.classList.add('drawer-open');
    const body = document.getElementById('content-drawer-body'); body.innerHTML = '<div class="loading-cell">Loading content outcomes…</div>';
    const response = await adminFetch(`/admin/api/content/posts/${id}`);
    if (!response.ok) { body.innerHTML = '<div class="drawer-error">Could not load this post.</div>'; return; }
    const post = (await response.json()).post;
    document.getElementById('content-drawer-title').textContent = post.title || 'Untitled post';
    const link = safeHttpUrl(post.canonical_url), outcome = post.adjusted_score == null ? '—' : Number(post.adjusted_score).toFixed(1);
    body.innerHTML = `<section class="restaurant-identity"><div><span class="platform-chip">${escapeHtml(post.platform)}</span><p>${escapeHtml(post.source_account ? `@${post.source_account}` : 'Unknown source account')}</p></div>${link ? `<a class="button-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open post ↗</a>` : ''}</section><section><div class="drawer-section-heading"><span class="eyebrow">Content → table funnel</span><h3>Attributed outcomes</h3></div><div class="restaurant-metric-grid">${restaurantMetric('New saves', post.new_saves || 0)}${restaurantMetric('Rediscoveries', post.rediscoveries || 0)}${restaurantMetric('Visits', post.visits || 0)}${restaurantMetric('Reviews', post.reviews || 0)}</div><div class="score-grid" style="margin-top:9px">${restaurantMetric('Loved', `${post.loved_rate || 0}%`)}${restaurantMetric('Outcome', outcome, post.reviews < 10 ? 'Internal preview' : 'Reliable sample')}</div></section><section><div class="drawer-section-heading"><span class="eyebrow">Restaurants</span><h3>What this post inspired</h3></div><div class="content-restaurant-list">${(post.restaurants || []).map(r => `<div class="content-restaurant-row"><div><strong>${escapeHtml(r.name || 'Restaurant')}</strong><small>${escapeHtml([r.cuisine,r.city].filter(Boolean).join(' · '))}</small></div><span>${r.new_saves} saves</span><span>${r.visits} visits</span><span>${r.reviews} reviews</span><span>${r.loved_rate || 0}% loved</span></div>`).join('') || '<p class="muted">No restaurants attributed yet.</p>'}</div></section>`;
}

function closeContentDetail() { document.getElementById('content-drawer-backdrop').classList.add('hidden'); document.getElementById('content-drawer').classList.add('hidden'); document.body.classList.remove('drawer-open'); }

function bindContent() {
    document.getElementById('content-apply').addEventListener('click', () => { contentOffset = 0; loadContentAnalytics(); });
    document.getElementById('content-posts-view').addEventListener('click', () => switchContentView('posts'));
    document.getElementById('content-accounts-view').addEventListener('click', () => switchContentView('accounts'));
    document.getElementById('content-drawer-close').addEventListener('click', closeContentDetail);
    document.getElementById('content-drawer-backdrop').addEventListener('click', closeContentDetail);
}

function switchContentView(view) {
    contentView = view; contentOffset = 0;
    document.getElementById('content-posts-panel').classList.toggle('hidden', view !== 'posts');
    document.getElementById('content-accounts-panel').classList.toggle('hidden', view !== 'accounts');
    document.getElementById('content-posts-view').classList.toggle('active', view === 'posts');
    document.getElementById('content-accounts-view').classList.toggle('active', view === 'accounts');
    document.getElementById('content-city').disabled = view !== 'posts'; document.getElementById('content-cuisine').disabled = view !== 'posts';
    if (view === 'accounts' && document.getElementById('content-sort').value === 'recent') document.getElementById('content-sort').value = 'saves';
    loadContentAnalytics();
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

    const signOut = async () => {
        await supabaseClient.auth.signOut();
        adminSession = null;
        activeReportId = null;
        activeUserId = null;
        if (activeRestaurantKey) closeRestaurantDetail();
        showLogin();
    };
    document.getElementById('sign-out').addEventListener('click', signOut);
    document.getElementById('mobile-sign-out').addEventListener('click', signOut);
}

async function init() {
    const end = new Date();
    const start = new Date(end); start.setDate(start.getDate() - 27);
    document.getElementById('analytics-end').value = end.toISOString().slice(0, 10);
    document.getElementById('analytics-start').value = start.toISOString().slice(0, 10);
    await initSupabase();
    bindLogin();
    bindFilters();
    bindTabs();
    bindFailedLinks();
    bindUsers();
    bindPlaces();
    bindRestaurants();
    bindContent();
    watchResponsiveTables();
    await validateAdminSession();
}

init().catch((error) => {
    console.error(error);
    document.getElementById('login-error').textContent = 'Failed to initialize admin dashboard';
});
