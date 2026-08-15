import asyncio
from types import SimpleNamespace

import pytest

from bot.handlers import (
    _complete_safe_correction,
    _handle_instagram_no_cookie_url,
    _start_multi_place_selection,
    build_selection_keyboard,
    handle_url,
    toggle_place_callback,
    unresolved_pick_callback,
    undo_place_callback,
)
from services.places import PlaceResult


@pytest.mark.asyncio
async def test_correction_saves_replacement_before_deleting_original(monkeypatch):
    calls = []
    place = PlaceResult(
        name="Right Cafe",
        address="2 Correct Road",
        latitude=1.2,
        longitude=103.8,
        place_id="right-place",
        types=["cafe"],
    )

    class FakeMessage:
        async def reply_text(self, *args, **kwargs):
            calls.append("reply")

    monkeypatch.setattr(
        "bot.handlers.repository.add_place_with_outcome",
        lambda **kwargs: (calls.append("save") or {
            "place": {"id": 22, **kwargs},
            "created": True,
        }),
    )
    monkeypatch.setattr(
        "bot.handlers.repository.delete_place",
        lambda user_id, place_id: (calls.append(f"delete:{place_id}") or True),
    )
    monkeypatch.setattr("bot.handlers.repository.delete_bot_session_v2", lambda *args: calls.append("clear"))
    monkeypatch.setattr("bot.handlers.repository.save_bot_session_v2", lambda *args, **kwargs: None)
    monkeypatch.setattr("bot.handlers.record_bot_event", lambda *args, **kwargs: None)

    await _complete_safe_correction(
        FakeMessage(),
        123,
        "aaaaaaaa",
        {"place_id": 11, "source_url": "https://example.com", "source_platform": "instagram"},
        place,
    )

    assert calls.index("save") < calls.index("delete:11")


@pytest.mark.asyncio
async def test_undo_only_deletes_place_owned_by_callback_user(monkeypatch):
    deleted = []

    class FakeQuery:
        data = "undo:42"

        async def answer(self, text):
            return None

        async def edit_message_text(self, *args, **kwargs):
            return None

    update = SimpleNamespace(effective_user=SimpleNamespace(id=123), callback_query=FakeQuery())
    context = SimpleNamespace(user_data={})
    monkeypatch.setattr(
        "bot.handlers.repository.delete_place",
        lambda user_id, place_id: (deleted.append((user_id, place_id)) or True),
    )
    monkeypatch.setattr("bot.handlers.record_bot_event", lambda *args, **kwargs: None)

    await undo_place_callback(update, context)

    assert deleted == [(123, 42)]


class FakeStatusMessage:
    def __init__(self):
        self.edits = []

    async def edit_text(self, text, reply_markup=None, **kwargs):
        self.edits.append((text, reply_markup))
        return self


@pytest.mark.asyncio
async def test_instagram_metadata_failure_is_recorded(monkeypatch):
    failures = []
    status = FakeStatusMessage()
    update = SimpleNamespace(effective_user=SimpleNamespace(id=123))
    context = SimpleNamespace(user_data={})

    async def failed_pipeline(*args, **kwargs):
        return {
            "status": "failed",
            "timed_out_stage": None,
            "error": "metadata unavailable",
        }

    async def fallback(*args, **kwargs):
        return None

    monkeypatch.setattr("bot.handlers.run_instagram_place_pipeline", failed_pipeline)
    monkeypatch.setattr("bot.handlers.prompt_instagram_manual_fallback", fallback)
    monkeypatch.setattr("bot.handlers.log_failed_link", lambda **kwargs: failures.append(kwargs))

    await _handle_instagram_no_cookie_url(
        update,
        context,
        "https://www.instagram.com/reel/FAIL/",
        status,
        request_id="a1b2c3d4",
    )

    assert failures == [{
        "user_id": 123,
        "url": "https://www.instagram.com/reel/FAIL/",
        "platform": "instagram",
        "reason": "metadata_failed",
        "failure_stage": "metadata",
        "error_message": "metadata unavailable",
        "request_id": "a1b2c3d4",
        "details": {"pipeline_status": "failed"},
    }]


@pytest.mark.asyncio
async def test_reviewable_candidates_are_recorded_as_needing_confirmation(monkeypatch):
    failures = []
    status = FakeStatusMessage()
    update = SimpleNamespace(effective_user=SimpleNamespace(id=123))
    context = SimpleNamespace(user_data={})
    candidate = SimpleNamespace(description="Possible Cafe", title="", uploader=None, duration=None, hashtags=[])

    async def unresolved_pipeline(*args, **kwargs):
        return {
            "status": "metadata_only",
            "timed_out_stage": None,
            "metadata_source": "instagram_public_html",
            "metadata_candidate": candidate,
            "slots": [SimpleNamespace(source="caption")],
            "places": [],
            "unresolved_suggestions": [SimpleNamespace(status="unresolved")],
        }

    async def fallback(*args, **kwargs):
        return None

    monkeypatch.setattr("bot.handlers.run_instagram_place_pipeline", unresolved_pipeline)
    monkeypatch.setattr(
        "bot.handlers.collect_reviewable_unresolved_candidates",
        lambda suggestions: [{"name": "Possible Cafe"}],
    )
    monkeypatch.setattr("bot.handlers.prompt_instagram_manual_fallback", fallback)
    monkeypatch.setattr("bot.handlers.log_failed_link", lambda **kwargs: failures.append(kwargs))

    await _handle_instagram_no_cookie_url(
        update,
        context,
        "https://www.instagram.com/reel/MAYBE/",
        status,
        request_id="bbbbbbbb",
    )

    assert failures[0]["reason"] == "needs_confirmation"
    assert failures[0]["failure_stage"] == "resolution"
    assert failures[0]["details"]["reviewable_candidate_count"] == 1


