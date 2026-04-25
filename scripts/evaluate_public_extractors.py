#!/usr/bin/env python3
"""Evaluate no-cookie metadata extractors against the existing social ground truth."""

from __future__ import annotations

import argparse
import asyncio
from collections import Counter
import json
from pathlib import Path
import re
import sys
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from services.downloader import detect_platform  # noqa: E402
from services.instagram_public import extract_instagram_metadata  # noqa: E402
from services.metadata_normalizer import metadata_candidate_to_runtime_record  # noqa: E402
from services.place_pipeline import extract_place_evidence_from_metadata, resolve_place_slots  # noqa: E402
from services.public_metadata import MetadataCandidate  # noqa: E402
from services.tiktok_public import extract_tiktok_metadata  # noqa: E402
from services.places import search_place  # noqa: E402


DEFAULT_INPUTS = [
    REPO_ROOT / "place-extraction-pipeline" / "ig_links.md",
    REPO_ROOT / "place-extraction-pipeline" / "tiktok_links.md",
]
DEFAULT_GROUND_TRUTH = REPO_ROOT / "place-extraction-pipeline" / "datasets" / "social_ground_truth.json"
DEFAULT_OUTPUT_JSON = REPO_ROOT / "place-extraction-pipeline" / "datasets" / "public_extractor_evaluation.json"
DEFAULT_OUTPUT_MD = REPO_ROOT / "place-extraction-pipeline" / "datasets" / "public_extractor_evaluation.md"


def read_links(paths: list[Path]) -> list[str]:
    links: list[str] = []
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            clean = line.strip()
            if clean and not clean.startswith("#"):
                links.append(clean)
    return links


def normalize_name(value: str | None) -> str:
    value = value or ""
    value = value.replace("’", "'")
    value = re.sub(r"[^a-z0-9]+", " ", value.lower())
    return " ".join(value.split())


def names_match(actual: str | None, expected: str | None) -> bool:
    actual_norm = normalize_name(actual)
    expected_norm = normalize_name(expected)
    if not actual_norm or not expected_norm:
        return False
    if actual_norm == expected_norm:
        return True
    if actual_norm in expected_norm or expected_norm in actual_norm:
        return True
    return len(set(actual_norm.split()) & set(expected_norm.split())) >= 2


def ground_truth_by_url(path: Path) -> dict[str, dict[str, Any]]:
    records = json.loads(path.read_text(encoding="utf-8"))
    return {record["url"]: record for record in records}


def has_meaningful_metadata(candidate: MetadataCandidate) -> bool:
    return bool(
        len(candidate.description.strip()) >= 20
        or len(candidate.title.strip()) >= 12
        or candidate.video_url
        or candidate.image_urls
        or candidate.raw_fields
    )


async def extract_metadata_candidates(url: str, platform: str) -> list[MetadataCandidate]:
    if platform == "instagram":
        return await extract_instagram_metadata(url)
    if platform == "tiktok":
        return await extract_tiktok_metadata(url)
    return []


def summarize_suggestions(suggestions: list[Any]) -> tuple[list[str], int]:
    names: list[str] = []
    for suggestion in suggestions:
        if suggestion.status == "resolved" and suggestion.selected:
            names.append(suggestion.selected.name)
        elif suggestion.status == "brand_or_multiple_locations":
            names.append(suggestion.evidence.name_candidate)
    matched_count = len(names)
    return names, matched_count


def match_ground_truth(found_names: list[str], gt_places: list[dict[str, Any]]) -> int:
    matched_gt = set()
    for found in found_names:
        for index, gt_place in enumerate(gt_places):
            if index in matched_gt:
                continue
            if names_match(found, gt_place.get("name")):
                matched_gt.add(index)
                break
    return len(matched_gt)


async def evaluate_manual_place_name(
    *,
    place_name: str,
    source_url: str,
    platform: str,
) -> dict[str, Any]:
    del source_url, platform
    try:
        result = await search_place(place_name)
    except Exception as exc:
        return {"tested": True, "success": False, "error": str(exc), "candidate_name": None}
    if not result:
        return {"tested": True, "success": False, "candidate_name": None}
    candidate = result[0] if isinstance(result, list) else result
    return {"tested": True, "success": True, "candidate_name": candidate.name}


