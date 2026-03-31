import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from unittest.mock import patch

from database.models import Base, Place


@pytest.fixture
def test_db():
    """Create in-memory SQLite database for testing."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine)
    session = TestSession()

    yield session

    session.close()
    Base.metadata.drop_all(engine)


@pytest.fixture
def test_db_with_repository(monkeypatch):
    """Create in-memory SQLite database and patch SessionLocal for repository tests."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine)

    # Patch SessionLocal in the repository module
    monkeypatch.setattr("database.repository.SessionLocal", TestSession)

    yield TestSession

    Base.metadata.drop_all(engine)


@pytest.fixture
def sample_place() -> dict:
    """Sample place data for testing."""
    return {
        "name": "Test Cafe",
        "address": "123 Test Street, Test City",
        "latitude": 1.2345,
        "longitude": 103.6789,
        "google_place_id": "test_place_id_123",
        "source_url": "https://instagram.com/reel/test123",
        "source_platform": "instagram",
    }


@pytest.fixture
def sample_place_minimal() -> dict:
    """Minimal place data (required fields only)."""
    return {
        "name": "Minimal Place",
        "latitude": 1.0,
        "longitude": 2.0,
    }
