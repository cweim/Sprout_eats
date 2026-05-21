from __future__ import annotations

import logging
import time
from typing import Any

import httpx

import config
from services.public_metadata import MetadataCandidate


logger = logging.getLogger(__name__)

APIFY_API_BASE = "https://api.apify.com/v2"
APIFY_FIELDS = ["caption", "hashtags", "ownerUsername", "locationName", "url", "transcript"]


def _actor_ref() -> str:
    return config.APIFY_ACTOR_ID.replace("/", "~")


async def extract_instagram_via_apify(url: str) -> MetadataCandidate:
    if not config.APIFY_API_TOKEN:
        return MetadataCandidate(
            source="instagram_apify",
            platform="instagram",
            url=url,
            success=False,
            error="APIFY_API_TOKEN is not configured",
        )

    endpoint = f"{APIFY_API_BASE}/acts/{_actor_ref()}/run-sync-get-dataset-items"
    payload = {
        "username": [url],
        "resultsLimit": 1,
        "includeDownloadedVideo": False,
        "includeSharesCount": False,
        "includeTranscript": True,
        "skipPinnedPosts": False,
    }
    params = {
        "token": config.APIFY_API_TOKEN,
        "clean": "true",
        "format": "json",
        "limit": "1",
        "fields": ",".join(APIFY_FIELDS),
    }
    timeout = httpx.Timeout(max(30, config.INSTAGRAM_NO_COOKIE_TIMEOUT_SECONDS))

    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(endpoint, params=params, json=payload)
            response.raise_for_status()
            items = response.json()
    except Exception as exc:
        elapsed = time.monotonic() - t0
        logger.warning(
            "metric.apify.failure url=%s elapsed_s=%.2f error=%s",
            url, elapsed, exc,
        )
        return MetadataCandidate(
            source="instagram_apify",
            platform="instagram",
            url=url,
            success=False,
            error=str(exc),
        )

    if not isinstance(items, list) or not items:
        elapsed = time.monotonic() - t0
        logger.warning(
            "metric.apify.failure url=%s elapsed_s=%.2f error=no_results",
            url, elapsed,
        )
        return MetadataCandidate(
            source="instagram_apify",
            platform="instagram",
            url=url,
            success=False,
            error="Apify returned no Instagram reel results",
        )

    elapsed = time.monotonic() - t0
    item = items[0] if isinstance(items[0], dict) else {}
    caption = (item.get("caption") or "").strip()
    transcript = (item.get("transcript") or "").strip()
    hashtags = item.get("hashtags") or []
    uploader = item.get("ownerUsername")
    location_name = (item.get("locationName") or "").strip()
    output_url = (item.get("url") or url).strip()

    # Combine caption + transcript; transcript supplements when caption is sparse
    if transcript and transcript != caption:
        description = f"{caption}\n\n{transcript}".strip() if caption else transcript
    else:
        description = caption

    success = bool(caption or location_name)
    candidate = MetadataCandidate(
        source="instagram_apify",
        platform="instagram",
        url=output_url,
        success=success,
        title=location_name,
        description=description,
        uploader=uploader,
        hashtags=hashtags if isinstance(hashtags, list) else [],
        raw_fields={
            "locationName": item.get("locationName"),
        },
    )
    if not success:
        candidate.error = "Apify returned no useful Instagram metadata"
        logger.warning("metric.apify.failure url=%s elapsed_s=%.2f error=no_useful_metadata", url, elapsed)
    else:
        logger.info(
            "metric.apify.success url=%s elapsed_s=%.2f caption_len=%d has_transcript=%s",
            url, elapsed, len(caption), bool(transcript),
        )
    return candidate
