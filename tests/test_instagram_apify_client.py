import pytest

from services.instagram_apify_client import extract_instagram_via_apify


@pytest.mark.asyncio
async def test_extract_instagram_via_apify_maps_success(monkeypatch):
    class MockResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return [
                {
                    "caption": "📍 Fat Bird Chicken Hotpot",
                    "hashtags": ["singapore", "sgfood"],
                    "ownerUsername": "cafeswithrich",
                    "locationName": "Fat Bird Chicken Hotpot",
                    "url": "https://www.instagram.com/p/DXjJ2aJE9yq/",
                }
            ]

    class MockClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, *args, **kwargs):
            return MockResponse()

    monkeypatch.setattr("services.instagram_apify_client.config.APIFY_API_TOKEN", "token")
    monkeypatch.setattr("services.instagram_apify_client.httpx.AsyncClient", MockClient)

    candidate = await extract_instagram_via_apify("https://www.instagram.com/reel/DXjJ2aJE9yq/")

    assert candidate.success is True
    assert candidate.source == "instagram_apify"
    assert candidate.description == "📍 Fat Bird Chicken Hotpot"
    assert candidate.hashtags == ["singapore", "sgfood"]
    assert candidate.uploader == "cafeswithrich"
    assert candidate.title == "Fat Bird Chicken Hotpot"
    assert candidate.url == "https://www.instagram.com/p/DXjJ2aJE9yq/"


@pytest.mark.asyncio
async def test_extract_instagram_via_apify_requires_token(monkeypatch):
    monkeypatch.setattr("services.instagram_apify_client.config.APIFY_API_TOKEN", "")

    candidate = await extract_instagram_via_apify("https://www.instagram.com/reel/DXjJ2aJE9yq/")

    assert candidate.success is False
    assert "APIFY_API_TOKEN" in candidate.error


@pytest.mark.asyncio
async def test_extract_instagram_via_apify_handles_empty_results(monkeypatch):
    class MockResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return []

    class MockClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, *args, **kwargs):
            return MockResponse()

    monkeypatch.setattr("services.instagram_apify_client.config.APIFY_API_TOKEN", "token")
    monkeypatch.setattr("services.instagram_apify_client.httpx.AsyncClient", MockClient)

    candidate = await extract_instagram_via_apify("https://www.instagram.com/reel/DXjJ2aJE9yq/")

    assert candidate.success is False
    assert candidate.error == "Apify returned no Instagram reel results"
