"""Shared analytics validation and comparison helpers."""

from datetime import datetime, timedelta, timezone
from typing import Any


ALLOWED_CLIENT_EVENTS = {
    "mini_app_opened",
    "onboarding_completed",
    "place_card_opened",
    "directions_clicked",
    "reservation_clicked",
    "map_shared",
    "shared_map_opened",
    "invite_sent",
    "feed_opened",
}

ALLOWED_ENTITY_TYPES = {"place", "restaurant", "map", "invite", "feed", "session"}
ALLOWED_METADATA_KEYS = {
    "surface",
    "source",
    "platform",
    "result",
    "request_id",
    "position",
    "tab",
    "method",
    "google_place_id",
}


def sanitise_event_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    """Keep only bounded, non-content analytics dimensions."""
    clean: dict[str, Any] = {}
    for key, value in (metadata or {}).items():
        if key not in ALLOWED_METADATA_KEYS or value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            clean[key] = value[:120] if isinstance(value, str) else value
    return clean


def parse_analytics_range(start: str | None, end: str | None, days: int = 28) -> tuple[datetime, datetime]:
    """Parse an ISO range, enforcing a bounded half-open interval."""
    now = datetime.now(timezone.utc)
    end_dt = _parse_iso(end) if end else now
    start_dt = _parse_iso(start) if start else end_dt.replace(microsecond=0) - timedelta(days=days)
    if start_dt >= end_dt:
        raise ValueError("start must be before end")
    if (end_dt - start_dt).days > 366:
        raise ValueError("date range cannot exceed 366 days")
    return start_dt, end_dt


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def add_period_comparison(current: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    """Attach absolute and percentage change to every numeric KPI."""
    current_kpis = current.get("kpis") or {}
    previous_kpis = previous.get("kpis") or {}
    comparison = {}
    for key, value in current_kpis.items():
        if not isinstance(value, (int, float)):
            continue
        before = previous_kpis.get(key, 0) or 0
        comparison[key] = {
            "previous": before,
            "absolute": value - before,
            "percent": round(((value - before) / before) * 100, 1) if before else None,
        }
    return {**current, "comparison": comparison}
