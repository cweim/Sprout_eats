# Testing Patterns

**Analysis Date:** 2026-03-30

## Test Framework

**Runner:**
- Not configured

**Assertion Library:**
- Not configured

**Run Commands:**
```bash
# No test commands available
# Recommended: pip install pytest && pytest
```

## Test File Organization

**Location:**
- No test files present

**Naming:**
- N/A (no tests)

**Structure:**
```
# Current: No tests directory
# Recommended structure:
tests/
  test_downloader.py
  test_transcriber.py
  test_places.py
  test_repository.py
  conftest.py
```

## Test Structure

**Suite Organization:**
- N/A (no tests)

**Recommended Pattern:**
```python
import pytest
from services.downloader import detect_platform, is_valid_url

class TestDownloader:
    def test_detect_instagram_url(self):
        assert detect_platform("https://instagram.com/reel/abc") == "instagram"

    def test_detect_tiktok_url(self):
        assert detect_platform("https://tiktok.com/@user/video/123") == "tiktok"

    def test_is_valid_url_instagram(self):
        assert is_valid_url("https://instagram.com/reel/abc") is True

    def test_is_valid_url_invalid(self):
        assert is_valid_url("https://youtube.com/watch?v=abc") is False
```

## Mocking

**Framework:**
- N/A (recommend: pytest-mock or unittest.mock)

**What Should Be Mocked:**
- yt-dlp download operations
- Whisper model loading and transcription
- aiohttp HTTP calls to Google APIs
- SQLAlchemy database sessions
- Telegram Bot API calls

**Example Pattern:**
```python
from unittest.mock import Mock, patch, AsyncMock

@pytest.mark.asyncio
async def test_search_place(mocker):
    mock_response = AsyncMock()
    mock_response.json.return_value = {
        "places": [{"displayName": {"text": "Test Place"}, ...}]
    }

    with patch("aiohttp.ClientSession.post", return_value=mock_response):
        result = await search_place("coffee shop")
        assert result.name == "Test Place"
```

## Fixtures and Factories

**Test Data:**
- N/A (no fixtures currently)

**Recommended Fixtures:**
```python
# tests/conftest.py
import pytest
from database.models import init_db, Place, SessionLocal

@pytest.fixture
def test_db():
    """Create test database"""
    init_db()  # or use in-memory SQLite
    yield
    # cleanup

@pytest.fixture
def sample_place():
    return {
        "name": "Test Cafe",
        "address": "123 Test St",
        "latitude": 1.234,
        "longitude": 5.678,
        "google_place_id": "test_id_123"
    }
```

## Coverage

**Requirements:**
- Not configured

**Configuration:**
- N/A

**Recommended:**
```bash
pip install pytest-cov
pytest --cov=. --cov-report=html
```

## Test Types

**Unit Tests:**
- Not present
- Priority areas:
  - `services/downloader.py` - URL detection, platform parsing
  - `services/places.py` - Response parsing, error handling
  - `database/repository.py` - CRUD operations

**Integration Tests:**
- Not present
- Priority areas:
  - Full download → transcribe → search flow
  - Database operations with real SQLite

**E2E Tests:**
- Not present
- Would require Telegram Bot test framework

## Common Patterns

**Async Testing (Recommended):**
```python
import pytest

@pytest.mark.asyncio
async def test_async_function():
    result = await some_async_function()
    assert result is not None
```

**Error Testing (Recommended):**
```python
import pytest
from services.places import search_place

@pytest.mark.asyncio
async def test_search_place_no_api_key(monkeypatch):
    monkeypatch.setattr("config.GOOGLE_API_KEY", None)
    with pytest.raises(ValueError, match="GOOGLE_API_KEY not configured"):
        await search_place("test")
```

## Missing Test Coverage

**Critical Gaps:**
1. URL validation (`services/downloader.py`)
2. Platform detection logic
3. Google Places API response parsing
4. Database CRUD operations
5. Error handling paths

**Recommended Priority:**
1. Add pytest to requirements-dev.txt
2. Create `tests/` directory with conftest.py
3. Unit tests for services (mock external calls)
4. Integration tests for repository
5. Add pytest-asyncio for async tests

---

*Testing analysis: 2026-03-30*
*Update when test patterns change*
