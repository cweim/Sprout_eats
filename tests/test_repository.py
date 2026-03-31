import time

from database.repository import (
    add_place,
    get_all_places,
    get_place_count,
    clear_all_places,
    get_place_by_id,
    delete_place,
)


class TestAddPlace:
    def test_add_place_minimal(self, test_db_with_repository):
        place = add_place(
            name="Minimal Cafe",
            latitude=1.0,
            longitude=2.0,
        )

        assert place is not None
        assert place.name == "Minimal Cafe"
        assert place.latitude == 1.0
        assert place.longitude == 2.0
        assert place.id is not None

    def test_add_place_full(self, test_db_with_repository):
        place = add_place(
            name="Full Cafe",
            latitude=1.234,
            longitude=103.567,
            address="123 Test Street",
            google_place_id="google_id_123",
            source_url="https://instagram.com/reel/abc123",
            source_platform="instagram",
        )

        assert place.name == "Full Cafe"
        assert place.latitude == 1.234
        assert place.longitude == 103.567
        assert place.address == "123 Test Street"
        assert place.google_place_id == "google_id_123"
        assert place.source_url == "https://instagram.com/reel/abc123"
        assert place.source_platform == "instagram"

    def test_add_place_duplicate_google_id(self, test_db_with_repository):
        # Add first place
        place1 = add_place(
            name="Original Cafe",
            latitude=1.0,
            longitude=2.0,
            google_place_id="same_id",
        )

        # Try to add duplicate with same google_place_id
        place2 = add_place(
            name="Duplicate Cafe",
            latitude=3.0,
            longitude=4.0,
            google_place_id="same_id",
        )

        # Should return existing place, not create new one
        assert place2.id == place1.id
        assert place2.name == "Original Cafe"
        assert get_place_count() == 1

    def test_add_place_duplicate_without_google_id(self, test_db_with_repository):
        # Add two places without google_place_id
        place1 = add_place(
            name="Cafe One",
            latitude=1.0,
            longitude=2.0,
        )

        place2 = add_place(
            name="Cafe Two",
            latitude=3.0,
            longitude=4.0,
        )

        # Both should be created (no deduplication without google_place_id)
        assert place1.id != place2.id
        assert get_place_count() == 2

    def test_add_place_with_source_url(self, test_db_with_repository):
        place = add_place(
            name="TikTok Cafe",
            latitude=1.0,
            longitude=2.0,
            source_url="https://tiktok.com/@user/video/123",
            source_platform="tiktok",
        )

        assert place.source_url == "https://tiktok.com/@user/video/123"
        assert place.source_platform == "tiktok"


class TestGetAllPlaces:
    def test_get_all_places_empty(self, test_db_with_repository):
        places = get_all_places()
        assert places == []

    def test_get_all_places_multiple(self, test_db_with_repository):
        add_place(name="Cafe 1", latitude=1.0, longitude=1.0)
        add_place(name="Cafe 2", latitude=2.0, longitude=2.0)
        add_place(name="Cafe 3", latitude=3.0, longitude=3.0)

        places = get_all_places()
        assert len(places) == 3

    def test_get_all_places_order(self, test_db_with_repository):
        # Add places with slight delay to ensure different created_at
        add_place(name="First", latitude=1.0, longitude=1.0)
        time.sleep(0.01)
        add_place(name="Second", latitude=2.0, longitude=2.0)
        time.sleep(0.01)
        add_place(name="Third", latitude=3.0, longitude=3.0)

        places = get_all_places()

        # Should be ordered by created_at desc (newest first)
        assert places[0].name == "Third"
        assert places[1].name == "Second"
        assert places[2].name == "First"


class TestGetPlaceCount:
    def test_get_place_count_empty(self, test_db_with_repository):
        assert get_place_count() == 0

    def test_get_place_count_multiple(self, test_db_with_repository):
        add_place(name="Cafe 1", latitude=1.0, longitude=1.0)
        add_place(name="Cafe 2", latitude=2.0, longitude=2.0)
        add_place(name="Cafe 3", latitude=3.0, longitude=3.0)

        assert get_place_count() == 3


class TestClearAllPlaces:
    def test_clear_all_places(self, test_db_with_repository):
        add_place(name="Cafe 1", latitude=1.0, longitude=1.0)
        add_place(name="Cafe 2", latitude=2.0, longitude=2.0)
        add_place(name="Cafe 3", latitude=3.0, longitude=3.0)

        assert get_place_count() == 3

        clear_all_places()

        assert get_place_count() == 0

    def test_clear_all_places_returns_count(self, test_db_with_repository):
        add_place(name="Cafe 1", latitude=1.0, longitude=1.0)
        add_place(name="Cafe 2", latitude=2.0, longitude=2.0)
        add_place(name="Cafe 3", latitude=3.0, longitude=3.0)

        deleted_count = clear_all_places()

        assert deleted_count == 3

    def test_clear_all_places_empty(self, test_db_with_repository):
        # Should return 0 and not raise error when clearing empty database
        deleted_count = clear_all_places()
        assert deleted_count == 0


class TestGetPlaceById:
    def test_get_existing_place(self, test_db_with_repository):
        place = add_place(
            name="Test Cafe",
            latitude=1.234,
            longitude=103.567,
            address="123 Test Street",
        )

        retrieved = get_place_by_id(place.id)

        assert retrieved is not None
        assert retrieved.id == place.id
        assert retrieved.name == "Test Cafe"
        assert retrieved.latitude == 1.234
        assert retrieved.longitude == 103.567
        assert retrieved.address == "123 Test Street"

    def test_get_nonexistent_place(self, test_db_with_repository):
        result = get_place_by_id(99999)
        assert result is None


class TestDeletePlace:
    def test_delete_existing_place(self, test_db_with_repository):
        place = add_place(name="Delete Me", latitude=1.0, longitude=2.0)
        place_id = place.id

        # Verify place exists
        assert get_place_count() == 1

        # Delete place
        result = delete_place(place_id)

        # Verify deletion
        assert result is True
        assert get_place_count() == 0
        assert get_place_by_id(place_id) is None

    def test_delete_nonexistent_place(self, test_db_with_repository):
        result = delete_place(99999)
        assert result is False

    def test_delete_returns_true(self, test_db_with_repository):
        place = add_place(name="Test Cafe", latitude=1.0, longitude=2.0)

        result = delete_place(place.id)

        assert result is True
