import pytest
from aioresponses import aioresponses

from services.places import search_place, search_places_from_text, PLACES_TEXT_SEARCH_URL


class TestSearchPlace:
    async def test_search_place_success(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {
            "places": [
                {
                    "displayName": {"text": "Test Cafe"},
                    "formattedAddress": "123 Test St",
                    "location": {"latitude": 1.234, "longitude": 5.678},
                    "id": "place_id_123",
                }
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            result = await search_place("coffee shop")

            assert result is not None
            assert result.name == "Test Cafe"
            assert result.address == "123 Test St"
            assert result.latitude == 1.234
            assert result.longitude == 5.678
            assert result.place_id == "place_id_123"

    async def test_search_place_no_results(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {"places": []}

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            result = await search_place("nonexistent place xyz123")

            assert result is None

    async def test_search_place_no_api_key(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", None)

        with pytest.raises(ValueError, match="GOOGLE_API_KEY not configured"):
            await search_place("coffee shop")

    async def test_search_place_with_region(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {
            "places": [
                {
                    "displayName": {"text": "Singapore Cafe"},
                    "formattedAddress": "1 Orchard Road",
                    "location": {"latitude": 1.3, "longitude": 103.8},
                    "id": "sg_place_123",
                }
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            result = await search_place("orchard cafe", region="SG")

            assert result is not None
            assert result.name == "Singapore Cafe"

    async def test_search_place_multiple_results(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {
            "places": [
                {
                    "displayName": {"text": "Cafe One"},
                    "formattedAddress": "1 First Street",
                    "location": {"latitude": 1.1, "longitude": 101.1},
                    "id": "place_1",
                },
                {
                    "displayName": {"text": "Cafe Two"},
                    "formattedAddress": "2 Second Street",
                    "location": {"latitude": 2.2, "longitude": 102.2},
                    "id": "place_2",
                },
                {
                    "displayName": {"text": "Cafe Three"},
                    "formattedAddress": "3 Third Street",
                    "location": {"latitude": 3.3, "longitude": 103.3},
                    "id": "place_3",
                },
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            results = await search_place("cafe", max_results=3)

            assert isinstance(results, list)
            assert len(results) == 3
            assert results[0].name == "Cafe One"
            assert results[1].name == "Cafe Two"
            assert results[2].name == "Cafe Three"

    async def test_search_place_multiple_returns_empty_list_when_no_results(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {"places": []}

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            results = await search_place("nonexistent", max_results=5)

            assert isinstance(results, list)
            assert len(results) == 0


class TestSearchPlacesFromText:
    async def test_search_places_from_text_success(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {
            "places": [
                {
                    "displayName": {"text": "Famous Restaurant"},
                    "formattedAddress": "456 Food Street",
                    "location": {"latitude": 2.0, "longitude": 104.0},
                    "id": "restaurant_123",
                }
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            results = await search_places_from_text("Check out Famous Restaurant on Food Street")

            assert len(results) == 1
            assert results[0].name == "Famous Restaurant"
            assert results[0].address == "456 Food Street"

    async def test_search_places_from_text_empty_text(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        results = await search_places_from_text("")

        assert results == []

    async def test_search_places_from_text_no_results(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {"places": []}

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            results = await search_places_from_text("random gibberish text with no places")

            assert results == []

    async def test_returns_up_to_five_places(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        # API returns 7 places but we should only get 5
        mock_response = {
            "places": [
                {
                    "displayName": {"text": f"Place {i}"},
                    "formattedAddress": f"{i} Street",
                    "location": {"latitude": float(i), "longitude": float(i * 10)},
                    "id": f"place_{i}",
                }
                for i in range(1, 8)  # 7 places
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            results = await search_places_from_text("popular places in city")

            assert len(results) == 5
            assert results[0].name == "Place 1"
            assert results[4].name == "Place 5"
