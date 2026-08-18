import pytest

from services.instagram_apify_client import extract_instagram_via_apify


class MockResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class MockApifyClient:
    dataset_items = []
    run_status = "SUCCEEDED"
    starts = 0
    aborts = 0

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def post(self, url, *args, **kwargs):
        if url.endswith("/runs"):
            type(self).starts += 1
            return MockResponse({"data": {"id": "run-1"}})
        if url.endswith("/abort"):
            type(self).aborts += 1
            return MockResponse({"data": {"id": "run-1", "status": "ABORTED"}})
        raise AssertionError(f"Unexpected POST {url}")

    async def get(self, url, *args, **kwargs):
        if "/actor-runs/" in url:
            return MockResponse({
                "data": {
                    "id": "run-1",
                    "status": self.run_status,
                    "defaultDatasetId": "dataset-1",
                }
            })
        if "/datasets/" in url:
            return MockResponse(self.dataset_items)
        raise AssertionError(f"Unexpected GET {url}")


@pytest.fixture(autouse=True)
def reset_mock_client():
    MockApifyClient.starts = 0
    MockApifyClient.aborts = 0
    MockApifyClient.run_status = "SUCCEEDED"
    MockApifyClient.dataset_items = []


@pytest.mark.asyncio
async def test_extract_instagram_via_apify_maps_success(monkeypatch):
    MockApifyClient.dataset_items = [{
        "caption": "📍 Fat Bird Chicken Hotpot",
        "hashtags": ["singapore", "sgfood"],
        "ownerUsername": "cafeswithrich",
        "locationName": "Fat Bird Chicken Hotpot",
        "url": "https://www.instagram.com/p/DXjJ2aJE9yq/",
    }]
    monkeypatch.setattr("services.instagram_apify_client.config.APIFY_API_TOKEN", "token")
    monkeypatch.setattr("services.instagram_apify_client.httpx.AsyncClient", MockApifyClient)

    candidate = await extract_instagram_via_apify("https://www.instagram.com/reel/DXjJ2aJE9yq/")

    assert candidate.success is True
    assert candidate.source == "instagram_apify"
    assert candidate.description == "📍 Fat Bird Chicken Hotpot"
    assert candidate.hashtags == ["singapore", "sgfood"]
    assert candidate.uploader == "cafeswithrich"
    assert candidate.title == "Fat Bird Chicken Hotpot"
    assert candidate.url == "https://www.instagram.com/p/DXjJ2aJE9yq/"
    assert MockApifyClient.starts == 1
    assert MockApifyClient.aborts == 0


@pytest.mark.asyncio
async def test_extract_instagram_via_apify_requires_token(monkeypatch):
    monkeypatch.setattr("services.instagram_apify_client.config.APIFY_API_TOKEN", "")

    candidate = await extract_instagram_via_apify("https://www.instagram.com/reel/DXjJ2aJE9yq/")

    assert candidate.success is False
    assert "APIFY_API_TOKEN" in candidate.error


@pytest.mark.asyncio
async def test_extract_instagram_via_apify_handles_empty_results(monkeypatch):
    monkeypatch.setattr("services.instagram_apify_client.config.APIFY_API_TOKEN", "token")
    monkeypatch.setattr("services.instagram_apify_client.httpx.AsyncClient", MockApifyClient)

    candidate = await extract_instagram_via_apify("https://www.instagram.com/reel/DXjJ2aJE9yq/")

    assert candidate.success is False
    assert candidate.error == "Apify returned no Instagram reel results"
    assert MockApifyClient.starts == 1


@pytest.mark.asyncio
async def test_extract_instagram_via_apify_aborts_one_run_at_deadline(monkeypatch):
    MockApifyClient.run_status = "RUNNING"
    monkeypatch.setattr("services.instagram_apify_client.config.APIFY_API_TOKEN", "token")
    monkeypatch.setattr("services.instagram_apify_client.config.APIFY_RUN_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr("services.instagram_apify_client.config.APIFY_POLL_INTERVAL_SECONDS", 0.001)
    monkeypatch.setattr("services.instagram_apify_client.httpx.AsyncClient", MockApifyClient)

    candidate = await extract_instagram_via_apify("https://www.instagram.com/reel/SLOW/")

    assert candidate.success is False
    assert "timed out" in candidate.error
    assert MockApifyClient.starts == 1
    assert MockApifyClient.aborts == 1
