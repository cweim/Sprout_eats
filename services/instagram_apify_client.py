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
APIFY_FIELDS = ["caption", "hashtags", "ownerUsername", "locationName", "url", "transcript"]
TERMINAL_FAILURE_STATUSES = {"FAILED", "ABORTED", "TIMED-OUT"}


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

    start_endpoint = f"{APIFY_API_BASE}/acts/{_actor_ref()}/runs"
    payload = {
        "username": [url],
        "resultsLimit": 1,
        "includeDownloadedVideo": False,
        "includeSharesCount": False,
        "includeTranscript": True,
        "skipPinnedPosts": False,
    }
    request_timeout = httpx.Timeout(max(10, config.INSTAGRAM_NO_COOKIE_TIMEOUT_SECONDS))
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
                status_response = await client.get(
                    f"{APIFY_API_BASE}/actor-runs/{run_id}",
                )
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
                            "fields": ",".join(APIFY_FIELDS),
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
                        f"Apify extraction timed out after {config.APIFY_RUN_TIMEOUT_SECONDS:g}s",
                        t0,
                    )
                await _sleep_for_poll(min(config.APIFY_POLL_INTERVAL_SECONDS, remaining))
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
            "metric.apify.failure url=%s run_id=%s elapsed_s=%.2f error=no_results",
            url, run_id, elapsed,
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
            "metric.apify.success url=%s run_id=%s elapsed_s=%.2f caption_len=%d has_transcript=%s",
            url, run_id, elapsed, len(caption), bool(transcript),
        )
    return candidate


async def _sleep_for_poll(seconds: float) -> None:
    """Small seam for deterministic polling tests."""
    await asyncio.sleep(max(0, seconds))


async def _abort_run(
    client: httpx.AsyncClient,
    run_id: str,
) -> None:
    """Best-effort cancellation so a timed-out bot request does not leave paid work running."""
    try:
        response = await client.post(
            f"{APIFY_API_BASE}/actor-runs/{run_id}/abort",
            params={"gracefully": "true"},
        )
        response.raise_for_status()
    except Exception as exc:
        logger.warning("Could not abort Apify run %s: %s", run_id, exc)


def _failure_candidate(url: str, error: str, started_at: float) -> MetadataCandidate:
    elapsed = time.monotonic() - started_at
    logger.warning(
        "metric.apify.failure url=%s elapsed_s=%.2f error=%s",
        url, elapsed, error,
    )
    return MetadataCandidate(
        source="instagram_apify",
        platform="instagram",
        url=url,
        success=False,
        error=error,
    )
