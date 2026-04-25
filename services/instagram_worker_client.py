from __future__ import annotations

import logging
from typing import Any

import httpx

import config
from services.public_metadata import MetadataCandidate


logger = logging.getLogger(__name__)


async def extract_instagram_via_worker(url: str) -> MetadataCandidate:
    if not config.INSTAGRAM_WORKER_URL:
        return MetadataCandidate(
            source="instagram_worker",
            platform="instagram",
            url=url,
            success=False,
            error="INSTAGRAM_WORKER_URL is not configured",
        )

    endpoint = config.INSTAGRAM_WORKER_URL.rstrip("/") + "/extract/instagram"
    headers = {}
    if config.INSTAGRAM_WORKER_TOKEN:
        headers["Authorization"] = f"Bearer {config.INSTAGRAM_WORKER_TOKEN}"

    payload = {"url": url}
    timeout = httpx.Timeout(config.INSTAGRAM_NO_COOKIE_TIMEOUT_SECONDS)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(endpoint, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
    except Exception as exc:
        logger.warning("Instagram worker request failed for %s: %s", url, exc)
        return MetadataCandidate(
            source="instagram_worker",
            platform="instagram",
            url=url,
            success=False,
            error=str(exc),
        )

    return MetadataCandidate(
        source=data.get("source") or "instagram_worker",
        platform="instagram",
        url=url,
        success=bool(data.get("success")),
        title=data.get("title") or "",
        description=data.get("description") or "",
        uploader=data.get("uploader"),
        duration=data.get("duration"),
        hashtags=data.get("hashtags") or [],
        content_type=data.get("content_type"),
        thumbnail_url=data.get("thumbnail_url"),
        video_url=data.get("video_url"),
        image_urls=data.get("image_urls") or [],
        raw_fields=data.get("raw_fields") or {},
        error=data.get("error"),
    )