async def evaluate_link(
    url: str,
    gt_record: dict[str, Any] | None = None,
    *,
    resolve_google: bool = True,
) -> dict[str, Any]:
    platform = detect_platform(url) or "unknown"
    gt_places = (gt_record or {}).get("places", [])
    candidates = await extract_metadata_candidates(url, platform)

    attempts = []
    best_attempt = None
    best_score = (-1, -1, -1)

    for candidate in candidates:
        attempt: dict[str, Any] = {
            "strategy": candidate.source,
            "success": candidate.success,
            "error": candidate.error,
            "metadata": {
                "title": candidate.title,
                "description_length": len(candidate.description or ""),
                "uploader": candidate.uploader,
                "content_type": candidate.content_type,
                "thumbnail_url_present": bool(candidate.thumbnail_url),
                "video_url_present": bool(candidate.video_url),
                "image_url_count": len(candidate.image_urls),
                "meaningful": has_meaningful_metadata(candidate) if candidate.success else False,
            },
            "pipeline": {
                "runtime_record_built": False,
                "slot_count": 0,
                "slot_names": [],
                "suggestion_count": 0,
                "suggestion_names": [],
                "matched_ground_truth_count": 0,
            },
        }

        if candidate.success and has_meaningful_metadata(candidate):
            runtime_record = metadata_candidate_to_runtime_record(candidate, source_url=url)
            slots = extract_place_evidence_from_metadata(runtime_record)
            suggestion_names: list[str] = []
            matched_gt = 0
            if resolve_google and slots:
                try:
                    suggestions = await resolve_place_slots(slots)
                except Exception as exc:
                    attempt["pipeline"]["google_error"] = str(exc)
                    suggestions = []
                suggestion_names, _ = summarize_suggestions(suggestions)
                matched_gt = match_ground_truth(suggestion_names, gt_places)
            attempt["pipeline"] = {
                "runtime_record_built": True,
                "slot_count": len(slots),
                "slot_names": [slot.name_candidate for slot in slots],
                "suggestion_count": len(suggestion_names),
                "suggestion_names": suggestion_names,
                "matched_ground_truth_count": matched_gt,
            }
            score = (matched_gt, len(suggestion_names), len(slots))
            if score > best_score:
                best_score = score
                best_attempt = {
                    "strategy": candidate.source,
                    "slot_count": len(slots),
                    "suggestion_count": len(suggestion_names),
                    "matched_ground_truth_count": matched_gt,
                }

        attempts.append(attempt)

    best_strategy = next((attempt for attempt in attempts if attempt["pipeline"]["matched_ground_truth_count"] == best_score[0]
                          and attempt["pipeline"]["suggestion_count"] == best_score[1]
                          and attempt["pipeline"]["slot_count"] == best_score[2]), None)

    manual_fallbacks = {
        "caption": {"tested": False, "success": False, "slot_count": 0, "suggestion_count": 0},
        "screenshot": {"tested": False, "success": False, "slot_count": 0, "suggestion_count": 0},
        "place_name": {"tested": False, "success": False, "candidate_name": None},
    }
    if gt_places and best_score[0] <= 0:
        if resolve_google:
            manual_fallbacks["place_name"] = await evaluate_manual_place_name(
                place_name=gt_places[0]["name"],
                source_url=url,
                platform=platform,
            )

    if best_score[0] > 0:
        final_status = "success"
    elif any(attempt["success"] for attempt in attempts):
        final_status = "metadata_only"
    else:
        final_status = "no_metadata"

    return {
        "url": url,
        "platform": platform,
        "ground_truth": {
            "expected_places": [place.get("name") for place in gt_places],
            "expected_count": len(gt_places),
        },
        "attempts": attempts,
        "best_attempt": best_attempt or {
            "strategy": None,
            "slot_count": 0,
            "suggestion_count": 0,
            "matched_ground_truth_count": 0,
        },
        "best_attempt_detail": best_strategy,
        "manual_fallbacks": manual_fallbacks,
        "final_status": final_status,
    }


