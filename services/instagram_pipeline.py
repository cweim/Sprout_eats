from __future__ import annotations

import asyncio
import copy
import logging
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any

import config
from services.instagram_apify_client import extract_instagram_via_apify
from services.instagram_public import extract_instagram_metadata
from services.instagram_worker_client import extract_instagram_via_worker
from services.content_attribution import canonicalize_content_url
from services.metadata_normalizer import metadata_candidate_to_runtime_record
from services.place_pipeline import extract_place_evidence_from_metadata, resolve_place_slots
from services.public_metadata import MetadataCandidate


logger = logging.getLogger(__name__)

_instagram_no_cookie_semaphore = asyncio.Semaphore(max(1, config.INSTAGRAM_NO_COOKIE_CONCURRENCY))
_instagram_no_cookie_lock = asyncio.Lock()
_instagram_no_cookie_failures: list[float] = []
_instagram_no_cookie_cooldown_until = 0.0
_instagram_metadata_cache: OrderedDict[str, tuple[float, MetadataCandidate]] = OrderedDict()


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


def _metadata_cache_key(url: str) -> str:
    canonical = canonicalize_content_url("instagram", url)
    return canonical.content_id or canonical.canonical_url


def _clone_metadata_candidate(candidate: MetadataCandidate) -> MetadataCandidate:
    return copy.deepcopy(candidate)


def _get_cached_metadata(url: str) -> MetadataCandidate | None:
    key = _metadata_cache_key(url)
    cached = _instagram_metadata_cache.get(key)
    if not cached:
        return None
    cached_at, candidate = cached
    if time.monotonic() - cached_at > config.INSTAGRAM_METADATA_CACHE_TTL_SECONDS:
        _instagram_metadata_cache.pop(key, None)
        return None
    _instagram_metadata_cache.move_to_end(key)
    return _clone_metadata_candidate(candidate)


def _cache_metadata(url: str, candidate: MetadataCandidate) -> None:
    if not candidate.success or config.INSTAGRAM_METADATA_CACHE_MAX_ENTRIES <= 0:
        return
    key = _metadata_cache_key(url)
    _instagram_metadata_cache[key] = (time.monotonic(), _clone_metadata_candidate(candidate))
    _instagram_metadata_cache.move_to_end(key)
    while len(_instagram_metadata_cache) > config.INSTAGRAM_METADATA_CACHE_MAX_ENTRIES:
        _instagram_metadata_cache.popitem(last=False)


def clear_instagram_metadata_cache() -> None:
    """Clear the bounded process cache; exposed for tests and operational reloads."""
    _instagram_metadata_cache.clear()


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


def _choose_best_error(candidates: list[Any]) -> str | None:
    errored = [candidate for candidate in candidates if getattr(candidate, "error", None)]
    if not errored:
        return None

    # Prefer the stronger extractor's error so logs reflect the real blocker rather
    # than the lightweight HTML parser's expected miss.
    source_priority = {
        "instagram_apify": 4,
        "instagram_worker": 3,
        "instagram_instaloader": 2,
        "instagram_public_html": 1,
    }
    errored.sort(
        key=lambda candidate: (
            source_priority.get(getattr(candidate, "source", ""), 0),
            len((candidate.error or "").strip()),
        ),
        reverse=True,
    )
    return errored[0].error


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
    cached = _get_cached_metadata(url)
    if cached:
        logger.info("Instagram metadata cache hit for %s", _metadata_cache_key(url))
        return {
            "status": "ok",
            "metadata_candidate": cached,
            "candidates": [cached],
            "cache_hit": True,
            "error": None,
        }

    if config.INSTAGRAM_EXTRACTION_BACKEND == "apify":
        candidate = await extract_instagram_via_apify(url)
        if candidate.success:
            _cache_metadata(url, candidate)
            return {
                "status": "ok",
                "metadata_candidate": candidate,
                "candidates": [candidate],
                "cache_hit": False,
                "error": None,
            }
        return {
            "status": "failed",
            "metadata_candidate": None,
            "candidates": [candidate],
            "cache_hit": False,
            "error": candidate.error or "Instagram Apify extraction failed",
        }
    if config.INSTAGRAM_EXTRACTION_BACKEND == "worker":
        candidate = await extract_instagram_via_worker(url)
        if candidate.success:
            _cache_metadata(url, candidate)
            return {
                "status": "ok",
                "metadata_candidate": candidate,
                "candidates": [candidate],
                "cache_hit": False,
                "error": None,
            }
        return {
            "status": "failed",
            "metadata_candidate": None,
            "candidates": [candidate],
            "cache_hit": False,
            "error": candidate.error or "Instagram worker extraction failed",
        }
    result = await extract_instagram_metadata_no_cookie_direct(url)
    candidate = result.get("metadata_candidate")
    if candidate:
        _cache_metadata(url, candidate)
    result["cache_hit"] = False
    return result


