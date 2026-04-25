import pytest

from services.instagram_worker_client import extract_instagram_via_worker


@pytest.mark.asyncio
async def test_extract_instagram_via_worker_maps_success(monkeypatch):
    class MockResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "success": True,
                "source": "instagram_instaloader",
                "description": "📍 Test Cafe",
                "uploader": "tester",
                "hashtags": ["test"],
                "content_type": "video",
                "thumbnail_url": "https://example.com/thumb.jpg",
                "video_url": "https://example.com/video.mp4",
                "image_urls": ["https://example.com/thumb.jpg"],
                "raw_fields": {"foo": "bar"},
                "error": None,
            }

    class MockClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, *args, **kwargs):
            return MockResponse()

    monkeypatch.setattr("services.instagram_worker_client.config.INSTAGRAM_WORKER_URL", "http://localhost:9000")
    monkeypatch.setattr("services.instagram_worker_client.httpx.AsyncClient", MockClient)

    candidate = await extract_instagram_via_worker("https://www.instagram.com/reel/ABC123/")

    assert candidate.success is True
    assert candidate.description == "📍 Test Cafe"
    assert candidate.uploader == "tester"
    assert candidate.source == "instagram_instaloader"


@pytest.mark.asyncio
async def test_extract_instagram_via_worker_requires_url(monkeypatch):
    monkeypatch.setattr("services.instagram_worker_client.config.INSTAGRAM_WORKER_URL", "")
    candidate = await extract_instagram_via_worker("https://www.instagram.com/reel/ABC123/")
    assert candidate.success is False
    assert "INSTAGRAM_WORKER_URL" in candidate.error
