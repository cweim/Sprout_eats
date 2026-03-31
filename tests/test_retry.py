import pytest
import re
import aiohttp
from aioresponses import aioresponses

from services.places import search_place, PLACES_TEXT_SEARCH_URL
from services.maps import generate_map_image, STATIC_MAPS_URL


class TestPlacesRetry:
    @pytest.fixture
    def mock_api_key(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

    async def test_search_place_retries_on_network_error(self, mock_api_key):
        """Verify search_place retries on network errors and succeeds on third attempt."""
        with aioresponses() as mocked:
            # First two calls fail, third succeeds
            mocked.post(
                PLACES_TEXT_SEARCH_URL,
                exception=aiohttp.ClientError("Network error"),
            )
            mocked.post(
                PLACES_TEXT_SEARCH_URL,
                exception=aiohttp.ClientError("Network error"),
            )
            mocked.post(
                PLACES_TEXT_SEARCH_URL,
                payload={
                    "places": [{
                        "displayName": {"text": "Test Place"},
                        "formattedAddress": "123 Test St",
                        "location": {"latitude": 1.0, "longitude": 2.0},
                        "id": "test_id",
                    }]
                },
            )

            result = await search_place("test query")

            assert result is not None
            assert result.name == "Test Place"

    async def test_search_place_gives_up_after_max_retries(self, mock_api_key):
        """Verify search_place raises original exception after max retries exceeded."""
        with aioresponses() as mocked:
            # All three calls fail
            mocked.post(
                PLACES_TEXT_SEARCH_URL,
                exception=aiohttp.ClientError("Network error"),
            )
            mocked.post(
                PLACES_TEXT_SEARCH_URL,
                exception=aiohttp.ClientError("Network error"),
            )
            mocked.post(
                PLACES_TEXT_SEARCH_URL,
                exception=aiohttp.ClientError("Network error"),
            )

            # With reraise=True, the original exception is raised after retries exhausted
            with pytest.raises(aiohttp.ClientError):
                await search_place("test query")


class TestMapsRetry:
    @pytest.fixture
    def mock_api_key(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

    async def test_generate_map_retries_on_network_error(self, mock_api_key):
        """Verify generate_map_image retries on network errors and succeeds on third attempt."""
        # Use regex pattern to match URL with any query params
        url_pattern = re.compile(r"^https://maps\.googleapis\.com/maps/api/staticmap\?.*$")

        with aioresponses() as mocked:
            # First two calls fail, third succeeds
            mocked.get(
                url_pattern,
                exception=aiohttp.ClientError("Network error"),
            )
            mocked.get(
                url_pattern,
                exception=aiohttp.ClientError("Network error"),
            )
            mocked.get(
                url_pattern,
                body=b"fake_image_data",
                status=200,
            )

            places = [(1.0, 2.0, "Test")]
            result = await generate_map_image(places)

            assert result == b"fake_image_data"

    async def test_generate_map_gives_up_after_max_retries(self, mock_api_key):
        """Verify generate_map_image raises original exception after max retries exceeded."""
        url_pattern = re.compile(r"^https://maps\.googleapis\.com/maps/api/staticmap\?.*$")

        with aioresponses() as mocked:
            # All three calls fail
            mocked.get(
                url_pattern,
                exception=aiohttp.ClientError("Network error"),
            )
            mocked.get(
                url_pattern,
                exception=aiohttp.ClientError("Network error"),
            )
            mocked.get(
                url_pattern,
                exception=aiohttp.ClientError("Network error"),
            )

            places = [(1.0, 2.0, "Test")]
            # With reraise=True, the original exception is raised after retries exhausted
            with pytest.raises(aiohttp.ClientError):
                await generate_map_image(places)
