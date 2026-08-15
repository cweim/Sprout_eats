(function () {
    'use strict';
    const storageKey = 'sprout_analytics_session';
    let sessionId = sessionStorage.getItem(storageKey);
    if (!sessionId) {
        sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        sessionStorage.setItem(storageKey, sessionId);
    }
    function track(eventName, options = {}) {
        const headers = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' };
        const initData = window.Telegram?.WebApp?.initData;
        if (initData) headers['X-Telegram-Init-Data'] = initData;
        fetch('/api/events', {
            method: 'POST', headers, keepalive: true,
            body: JSON.stringify({
                event_name: eventName,
                event_id: crypto.randomUUID ? crypto.randomUUID() : undefined,
                session_id: sessionId,
                entity_type: options.entityType || undefined,
                entity_id: options.entityId != null ? String(options.entityId) : undefined,
                metadata: options.metadata || {},
            }),
        }).catch(() => {});
    }
    window.SproutAnalytics = { track, sessionId };
})();
