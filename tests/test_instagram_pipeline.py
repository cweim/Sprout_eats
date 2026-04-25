from types import SimpleNamespace

import pytest

from services.instagram_pipeline import (
    extract_instagram_metadata_no_cookie,
    extract_instagram_metadata_no_cookie_direct,
    is_retryable_instagram_error,
    run_instagram_place_pipeline,
)


def make_candidate(
    *,
    success=True,
    source="instagram_instaloader",
    description="📍 Test Cafe",
    error=None,
):
    return SimpleNamespace(
        success=success,
        source=source,
        title="",
        description=description,
        uploader="tester",
        duration=None,
        hashtags=[],
        content_type="video",
        thumbnail_url="https://example.com/thumb.jpg",
        video_url="https://example.com/video.mp4",
        image_urls=["https://example.com/thumb.jpg"],
        raw_fields={},
        error=error,
    )


@pytest.mark.asyncio
async def test_extract_instagram_metadata_no_cookie_retries_once(monkeypatch):
    calls = {"count": 0}

    async def fake_extract_with_timeout(url: str):
        calls["count"] += 1
        if calls["count"] == 1:
            raise Exception("403 Forbidden")
        return [make_candidate()]

    async def fake_sleep(seconds: float):
        return None

    monkeypatch.setattr("services.instagram_pipeline._extract_with_timeout", fake_extract_with_timeout)
    monkeypatch.setattr("services.instagram_pipeline._enter_instagram_queue", lambda: fake_sleep(0))
    monkeypatch.setattr("services.instagram_pipeline._leave_instagram_queue", lambda success: fake_sleep(0))
    monkeypatch.setattr("services.instagram_pipeline.asyncio.sleep", fake_sleep)

    result = await extract_instagram_metadata_no_cookie("https://www.instagram.com/reel/ABC123/")

    assert result["status"] == "ok"
    assert calls["count"] == 2
    assert result["metadata_candidate"].source == "instagram_instaloader"


@pytest.mark.asyncio
async def test_run_instagram_place_pipeline_returns_metadata_only_when_no_slots(monkeypatch):
    candidate = make_candidate(description="")

    async def fake_extract(url: str):
        return {
            "status": "ok",
            "metadata_candidate": candidate,
            "candidates": [candidate],
            "error": None,
        }

    monkeypatch.setattr("services.instagram_pipeline.extract_instagram_metadata_no_cookie", fake_extract)
    monkeypatch.setattr("services.instagram_pipeline.metadata_candidate_to_runtime_record", lambda c, source_url: {"input": {"url": source_url}})
    monkeypatch.setattr("services.instagram_pipeline.extract_place_evidence_from_metadata", lambda record: [])

    result = await run_instagram_place_pipeline("https://www.instagram.com/reel/ABC123/")

    assert result["status"] == "metadata_only"
    assert result["slots"] == []
    assert result["places"] == []


@pytest.mark.asyncio
async def test_run_instagram_place_pipeline_returns_resolved(monkeypatch):
    candidate = make_candidate()
    slot = SimpleNamespace(source="caption_pin", name_candidate="Test Cafe")
    selected = SimpleNamespace(name="Test Cafe")
    suggestion = SimpleNamespace(status="resolved", selected=selected)

    async def fake_extract(url: str):
        return {
            "status": "ok",
            "metadata_candidate": candidate,
            "candidates": [candidate],
            "error": None,
        }

    async def fake_resolve(slots):
        return [suggestion]

    monkeypatch.setattr("services.instagram_pipeline.extract_instagram_metadata_no_cookie", fake_extract)
    monkeypatch.setattr("services.instagram_pipeline.metadata_candidate_to_runtime_record", lambda c, source_url: {"input": {"url": source_url}})
    monkeypatch.setattr("services.instagram_pipeline.extract_place_evidence_from_metadata", lambda record: [slot])
    monkeypatch.setattr("services.instagram_pipeline.resolve_place_slots", fake_resolve)

    result = await run_instagram_place_pipeline("https://www.instagram.com/reel/ABC123/")

    assert result["status"] == "resolved"
    assert result["slots"] == [slot]
    assert result["places"] == [selected]
    assert result["unresolved_suggestions"] == []


def test_is_retryable_instagram_error():
    assert is_retryable_instagram_error("403 Forbidden")
    assert is_retryable_instagram_error("timed out after 15s")
    assert not is_retryable_instagram_error("No usable public Instagram metadata found")


@pytest.mark.asyncio
async def test_extract_instagram_metadata_no_cookie_prefers_instaloader_error(monkeypatch):
    html_candidate = make_candidate(
        success=False,
        source="instagram_public_html",
        description="",
        error="No meaningful public metadata found in HTML",
    )
    instaloader_candidate = make_candidate(
        success=False,
        source="instagram_instaloader",
        description="",
        error="403 Forbidden",
    )

    async def fake_extract_with_timeout(url: str):
        return [html_candidate, instaloader_candidate]

    async def fake_noop(*args, **kwargs):
        return None

    monkeypatch.setattr("services.instagram_pipeline._extract_with_timeout", fake_extract_with_timeout)
    monkeypatch.setattr("services.instagram_pipeline._enter_instagram_queue", fake_noop)
    monkeypatch.setattr("services.instagram_pipeline._leave_instagram_queue", fake_noop)

    result = await extract_instagram_metadata_no_cookie_direct("https://www.instagram.com/reel/ABC123/")

    assert result["status"] == "failed"
    assert result["error"] == "403 Forbidden"


@pytest.mark.asyncio
async def test_extract_instagram_metadata_no_cookie_uses_worker_backend(monkeypatch):
    candidate = make_candidate(source="instagram_worker")

    async def fake_worker(url: str):
        return candidate

    monkeypatch.setattr("services.instagram_pipeline.config.INSTAGRAM_EXTRACTION_BACKEND", "worker")
    monkeypatch.setattr("services.instagram_pipeline.extract_instagram_via_worker", fake_worker)

    result = await extract_instagram_metadata_no_cookie("https://www.instagram.com/reel/ABC123/")

    assert result["status"] == "ok"
    assert result["metadata_candidate"].source == "instagram_worker"

    monkeypatch.setattr("services.instagram_pipeline.config.INSTAGRAM_EXTRACTION_BACKEND", "direct")
