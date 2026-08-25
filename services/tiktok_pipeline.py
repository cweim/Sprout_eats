from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp
import config
from services.metadata_normalizer import metadata_candidate_to_runtime_record
from services.place_pipeline import extract_place_evidence_from_metadata, resolve_place_slots
from services.tiktok_apify_client import extract_tiktok_via_apify
from services.tiktok_public import (
    extract_tiktok_api,
    extract_tiktok_oembed,
    extract_tiktok_public_html,
    extract_tiktok_ytdlp,
)


logger = logging.getLogger(__name__)

_PHOTO_URL_RE = re.compile(r"tiktok\.com/@[\w.]+/photo/\d+")


async def _resolve_canonical_url(url: str, timeout: float = 5.0) -> str:
    """Follow redirects and return the final URL. Falls back to original on error."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.head(
                url,
                allow_redirects=True,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                return str(resp.url)
    except Exception:
        return url


def _is_photo_post(url: str) -> bool:
    return bool(_PHOTO_URL_RE.search(url))


_SOURCE_PRIORITY = {
    "tiktok_ytdlp_no_cookies": 4,
    "tiktok_api": 3,
    "tiktok_oembed": 2,
    "tiktok_public_html": 1,
}


def _choose_best_candidate(candidates: list[Any]):
    successful = [c for c in candidates if getattr(c, "success", False)]
    if not successful:
        return None
    successful.sort(
        key=lambda c: (
            len((c.description or "").strip()),
            bool(c.video_url),
            len(c.image_urls or []),
            _SOURCE_PRIORITY.get(getattr(c, "source", ""), 0),
        ),
        reverse=True,
    )
    return successful[0]


def _choose_best_error(candidates: list[Any]) -> str | None:
    errored = [c for c in candidates if getattr(c, "error", None)]
    if not errored:
        return None
    errored.sort(
        key=lambda c: (
            _SOURCE_PRIORITY.get(getattr(c, "source", ""), 0),
            len((c.error or "").strip()),
        ),
        reverse=True,
    )
    return errored[0].error


async def run_tiktok_place_pipeline(
    url: str,
    *,
    on_stage: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    apify_available = bool(config.APIFY_API_TOKEN and config.APIFY_TIKTOK_ACTOR_ID)

    # Expand short URLs (vt.tiktok.com) to detect photo posts before wasting time on
    # fast extractors that will all fail for /photo/ URLs.
    canonical_url = await _resolve_canonical_url(url)
    if _is_photo_post(canonical_url):
        logger.info("TikTok photo post detected (%s), routing directly to Apify", canonical_url)
        if not apify_available:
            return {
                "status": "failed",
                "metadata_source": None,
                "metadata_candidate": None,
                "slots": [],
                "suggestions": [],
                "places": [],
                "unresolved_suggestions": [],
                "error": "TikTok photo posts require Apify (APIFY_API_TOKEN not configured)",
            }
        if on_stage:
            await on_stage("apify")
        best = await extract_tiktok_via_apify(url)
        candidates = []
    else:
        # Normal video post — run 4 fast extractors in parallel
        try:
            candidates = list(
                await asyncio.wait_for(
                    asyncio.gather(
                        extract_tiktok_public_html(url),
                        extract_tiktok_oembed(url),
                        extract_tiktok_api(url),
                        extract_tiktok_ytdlp(url),
                    ),
                    timeout=config.BOT_METADATA_TIMEOUT_SECONDS,
                )
            )
        except asyncio.TimeoutError:
            logger.warning("TikTok metadata extraction timed out for %s", url)
            return {
                "status": "timed_out",
                "timed_out_stage": "metadata",
                "metadata_source": None,
                "metadata_candidate": None,
                "slots": [],
                "suggestions": [],
                "places": [],
                "unresolved_suggestions": [],
                "error": "TikTok metadata extraction timed out",
            }

        best = _choose_best_candidate(candidates)
        if not best and apify_available:
            # Fast extractors failed (blocked video, etc.) — fall back to Apify
            logger.info("TikTok fast extractors failed, falling back to Apify for %s", url)
            if on_stage:
                await on_stage("apify")
            best = await extract_tiktok_via_apify(url)

    if not best or not best.success:
        error = _choose_best_error(candidates)
        return {
            "status": "failed",
            "metadata_source": None,
            "metadata_candidate": None,
            "slots": [],
            "suggestions": [],
            "places": [],
            "unresolved_suggestions": [],
            "error": error or "No usable TikTok metadata found",
        }

    runtime_record = metadata_candidate_to_runtime_record(best, source_url=url)
    slots = extract_place_evidence_from_metadata(runtime_record)
    if not slots:
        return {
            "status": "metadata_only",
            "metadata_source": best.source,
            "metadata_candidate": best,
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
        "metadata_source": best.source,
        "metadata_candidate": best,
        "slots": slots,
        "suggestions": suggestions,
        "places": places,
        "unresolved_suggestions": unresolved_suggestions,
        "error": None,
    }
