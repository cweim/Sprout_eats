import asyncio

import pytest
from fastapi import HTTPException

from api import admin_routes
from api.admin_auth import AdminUser
from database import supabase_repository as repository
from services.content_attribution import canonicalize_content_url, normalize_source_account


ADMIN = AdminUser(id="admin", email="admin@example.com")


def test_instagram_tracking_variants_share_identity():
    first = canonicalize_content_url("instagram", "https://instagram.com/reel/ABC123/?igsh=one")
    second = canonicalize_content_url("instagram", "https://www.instagram.com/p/ABC123/?utm_source=x")
    assert first.content_id == second.content_id == "ABC123"
    assert first.canonical_url == second.canonical_url == "https://www.instagram.com/reel/ABC123/"


def test_tiktok_video_identity_and_short_link_fallback():
    canonical = canonicalize_content_url("tiktok", "https://www.tiktok.com/@food/video/7654321?lang=en")
    short = canonicalize_content_url("tiktok", "https://vm.tiktok.com/ZM123/?share=1")
    assert canonical.content_id == "7654321"
    assert canonical.canonical_url == "https://www.tiktok.com/video/7654321"
    assert short.content_id is None
    assert short.canonical_url == "https://vm.tiktok.com/ZM123"


def test_source_account_normalization():
    assert normalize_source_account(" @FoodCreator ") == "foodcreator"
    assert normalize_source_account(None) is None


def test_duplicate_place_still_records_rediscovery(monkeypatch):
    monkeypatch.setattr(repository, "add_place", lambda **kwargs: {
        "place": {"id": 4, "google_place_id": "gid", "name": "Meta", "address": "9 Road"},
        "created": False,
    })
    captured = {}
    monkeypatch.setattr(repository, "_rpc_data", lambda name, params: captured.update({"name": name, "params": params}) or {"attribution_id": 1})

    outcome = repository.add_place_with_outcome(
        user_id=42, name="Meta", latitude=1.0, longitude=2.0,
        google_place_id="gid", source_url="https://instagram.com/reel/ABC/?igsh=x",
        source_platform="instagram", source_uploader="@Creator",
    )

    assert outcome["created"] is False
    assert captured["name"] == "record_content_attribution"
    assert captured["params"]["p_attribution_type"] == "rediscovery"
    assert captured["params"]["p_platform_content_id"] == "ABC"
    assert captured["params"]["p_source_account"] == "creator"


def test_content_route_rejects_bad_sort():
    with pytest.raises(HTTPException, match="Unsupported content sort"):
        asyncio.run(admin_routes.get_content_posts(sort="followers", admin=ADMIN))


def test_content_route_clamps_page(monkeypatch):
    captured = {}
    monkeypatch.setattr(repository, "get_admin_content_posts", lambda **kwargs: captured.update(kwargs) or ([], 0))
    asyncio.run(admin_routes.get_content_posts(limit=1000, offset=-1, admin=ADMIN))
    assert captured["limit"] == 100
    assert captured["offset"] == 0
