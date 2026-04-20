import pytest
from aioresponses import aioresponses

from services.places import search_place, search_places_from_text, PLACES_TEXT_SEARCH_URL
from services.places import extract_location_queries


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
                    "types": ["cafe", "food"],
                }
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response, repeat=True)

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
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response, repeat=True)

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
                    "types": ["cafe", "food"],
                }
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response, repeat=True)

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
                    "types": ["cafe", "food"],
                },
                {
                    "displayName": {"text": "Cafe Two"},
                    "formattedAddress": "2 Second Street",
                    "location": {"latitude": 2.2, "longitude": 102.2},
                    "id": "place_2",
                    "types": ["restaurant", "food"],
                },
                {
                    "displayName": {"text": "Cafe Three"},
                    "formattedAddress": "3 Third Street",
                    "location": {"latitude": 3.3, "longitude": 103.3},
                    "id": "place_3",
                    "types": ["bakery", "food"],
                },
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response, repeat=True)

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
                    "types": ["restaurant", "food"],
                }
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            results = await search_places_from_text("Check out Famous Restaurant on Food Street")

            assert len(results) == 1
            assert results[0].name == "Famous Restaurant"
            assert results[0].address == "456 Food Street"
            assert results[0].confidence_label == "high"
            assert "Exact place-name match" in results[0].confidence_reason

    async def test_search_places_from_text_empty_text(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        results = await search_places_from_text("")

        assert results == []

    async def test_search_places_from_text_no_results(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {"places": []}

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response, repeat=True)

            results = await search_places_from_text("random gibberish text with no places")

            assert results == []

    async def test_returns_up_to_twelve_places_from_single_broad_query(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        # A single broad fallback query can now return up to the higher overall cap.
        mock_response = {
            "places": [
                {
                    "displayName": {"text": f"Place {i}"},
                    "formattedAddress": f"{i} Street",
                    "location": {"latitude": float(i), "longitude": float(i * 10)},
                    "id": f"place_{i}",
                    "types": ["restaurant", "food"],
                }
                for i in range(1, 8)  # 7 places
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response, repeat=True)

            results = await search_places_from_text(
                "popular places in city",
                validate_results=False,
            )

            assert len(results) == 7
            assert results[0].name == "Place 1"
            assert results[6].name == "Place 7"

    async def test_search_place_filters_out_non_food_results(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {
            "places": [
                {
                    "displayName": {"text": "City Museum"},
                    "formattedAddress": "1 Museum Way",
                    "location": {"latitude": 1.0, "longitude": 103.0},
                    "id": "museum_1",
                    "types": ["museum", "point_of_interest"],
                },
                {
                    "displayName": {"text": "Night Owl Cafe"},
                    "formattedAddress": "2 Coffee Street",
                    "location": {"latitude": 1.1, "longitude": 103.1},
                    "id": "cafe_1",
                    "types": ["cafe", "food"],
                },
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            result = await search_place("night owl", max_results=1)

            assert result is not None
            assert result.name == "Night Owl Cafe"

    async def test_search_places_from_text_returns_only_food_results(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {
            "places": [
                {
                    "displayName": {"text": "Central Station"},
                    "formattedAddress": "1 Transit Road",
                    "location": {"latitude": 1.0, "longitude": 103.0},
                    "id": "station_1",
                    "types": ["transit_station", "point_of_interest"],
                },
                {
                    "displayName": {"text": "Sunny Brunch"},
                    "formattedAddress": "8 Orchard Road",
                    "location": {"latitude": 1.3, "longitude": 103.8},
                    "id": "brunch_1",
                    "types": ["brunch_restaurant", "restaurant", "food"],
                },
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            results = await search_places_from_text("Sunny Brunch Orchard Road")

            assert len(results) == 1
            assert results[0].name == "Sunny Brunch"

    async def test_one_word_distinctive_place_name_is_kept(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {
            "places": [
                {
                    "displayName": {"text": "Atlas"},
                    "formattedAddress": "Parkview Square, Singapore 188778",
                    "location": {"latitude": 1.299, "longitude": 103.86},
                    "id": "atlas_1",
                    "types": ["bar", "food"],
                }
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response)

            results = await search_places_from_text(
                "We ended the night at Atlas and the cocktails were excellent",
            )

            assert len(results) == 1
            assert results[0].name == "Atlas"

    async def test_address_only_overlap_does_not_keep_random_place(self, monkeypatch):
        monkeypatch.setattr("config.GOOGLE_API_KEY", "test_api_key")

        mock_response = {
            "places": [
                {
                    "displayName": {"text": "Orchard Diner"},
                    "formattedAddress": "8 Orchard Road, Singapore 238823",
                    "location": {"latitude": 1.303, "longitude": 103.832},
                    "id": "orchard_diner_1",
                    "types": ["restaurant", "food"],
                }
            ]
        }

        with aioresponses() as m:
            m.post(PLACES_TEXT_SEARCH_URL, payload=mock_response, repeat=True)

            results = await search_places_from_text(
                "This bakery is inside a mall on Orchard Road and worth trying",
            )

            assert results == []


class TestLocationQueryExtraction:
    def test_mentions_use_source_location_context_not_hardcoded_singapore(self):
        queries = extract_location_queries(
            "Would you go to Damansara, KL for @uokatsu.malaysia?"
        )

        assert ("uokatsu malaysia Kuala Lumpur restaurant", "mention") in queries
        assert all("Singapore restaurant" not in query for query, _ in queries)

    def test_mentions_without_location_context_do_not_add_singapore(self):
        queries = extract_location_queries("Dinner at @fuegomesa was excellent")

        assert ("fuegomesa restaurant", "mention") in queries
