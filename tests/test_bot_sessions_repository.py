from types import SimpleNamespace

from database import supabase_repository as repository


class FakeQuery:
    def __init__(self, result_data=None):
        self.calls = []
        self.result_data = result_data or []

    def upsert(self, payload, **kwargs):
        self.calls.append(("upsert", payload, kwargs))
        return self

    def insert(self, payload):
        self.calls.append(("insert", payload))
        return self

    def select(self, columns):
        self.calls.append(("select", columns))
        return self

    def delete(self):
        self.calls.append(("delete",))
        return self

    def eq(self, column, value):
        self.calls.append(("eq", column, value))
        return self

    def gt(self, column, value):
        self.calls.append(("gt", column, value))
        return self

    def order(self, column, **kwargs):
        self.calls.append(("order", column, kwargs))
        return self

    def limit(self, value):
        self.calls.append(("limit", value))
        return self

    def execute(self):
        self.calls.append(("execute",))
        return SimpleNamespace(data=self.result_data)


class FakeSupabase:
    def __init__(self, query):
        self.query = query
        self.table_names = []

    def table(self, name):
        self.table_names.append(name)
        return self.query


def test_save_bot_session_uses_composite_conflict_key(monkeypatch):
    query = FakeQuery()
    client = FakeSupabase(query)
    monkeypatch.setattr(repository, "get_supabase", lambda: client)

    repository.save_bot_session_v2(
        123,
        "place_selection",
        "a1b2c3d4",
        {"pending_places": []},
    )

    _, payload, kwargs = query.calls[0]
    assert client.table_names == ["bot_pending_sessions_v2"]
    assert payload["session_id"] == "a1b2c3d4"
    assert kwargs["on_conflict"] == "user_id,session_type,session_id"


def test_get_bot_session_filters_by_session_id(monkeypatch):
    query = FakeQuery([{"payload": {"pending_places": []}, "session_id": "a1b2c3d4"}])
    client = FakeSupabase(query)
    monkeypatch.setattr(repository, "get_supabase", lambda: client)

    session = repository.get_bot_session_v2(
        123,
        "place_selection",
        "a1b2c3d4",
    )

    assert session == {"pending_places": []}
    assert client.table_names == ["bot_pending_sessions_v2"]
    assert ("eq", "session_id", "a1b2c3d4") in query.calls


def test_delete_bot_session_deletes_only_requested_session(monkeypatch):
    query = FakeQuery()
    client = FakeSupabase(query)
    monkeypatch.setattr(repository, "get_supabase", lambda: client)

    repository.delete_bot_session_v2(
        123,
        "place_selection",
        "a1b2c3d4",
    )

    assert client.table_names == ["bot_pending_sessions_v2"]
    assert ("eq", "session_id", "a1b2c3d4") in query.calls


def test_failed_extraction_persists_structured_diagnostics(monkeypatch):
    query = FakeQuery()
    client = FakeSupabase(query)
    monkeypatch.setattr(repository, "get_supabase", lambda: client)

    repository.log_failed_extraction(
        123,
        "https://example.com/post",
        platform="instagram",
        reason="metadata_timeout",
        failure_stage="metadata",
        flow="group",
        error_message="deadline exceeded",
        request_id="a1b2c3d4",
        details={"timeout_seconds": 30},
    )

    _, payload = query.calls[0]
    assert payload["reason"] == "metadata_timeout"
    assert payload["failure_stage"] == "metadata"
    assert payload["flow"] == "group"
    assert payload["request_id"] == "a1b2c3d4"
    assert payload["details"] == {"timeout_seconds": 30}
