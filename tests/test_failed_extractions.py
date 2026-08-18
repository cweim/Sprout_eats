from types import SimpleNamespace

from database import supabase_repository as repository


class FakeFailedExtractionsQuery:
    def __init__(self, store):
        self.store = store
        self.operation = None
        self.payload = None
        self.columns = ""

    def insert(self, payload):
        self.operation = "insert"
        self.payload = payload
        return self

    def select(self, columns):
        self.operation = "select"
        self.columns = columns
        return self

    def order(self, *args, **kwargs):
        return self

    def limit(self, *args, **kwargs):
        return self

    def offset(self, *args, **kwargs):
        return self

    def eq(self, *args, **kwargs):
        return self

    def execute(self):
        diagnostic_columns = "failure_stage" in self.columns
        diagnostic_payload = self.payload and "failure_stage" in self.payload
        if diagnostic_columns or diagnostic_payload:
            raise Exception(
                "{'message': 'column failed_extractions.failure_stage does not exist', "
                "'code': '42703'}"
            )
        if self.operation == "insert":
            self.store["inserts"].append(self.payload)
            return SimpleNamespace(data=[self.payload])
        return SimpleNamespace(data=[{
            "id": 1,
            "user_id": 123,
            "url": "https://example.com",
            "platform": "instagram",
            "caption_preview": "",
            "reason": "metadata_timeout",
            "created_at": "2026-08-18T00:00:00Z",
        }])


class FakeSupabase:
    def __init__(self):
        self.store = {"inserts": []}

    def table(self, name):
        assert name == "failed_extractions"
        return FakeFailedExtractionsQuery(self.store)


def test_failed_extraction_write_falls_back_before_diagnostics_migration(monkeypatch):
    supabase = FakeSupabase()
    monkeypatch.setattr(repository, "get_supabase", lambda: supabase)

    repository.log_failed_extraction(
        123,
        "https://example.com",
        platform="instagram",
        reason="metadata_timeout",
        failure_stage="metadata",
        details={"timeout_seconds": 95},
    )

    assert supabase.store["inserts"] == [{
        "user_id": 123,
        "url": "https://example.com",
        "platform": "instagram",
        "caption_preview": "",
        "reason": "metadata_timeout",
    }]


def test_failed_extraction_read_falls_back_before_diagnostics_migration(monkeypatch):
    monkeypatch.setattr(repository, "get_supabase", FakeSupabase)

    rows = repository.get_failed_extractions(platform="instagram")

    assert rows[0]["failure_stage"] == "extraction"
    assert rows[0]["flow"] == "private"
    assert rows[0]["details"] == {}