async def _extract_metadata_with_progress(
    url: str,
    on_stage: Callable[[str], Awaitable[None]] | None,
) -> dict[str, Any]:
    """Wait for metadata once, emitting bounded progress without restarting extraction."""
    timeout = max(0.01, config.BOT_METADATA_TIMEOUT_SECONDS)
    milestones = [
        (config.BOT_METADATA_PROGRESS_SECONDS, "metadata_waiting"),
        (config.BOT_METADATA_STILL_WORKING_SECONDS, "metadata_still_waiting"),
    ]
    milestones = sorted(
        (seconds, stage)
        for seconds, stage in milestones
        if 0 < seconds < timeout
    )
    task = asyncio.create_task(extract_instagram_metadata_no_cookie(url))
    started_at = asyncio.get_running_loop().time()
    try:
        for threshold, stage in milestones:
            elapsed = asyncio.get_running_loop().time() - started_at
            done, _ = await asyncio.wait({task}, timeout=max(0, threshold - elapsed))
            if done:
                return task.result()
            if on_stage:
                await on_stage(stage)

        elapsed = asyncio.get_running_loop().time() - started_at
        return await asyncio.wait_for(task, timeout=max(0.01, timeout - elapsed))
    except (asyncio.TimeoutError, asyncio.CancelledError):
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        raise


async def extract_instagram_metadata_no_cookie_direct(url: str) -> dict[str, Any]:
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

        error = _choose_best_error(candidates)
        return {
            "status": "failed",
            "metadata_candidate": None,
            "candidates": candidates,
            "error": error or "No usable public Instagram metadata found",
        }
    finally:
        await _leave_instagram_queue(success=success)


async def run_instagram_place_pipeline(
    url: str,
    *,
    on_stage: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    try:
        extraction = await _extract_metadata_with_progress(url, on_stage)
    except asyncio.TimeoutError:
        logger.warning("Instagram metadata extraction timed out for %s", url)
        return {
            "status": "timed_out",
            "timed_out_stage": "metadata",
            "metadata_source": None,
            "metadata_candidate": None,
            "metadata_cache_hit": False,
            "slots": [],
            "suggestions": [],
            "places": [],
            "unresolved_suggestions": [],
            "error": "Instagram metadata extraction timed out",
        }

    candidate = extraction.get("metadata_candidate")
    if not candidate:
        return {
            "status": "failed",
            "metadata_source": None,
            "metadata_candidate": None,
            "metadata_cache_hit": False,
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
            "metadata_cache_hit": bool(extraction.get("cache_hit")),
            "slots": [],
            "suggestions": [],
            "places": [],
            "unresolved_suggestions": [],
            "error": None,
        }

    if on_stage:
        await on_stage("resolving")
    suggestions = await resolve_place_slots(
        slots,
        timeout_seconds=config.BOT_PLACE_RESOLUTION_TIMEOUT_SECONDS,
        max_concurrency=config.BOT_PLACE_RESOLUTION_CONCURRENCY,
    )
    places = []
    unresolved_suggestions = []
    for suggestion in suggestions:
        if suggestion.status == "resolved" and suggestion.selected:
            places.append(suggestion.selected)
        else:
            unresolved_suggestions.append(suggestion)

    resolution_timed_out = any(suggestion.status == "timed_out" for suggestion in suggestions)
    if resolution_timed_out:
        status = "partial" if places else "timed_out"
    else:
        status = "resolved" if places else "metadata_only"
    return {
        "status": status,
        "timed_out_stage": "resolution" if resolution_timed_out else None,
        "metadata_source": candidate.source,
        "metadata_candidate": candidate,
        "metadata_cache_hit": bool(extraction.get("cache_hit")),
        "slots": slots,
        "suggestions": suggestions,
        "places": places,
        "unresolved_suggestions": unresolved_suggestions,
        "error": None,
    }
