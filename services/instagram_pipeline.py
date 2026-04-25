from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import config
from services.instagram_public import extract_instagram_metadata
from services.metadata_normalizer import metadata_candidate_to_runtime_record
from services.place_pipeline import extract_place_evidence_from_metadata, resolve_place_slots


logger = logging.getLogger(__name__)

_instagram_no_cookie_semaphore = asyncio.Semaphore(max(1, config.INSTAGRAM_NO_COOKIE_CONCURRENCY))
_instagram_no_cookie_lock = asyncio.Lock()
_instagram_no_cookie_failures: list[float] = []
_instagram_no_cookie_cooldown_until = 0.0


class InstagramNoCookieCooldownError(Exception):
    """Raised when the public Instagram extractor is cooling down."""


def is_retryable_instagram_error(error: str | None) -> bool:
    message = (error or "").lower()
    if not message:
        return False
    return any(
        token in message
        for token in (
            "403 forbidden",
            "timed out",
            "timeout",
            "connection reset",
            "temporarily unavailable",
            "please wait a few minutes",
        )
    )


async def _enter_instagram_queue() -> None:
    async with _instagram_no_cookie_lock:
        if _instagram_no_cookie_cooldown_until > time.time():
            remaining = max(1, int(_instagram_no_cookie_cooldown_until - time.time()))
            raise InstagramNoCookieCooldownError(
                f"Instagram no-cookie extraction cooling down for {remaining} more seconds"
            )
    await _instagram_no_cookie_semaphore.acquire()


async def _leave_instagram_queue(success: bool) -> None:
    global _instagram_no_cookie_cooldown_until
    async with _instagram_no_cookie_lock:
        now = time.time()
        _instagram_no_cookie_failures[:] = [
            timestamp for timestamp in _instagram_no_cookie_failures
            if now - timestamp <= 300
        ]
        if not success:
            _instagram_no_cookie_failures.append(now)
            if len(_instagram_no_cookie_failures) >= 3:
                _instagram_no_cookie_cooldown_until = now + config.INSTAGRAM_NO_COOKIE_COOLDOWN_SECONDS
                logger.warning(
                    "Instagram no-cookie extractor entering cooldown for %ss after repeated failures",
                    config.INSTAGRAM_NO_COOKIE_COOLDOWN_SECONDS,
                )
    _instagram_no_cookie_semaphore.release()


async def _extract_with_timeout(url: str) -> list[Any]:
    timeout = config.INSTAGRAM_NO_COOKIE_TIMEOUT_SECONDS
    return await asyncio.wait_for(extract_instagram_metadata(url), timeout=timeout)


def _choose_best_candidate(candidates: list[Any]):
    successful = [candidate for candidate in candidates if getattr(candidate, "success", False)]
    if not successful:
        return None
    successful.sort(
        key=lambda candidate: (
            len((candidate.description or "").strip()),
            bool(candidate.video_url),
            len(candidate.image_urls or []),
        ),
        reverse=True,
    )
    return successful[0]


async def extract_instagram_metadata_no_cookie(url: str) -> dict[str, Any]:
    await _enter_instagram_queue()
    success = False
    try:
        try:
            candidates = await _extract_with_timeout(url)
        except Exception as exc:
            error_text = str(exc)
            logger.warning("Instagram no-cookie extraction failed on first attempt for %s: %s", url, error_text)
            if is_retryable_instagram_error(error_text):
                await asyncio.sleep(config.INSTAGRAM_NO_COOKIE_RETRY_DELAY_SECONDS)
                candidates = await _extract_with_timeout(url)
            else:
                raise

        best = _choose_best_candidate(candidates)
        if best:
            success = True
            return {
                "status": "ok",
                "metadata_candidate": best,
                "candidates": candidates,
                "error": None,
            }

        error = next((candidate.error for candidate in candidates if getattr(candidate, "error", None)), None)
        return {
            "status": "failed",
            "metadata_candidate": None,
            "candidates": candidates,
            "error": error or "No usable public Instagram metadata found",
        }
    finally:
        await _leave_instagram_queue(success=success)


async def run_instagram_place_pipeline(url: str) -> dict[str, Any]:
    extraction = await extract_instagram_metadata_no_cookie(url)
    candidate = extraction.get("metadata_candidate")
    if not candidate:
        return {
            "status": "failed",
            "metadata_source": None,
            "metadata_candidate": None,
            "slots": [],
            "suggestions": [],
            "places": [],
            "unresolved_suggestions": [],
            "error": extraction.get("error"),
        }

    runtime_record = metadata_candidate_to_runtime_record(candidate, source_url=url)
    slots = extract_place_evidence_from_metadata(runtime_record)
    if not slots:
        return {
            "status": "metadata_only",
            "metadata_source": candidate.source,
            "metadata_candidate": candidate,
            "slots": [],
            "suggestions": [],
            "places": [],
            "unresolved_suggestions": [],
            "error": None,
        }

    suggestions = await resolve_place_slots(slots)
    places = []
    unresolved_suggestions = []
    for suggestion in suggestions:
        if suggestion.status == "resolved" and suggestion.selected:
            places.append(suggestion.selected)
        else:
            unresolved_suggestions.append(suggestion)

    status = "resolved" if places else "metadata_only"
    return {
        "status": status,
        "metadata_source": candidate.source,
        "metadata_candidate": candidate,
        "slots": slots,
        "suggestions": suggestions,
        "places": places,
        "unresolved_suggestions": unresolved_suggestions,
        "error": None,
    }
