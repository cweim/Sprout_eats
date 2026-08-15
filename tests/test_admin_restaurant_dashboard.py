import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from api import admin_routes
from api.admin_auth import AdminUser
from database import supabase_repository as repository


ADMIN = AdminUser(id="admin-id", email="admin@example.com")


def test_paged_rpc_uses_window_total(monkeypatch):
    monkeypatch.setattr(repository, "_rpc_data", lambda name, params: [
        {"restaurant_key": "google:one", "total_count": 5001},
        {"restaurant_key": "google:two", "total_count": 5001},
    ])

    rows, total = repository.get_admin_restaurant_directory(limit=2, offset=20)

    assert len(rows) == 2
    assert total == 5001


def test_restaurant_directory_passes_filters_to_database(monkeypatch):
    captured = {}

    def fake_rpc(name, params):
        captured.update({"name": name, "params": params})
        return []

    monkeypatch.setattr(repository, "_rpc_data", fake_rpc)
    repository.get_admin_restaurant_directory(
        platform="instagram",
        city="Singapore",
        search="meta",
        sort="reviews",
        limit=25,
        offset=50,
    )

    assert captured["name"] == "admin_restaurant_directory"
    assert captured["params"] == {
        "p_platform": "instagram",
        "p_city": "Singapore",
        "p_search": "meta",
        "p_sort": "reviews",
        "p_limit": 25,
        "p_offset": 50,
    }


def test_save_activity_serialises_optional_dates(monkeypatch):
    captured = {}
    start = datetime(2026, 8, 1, tzinfo=timezone.utc)
    end = datetime(2026, 8, 2, tzinfo=timezone.utc)

    monkeypatch.setattr(
        repository,
        "_rpc_data",
        lambda name, params: captured.update({"name": name, "params": params}) or [],
    )

    repository.get_admin_save_activity(start=start, end=end, user_id=123)

    assert captured["name"] == "admin_save_activity"
    assert captured["params"]["p_start"] == start.isoformat()
    assert captured["params"]["p_end"] == end.isoformat()
    assert captured["params"]["p_user_id"] == 123


def test_restaurant_route_rejects_unknown_sort():
    with pytest.raises(HTTPException, match="Unsupported restaurant sort"):
        asyncio.run(admin_routes.get_restaurants(sort="popularity", admin=ADMIN))


def test_restaurant_route_clamps_pagination(monkeypatch):
    captured = {}

    def fake_directory(**kwargs):
        captured.update(kwargs)
        return ([{"restaurant_key": "google:one"}], 1)

    monkeypatch.setattr(repository, "get_admin_restaurant_directory", fake_directory)
    payload = asyncio.run(
        admin_routes.get_restaurants(limit=1000, offset=-5, sort="saves", admin=ADMIN)
    )

    assert captured["limit"] == 100
    assert captured["offset"] == 0
    assert payload["total"] == 1


def test_restaurant_detail_returns_404(monkeypatch):
    monkeypatch.setattr(repository, "get_admin_restaurant_detail", lambda key: None)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(admin_routes.get_restaurant_detail("google:missing", admin=ADMIN))

    assert exc.value.status_code == 404


def test_save_activity_rejects_reversed_range():
    start = datetime(2026, 8, 2, tzinfo=timezone.utc)
    end = datetime(2026, 8, 1, tzinfo=timezone.utc)

    with pytest.raises(HTTPException, match="start must be before end"):
        asyncio.run(admin_routes.get_save_activity(start=start, end=end, admin=ADMIN))