def test_selection_keyboard_keeps_legacy_callback_format():
    keyboard = build_selection_keyboard([{"name": "Legacy Cafe"}], {0})
    callback_data = [
        button.callback_data
        for row in keyboard.inline_keyboard
        for button in row
    ]

    assert callback_data == [
        "save_all",
        "toggle_place_0",
        "save_selected",
        "cancel_selection",
    ]


def make_update(url="https://www.instagram.com/reel/ABC123/"):
    status = FakeStatusMessage()

    async def reply_text(text, reply_markup=None, **kwargs):
        status.edits.append((text, reply_markup))
        return status

    update = SimpleNamespace(
        effective_chat=SimpleNamespace(type="private"),
        effective_user=SimpleNamespace(
            id=123,
            username="tester",
            first_name="Test",
            last_name=None,
            language_code="en",
        ),
        message=SimpleNamespace(text=url, reply_text=reply_text),
    )
    return update, status


@pytest.mark.asyncio
async def test_multi_place_selection_persists_explicit_user_id(monkeypatch):
    persisted = []
    context = SimpleNamespace(user_data={})
    status = FakeStatusMessage()
    place = PlaceResult(
        name="Test Cafe",
        address="1 Test Street",
        latitude=1.0,
        longitude=103.0,
        place_id="test-place",
        types=["restaurant"],
        confidence_label="high",
    )

    monkeypatch.setattr(
        "bot.handlers._persist_place_session",
        lambda context, user_id, session_id, session: persisted.append(
            (user_id, session_id, session)
        ),
    )

    await _start_multi_place_selection(
        context,
        status,
        user_id=123,
        places=[place],
        source_url="https://www.instagram.com/reel/ABC123/",
        source_platform="instagram",
    )

    assert persisted[0][0] == 123
    assert len(persisted[0][1]) == 8
    assert persisted[0][2]["pending_places"][0]["name"] == "Test Cafe"
    assert status.edits
    keyboard = status.edits[-1][1]
    callback_data = [
        button.callback_data
        for row in keyboard.inline_keyboard
        for button in row
    ]
    assert all(data.startswith(f"ps:{persisted[0][1]}:") for data in callback_data)
    assert all(len(data.encode()) <= 64 for data in callback_data)


@pytest.mark.asyncio
async def test_toggle_updates_only_callback_session(monkeypatch):
    sessions = {
        "aaaaaaaa": {
            "pending_places": [{"name": "First", "address": "A"}],
            "selected_indices": [],
            "pending_video_meta": {},
        },
        "bbbbbbbb": {
            "pending_places": [{"name": "Second", "address": "B"}],
            "selected_indices": [],
            "pending_video_meta": {},
        },
    }
    persisted = []

    class FakeQuery:
        data = "ps:aaaaaaaa:t:0"
        id = "query"

        async def answer(self, text):
            return None

        async def edit_message_text(self, text, reply_markup=None):
            return None

    update = SimpleNamespace(
        effective_user=SimpleNamespace(id=123),
        callback_query=FakeQuery(),
    )
    context = SimpleNamespace(user_data={})

    monkeypatch.setattr(
        "bot.handlers._load_place_session",
        lambda context, user_id, session_id: sessions[session_id],
    )
    monkeypatch.setattr(
        "bot.handlers._persist_place_session",
        lambda context, user_id, session_id, session: persisted.append(session_id),
    )

    await toggle_place_callback(update, context)

    assert sessions["aaaaaaaa"]["selected_indices"] == [0]
    assert sessions["bbbbbbbb"]["selected_indices"] == []
    assert persisted == ["aaaaaaaa"]


