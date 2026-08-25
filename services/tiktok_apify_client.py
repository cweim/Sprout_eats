from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

import config
from services.public_metadata import MetadataCandidate


logger = logging.getLogger(__name__)

APIFY_API_BASE = "https://api.apify.com/v2"
TIKTOK_APIFY_FIELDS = ["text", "hashtags", "authorMeta", "webVideoUrl", "isSlideshow", "videoMeta"]
TERMINAL_FAILURE_STATUSES = {"FAILED", "ABORTED", "TIMED-OUT"}


def _actor_ref() -> str:
    return config.APIFY_TIKTOK_ACTOR_ID.replace("/", "~")


async def extract_tiktok_via_apify(url: str) -> MetadataCandidate:
    if not config.APIFY_API_TOKEN:
        return MetadataCandidate(
            source="tiktok_apify",
            platform="tiktok",
            url=url,
            success=False,
            error="APIFY_API_TOKEN is not configured",
        )
    if not config.APIFY_TIKTOK_ACTOR_ID:
        return MetadataCandidate(
            source="tiktok_apify",
            platform="tiktok",
            url=url,
            success=False,
            error="APIFY_TIKTOK_ACTOR_ID is not configured",
        )

    start_endpoint = f"{APIFY_API_BASE}/acts/{_actor_ref()}/runs"
    payload = {
        "postURLs": [url],
        "scrapeRelatedVideos": False,
        "shouldDownloadSlideshowImages": False,
    }
    request_timeout = httpx.Timeout(max(10, config.APIFY_RUN_TIMEOUT_SECONDS))
    t0 = time.monotonic()
    run_id: str | None = None

    async with httpx.AsyncClient(
        timeout=request_timeout,
        headers={"Authorization": f"Bearer {config.APIFY_API_TOKEN}"},
    ) as client:
        try:
            response = await client.post(start_endpoint, json=payload)
            response.raise_for_status()
            run = (response.json() or {}).get("data") or {}
            run_id = run.get("id")
            if not run_id:
                raise RuntimeError("Apify did not return a run ID")

            deadline = t0 + max(0.01, config.APIFY_RUN_TIMEOUT_SECONDS)
            while True:
                status_response = await client.get(f"{APIFY_API_BASE}/actor-runs/{run_id}")
                status_response.raise_for_status()
                run = (status_response.json() or {}).get("data") or {}
                status = (run.get("status") or "").upper()

                if status == "SUCCEEDED":
                    dataset_id = run.get("defaultDatasetId")
                    if not dataset_id:
                        raise RuntimeError("Apify run completed without a dataset")
                    dataset_response = await client.get(
                        f"{APIFY_API_BASE}/datasets/{dataset_id}/items",
                        params={
                            "clean": "true",
                            "format": "json",
                            "limit": "1",
                            "fields": ",".join(TIKTOK_APIFY_FIELDS),
                        },
                    )
                    dataset_response.raise_for_status()
                    items = dataset_response.json()
                    break

                if status in TERMINAL_FAILURE_STATUSES:
                    message = run.get("statusMessage") or f"Apify run ended with status {status}"
                    raise RuntimeError(message)

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    await _abort_run(client, run_id)
                    return _failure_candidate(
                        url,
                        f"Apify TikTok extraction timed out after {config.APIFY_RUN_TIMEOUT_SECONDS:g}s",
                        t0,
                    )
                await asyncio.sleep(max(0, min(config.APIFY_POLL_INTERVAL_SECONDS, remaining)))

        except asyncio.CancelledError:
            if run_id:
                await asyncio.shield(_abort_run(client, run_id))
            raise
        except Exception as exc:
            if run_id:
                await _abort_run(client, run_id)
            return _failure_candidate(url, str(exc) or type(exc).__name__, t0)

    if not isinstance(items, list) or not items:
        elapsed = time.monotonic() - t0
        logger.warning(
            "metric.tiktok_apify.failure url=%s run_id=%s elapsed_s=%.2f error=no_results",
            url, run_id, elapsed,
        )
        return MetadataCandidate(
            source="tiktok_apify",
            platform="tiktok",
            url=url,
            success=False,
            error="Apify returned no TikTok results",
        )

    elapsed = time.monotonic() - t0
    item = items[0] if isinstance(items[0], dict) else {}
    caption = (item.get("text") or "").strip()
    hashtags = item.get("hashtags") or []
    author_meta = item.get("authorMeta") or {}
    uploader = author_meta.get("name") or author_meta.get("nickName")
    output_url = (item.get("webVideoUrl") or url).strip()
    video_meta = item.get("videoMeta") or {}
    thumbnail_url = video_meta.get("coverUrl")

    # hashtags from clockworks actor come as list of dicts with "name" key, or plain strings
    if hashtags and isinstance(hashtags[0], dict):
        hashtags = [h.get("name", "") for h in hashtags if h.get("name")]

    success = bool(caption)
    candidate = MetadataCandidate(
        source="tiktok_apify",
        platform="tiktok",
        url=output_url,
        success=success,
        title=caption[:150] if caption else "",
        description=caption,
        uploader=uploader,
        hashtags=hashtags if isinstance(hashtags, list) else [],
        thumbnail_url=thumbnail_url,
        image_urls=[thumbnail_url] if thumbnail_url else [],
        raw_fields={"authorMeta": author_meta},
    )
    if not success:
        candidate.error = "Apify returned no TikTok caption"
        logger.warning("metric.tiktok_apify.failure url=%s elapsed_s=%.2f error=no_caption", url, elapsed)
    else:
        logger.info(
            "metric.tiktok_apify.success url=%s run_id=%s elapsed_s=%.2f caption_len=%d",
            url, run_id, elapsed, len(caption),
        )
    return candidate


async def _abort_run(client: httpx.AsyncClient, run_id: str) -> None:
    try:
        response = await client.post(
            f"{APIFY_API_BASE}/actor-runs/{run_id}/abort",
            params={"gracefully": "true"},
        )
        response.raise_for_status()
    except Exception as exc:
        logger.warning("Could not abort Apify TikTok run %s: %s", run_id, exc)


def _failure_candidate(url: str, error: str, started_at: float) -> MetadataCandidate:
    elapsed = time.monotonic() - started_at
    logger.warning(
        "metric.tiktok_apify.failure url=%s elapsed_s=%.2f error=%s",
        url, elapsed, error,
    )
    return MetadataCandidate(
        source="tiktok_apify",
        platform="tiktok",
        url=url,
        success=False,
        error=error,
    )
