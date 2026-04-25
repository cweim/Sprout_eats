#!/usr/bin/env python3
"""Simulate user-submitted Instagram links through the no-cookie retry policy."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys
import time
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from services.instagram_public import extract_instagram_shortcode, extract_instagram_instaloader  # noqa: E402
from services.metadata_normalizer import metadata_candidate_to_runtime_record  # noqa: E402
from services.place_pipeline import extract_place_evidence_from_metadata  # noqa: E402


DEFAULT_INPUT = REPO_ROOT / "place-extraction-pipeline" / "ig_links.md"
DEFAULT_OUTPUT = REPO_ROOT / "place-extraction-pipeline" / "datasets" / "instagram_no_cookie_retry_simulation.json"


def read_links(path: Path) -> list[str]:
    links = []
    for line in path.read_text(encoding="utf-8").splitlines():
        clean = line.strip()
        if clean and not clean.startswith("#"):
            links.append(clean)
    return links


def classify_error(error: str | None) -> str:
    message = (error or "").lower()
    if "403 forbidden" in message or "403," in message:
        return "403"
    if "timed out" in message or "timeout" in message:
        return "timeout"
    if "decode content-encoding: zstd" in message:
        return "zstd"
    if not message:
        return "none"
    return "other"


async def run_attempt(url: str, timeout_seconds: float) -> dict[str, Any]:
    shortcode = extract_instagram_shortcode(url)
    if not shortcode:
        return {
            "success": False,
            "error": "Could not extract Instagram shortcode",
            "error_type": "other",
            "duration_seconds": 0.0,
            "slot_count": 0,
            "slot_names": [],
        }

    started = time.monotonic()
    try:
        candidate = await asyncio.wait_for(
            extract_instagram_instaloader(shortcode),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        return {
            "success": False,
            "error": f"Timed out after {timeout_seconds:.0f}s",
            "error_type": "timeout",
            "duration_seconds": round(time.monotonic() - started, 3),
            "slot_count": 0,
            "slot_names": [],
        }

    slots = []
    if candidate.success:
        record = metadata_candidate_to_runtime_record(candidate, source_url=url)
        slots = extract_place_evidence_from_metadata(record)

    return {
        "success": candidate.success,
        "error": candidate.error,
        "error_type": classify_error(candidate.error),
        "duration_seconds": round(time.monotonic() - started, 3),
        "description_length": len(candidate.description or ""),
        "slot_count": len(slots),
        "slot_names": [slot.name_candidate for slot in slots],
    }


async def simulate_link(
    url: str,
    *,
    timeout_seconds: float,
    retry_delay_seconds: float,
) -> dict[str, Any]:
    first = await run_attempt(url, timeout_seconds)
    result: dict[str, Any] = {
        "url": url,
        "attempts": [first],
        "final_status": "success" if first["success"] else "failed",
        "retry_triggered": False,
    }

    if first["error_type"] == "403":
        result["retry_triggered"] = True
        await asyncio.sleep(retry_delay_seconds)
        second = await run_attempt(url, timeout_seconds)
        result["attempts"].append(second)
        result["final_status"] = "success_after_retry" if second["success"] else "failed_after_retry"

    return result


async def main_async() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--retry-delay", type=float, default=8.0)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    urls = read_links(args.input)[: args.limit]
    semaphore = asyncio.Semaphore(args.concurrency)

    async def worker(url: str) -> dict[str, Any]:
        async with semaphore:
            return await simulate_link(
                url,
                timeout_seconds=args.timeout,
                retry_delay_seconds=args.retry_delay,
            )

    records = await asyncio.gather(*(worker(url) for url in urls))
    summary = {
        "total_links": len(records),
        "success_on_first_attempt": sum(
            1 for record in records
            if record["attempts"][0]["success"]
        ),
        "links_hitting_403": sum(
            1 for record in records
            if record["attempts"][0]["error_type"] == "403"
        ),
        "success_after_retry": sum(
            1 for record in records
            if record["final_status"] == "success_after_retry"
        ),
        "failed_after_retry": sum(
            1 for record in records
            if record["final_status"] == "failed_after_retry"
        ),
        "timeout_failures": sum(
            1 for record in records
            if any(attempt["error_type"] == "timeout" for attempt in record["attempts"])
        ),
    }
    args.output.write_text(
        json.dumps({"summary": summary, "records": records}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(args.output)
    print(summary)


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