@pytest.mark.asyncio
async def test_unresolved_pick_uses_callback_session(monkeypatch):
    sessions = {
        "aaaaaaaa": {
            "pending_unresolved_slots": [{
                "name": "First",
                "address": "A",
                "latitude": 1.0,
                "longitude": 103.0,
                "place_id": "first",
                "types": ["restaurant"],
            }],
            "pending_url": "https://example.com/first",
            "pending_platform": "instagram",
        },
        "bbbbbbbb": {
            "pending_unresolved_slots": [{
                "name": "Second",
                "address": "B",
                "latitude": 2.0,
                "longitude": 104.0,
                "place_id": "second",
                "types": ["restaurant"],
            }],
            "pending_url": "https://example.com/second",
            "pending_platform": "instagram",
        },
    }
    saved = []
    deleted = []

    class FakeMessage:
        async def reply_location(self, **kwargs):
            return None

        async def reply_text(self, *args, **kwargs):
            return None

    class FakeQuery:
        data = "ur:aaaaaaaa:0"
        message = FakeMessage()

        async def answer(self, text=None):
            return None

        async def edit_message_text(self, text):
            return None

    update = SimpleNamespace(
        effective_user=SimpleNamespace(id=123),
        callback_query=FakeQuery(),
    )
    context = SimpleNamespace(user_data={})

    monkeypatch.setattr("bot.handlers.ensure_bot_user", lambda update: None)
    monkeypatch.setattr(
        "bot.handlers.repository.get_bot_session_v2",
        lambda user_id, session_type, session_id: sessions[session_id],
    )
    monkeypatch.setattr(
        "bot.handlers.repository.add_place_with_outcome",
        lambda **kwargs: (saved.append(kwargs) or {
            "place": {"id": 99, **kwargs},
            "created": True,
        }),
    )
    monkeypatch.setattr(
        "bot.handlers.repository.save_bot_session_v2",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "bot.handlers.repository.delete_bot_session_v2",
        lambda user_id, session_type, session_id: deleted.append(session_id),
    )

    await unresolved_pick_callback(update, context)

    assert saved[0]["name"] == "First"
    assert saved[0]["source_url"] == "https://example.com/first"
    assert deleted == ["aaaaaaaa"]


@pytest.mark.asyncio
async def test_handle_url_replaces_status_after_unexpected_error(monkeypatch):
    update, status = make_update()
    context = SimpleNamespace(user_data={})
    failures = []

    async def fail(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("bot.handlers.ensure_bot_user", lambda update: None)
    monkeypatch.setattr("bot.handlers._handle_instagram_no_cookie_url", fail)
    monkeypatch.setattr("bot.handlers.config.INSTAGRAM_NO_COOKIE_ENABLED", True)
    monkeypatch.setattr("bot.handlers.log_failed_link", lambda **kwargs: failures.append(kwargs))

    await handle_url(update, context)

    assert "Something went wrong" in status.edits[-1][0]
    assert failures[0]["reason"] == "extraction_exception"
    assert failures[0]["failure_stage"] == "pipeline"
    assert failures[0]["error_message"] == "boom"
    assert not any(key.startswith("extraction_task_") for key in context.user_data)


@pytest.mark.asyncio
async def test_handle_url_replaces_status_after_deadline(monkeypatch):
    update, status = make_update()
    context = SimpleNamespace(user_data={})
    failures = []

    async def never_finishes(*args, **kwargs):
        await asyncio.Event().wait()

    async def show_fallback(status_msg, context, source_url, **kwargs):
        await status_msg.edit_text("manual fallback")

    monkeypatch.setattr("bot.handlers.ensure_bot_user", lambda update: None)
    monkeypatch.setattr("bot.handlers._handle_instagram_no_cookie_url", never_finishes)
    monkeypatch.setattr("bot.handlers.prompt_instagram_manual_fallback", show_fallback)
    monkeypatch.setattr("bot.handlers.config.INSTAGRAM_NO_COOKIE_ENABLED", True)
    monkeypatch.setattr("bot.handlers.config.BOT_EXTRACTION_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr("bot.handlers.log_failed_link", lambda **kwargs: failures.append(kwargs))

    await handle_url(update, context)

    assert status.edits[-1][0] == "manual fallback"
    assert failures[0]["reason"] == "extraction_timeout"
    assert failures[0]["failure_stage"] == "pipeline"
    assert not any(key.startswith("extraction_task_") for key in context.user_data)


@pytest.mark.asyncio
async def test_new_link_cancels_previous_extraction_for_same_user(monkeypatch):
    first_update, first_status = make_update("https://www.instagram.com/reel/FIRST/")
    second_update, second_status = make_update("https://www.instagram.com/reel/SECOND/")
    context = SimpleNamespace(user_data={})
    first_started = asyncio.Event()
    first_cancelled = asyncio.Event()
    calls = 0

    async def extract(update, context, text, status_msg, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            first_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                first_cancelled.set()
                raise
        await status_msg.edit_text("second complete")

    monkeypatch.setattr("bot.handlers.ensure_bot_user", lambda update: None)
    monkeypatch.setattr("bot.handlers._handle_instagram_no_cookie_url", extract)
    monkeypatch.setattr("bot.handlers.config.INSTAGRAM_NO_COOKIE_ENABLED", True)

    first_task = asyncio.create_task(handle_url(first_update, context))
    await first_started.wait()
    await handle_url(second_update, context)
    await first_task

    assert first_cancelled.is_set()
    assert first_status.edits[-1][0] == "Cancelled. Send another link anytime."
    assert second_status.edits[-1][0] == "second complete"
    assert "active_extraction_task" not in context.user_data
