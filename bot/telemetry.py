"""Best-effort, privacy-conscious Telegram bot telemetry."""

import logging
from typing import Any

from database import supabase_repository as repository

logger = logging.getLogger(__name__)


def record_bot_event(
    user_id: int | None,
    event_name: str,
    *,
    entity_type: str | None = None,
    entity_id: object | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Record an event without ever allowing telemetry failure to break UX."""
    safe_metadata = {
        key: value
        for key, value in (metadata or {}).items()
        if key not in {"url", "source_url", "caption", "transcript"}
    }
    try:
        repository.create_app_event(
            user_id=user_id,
            event_name=event_name,
            event_source="telegram_bot",
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id is not None else None,
            metadata=safe_metadata,
        )
    except Exception:
        logger.warning("Could not record bot event %s", event_name, exc_info=True)