async def evaluate_links(
    urls: list[str],
    ground_truth: dict[str, Any],
    *,
    resolve_google: bool = True,
) -> dict[str, Any]:
    records = []
    for url in urls:
        records.append(await evaluate_link(url, ground_truth.get(url), resolve_google=resolve_google))

    attempts = [attempt for record in records for attempt in record["attempts"]]
    metadata_success_count = sum(1 for record in records if any(attempt["success"] for attempt in record["attempts"]))
    slot_success_count = sum(
        1 for record in records
        if any(attempt["pipeline"]["slot_count"] > 0 for attempt in record["attempts"])
    )
    suggestion_success_count = sum(
        1 for record in records
        if any(attempt["pipeline"]["suggestion_count"] > 0 for attempt in record["attempts"])
    )

    summary = {
        "total_links": len(urls),
        "instagram_links": sum(1 for record in records if record["platform"] == "instagram"),
        "tiktok_links": sum(1 for record in records if record["platform"] == "tiktok"),
        "metadata_success_count": metadata_success_count,
        "slot_success_count": slot_success_count,
        "suggestion_success_count": suggestion_success_count,
        "manual_caption_success_count": 0,
        "manual_screenshot_success_count": 0,
        "manual_place_name_success_count": sum(
            1 for record in records if record["manual_fallbacks"]["place_name"]["success"]
        ),
        "strategy_counts": dict(Counter(attempt["strategy"] for attempt in attempts)),
    }
    return {"summary": summary, "records": records}


def write_report(report: dict[str, Any], *, json_path: Path, md_path: Path) -> None:
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# Public Extractor Evaluation",
        "",
        "## Summary",
        "",
    ]
    for key, value in report["summary"].items():
        lines.append(f"- `{key}`: {value}")

    lines.extend(["", "## Strategy comparison", ""])
    strategies = Counter()
    metadata_success = Counter()
    slot_success = Counter()
    suggestion_success = Counter()
    for record in report["records"]:
        for attempt in record["attempts"]:
            strategy = attempt["strategy"]
            strategies[strategy] += 1
            metadata_success[strategy] += int(attempt["success"])
            slot_success[strategy] += int(attempt["pipeline"]["slot_count"] > 0)
            suggestion_success[strategy] += int(attempt["pipeline"]["suggestion_count"] > 0)

    lines.append("| Strategy | Links Tried | Metadata Success | Slot Success | Suggestion Success |")
    lines.append("|---|---:|---:|---:|---:|")
    for strategy in sorted(strategies):
        lines.append(
            f"| {strategy} | {strategies[strategy]} | {metadata_success[strategy]} | "
            f"{slot_success[strategy]} | {suggestion_success[strategy]} |"
        )

    lines.extend(["", "## Per-link failures", ""])
    for record in report["records"]:
        if record["final_status"] == "success":
            continue
        best = record["best_attempt"]
        failure_reason = next((attempt["error"] for attempt in record["attempts"] if attempt["error"]), "No place slots recovered")
        fallback = "manual_place_name_needed"
        lines.extend([
            f"- `{record['url']}`",
            f"  - Best strategy: `{best['strategy']}`",
            f"  - Failure: {failure_reason}",
            f"  - Recommended fallback: `{fallback}`",
        ])

    md_path.write_text("\n".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=["instagram", "tiktok"])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--urls-file", type=Path, action="append")
    parser.add_argument("--skip-google", action="store_true")
    parser.add_argument("--ground-truth", type=Path, default=DEFAULT_GROUND_TRUTH)
    parser.add_argument("--output-json", type=Path, default=DEFAULT_OUTPUT_JSON)
    parser.add_argument("--output-md", type=Path, default=DEFAULT_OUTPUT_MD)
    return parser.parse_args()


async def main_async() -> None:
    args = parse_args()
    input_paths = args.urls_file or DEFAULT_INPUTS
    urls = read_links(input_paths)
    if args.platform:
        urls = [url for url in urls if detect_platform(url) == args.platform]
    if args.limit:
        urls = urls[: args.limit]

    ground_truth = ground_truth_by_url(args.ground_truth)
    report = await evaluate_links(urls, ground_truth, resolve_google=not args.skip_google)
    write_report(report, json_path=args.output_json, md_path=args.output_md)
    print(args.output_json)
    print(args.output_md)


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
