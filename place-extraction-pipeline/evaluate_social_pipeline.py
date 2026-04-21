#!/usr/bin/env python3
"""Evaluate the current bot-like slot pipeline against a cross-platform ground-truth dataset."""

from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from pathlib import Path
import re
import sys
from typing import Any
import unicodedata

SCRIPT_PATH = Path(__file__).resolve()
PIPELINE_DIR = SCRIPT_PATH.parent
REPO_ROOT = PIPELINE_DIR.parent
sys.path.insert(0, str(REPO_ROOT))

from services.place_pipeline import (  # noqa: E402
    run_bot_like_slot_pipeline_for_metadata,
    suggestions_to_dict,
)


DEFAULT_METADATA = PIPELINE_DIR / "metadata_dataset" / "social_metadata_with_media.json"
DEFAULT_GROUND_TRUTH = PIPELINE_DIR / "datasets" / "social_ground_truth.json"
DEFAULT_OUTPUT_JSON = PIPELINE_DIR / "datasets" / "social_pipeline_evaluation.json"
DEFAULT_OUTPUT_MD = PIPELINE_DIR / "datasets" / "social_pipeline_evaluation.md"


def normalize_name(value: str | None) -> str:
    value = value or ""
    value = value.replace("’", "'")
    value = "".join(
        char for char in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(char)
    )
    value = re.sub(r"[^a-z0-9]+", " ", value.lower())
    return " ".join(value.split())


def meaningful_tokens(value: str | None) -> set[str]:
    stop = {
        "restaurant", "cafe", "coffee", "food", "street", "st", "road", "rd",
        "singapore", "malaysia", "kuala", "lumpur", "famous", "the", "and",
        "at", "by", "ion", "orchard", "amoy", "petaling", "jaya", "kl",
    }
    return {
        token for token in normalize_name(value).split()
        if len(token) > 2 and token not in stop
    }


def names_match(actual: str | None, expected: str | None) -> bool:
    actual_norm = normalize_name(actual)
    expected_norm = normalize_name(expected)
    if not actual_norm or not expected_norm:
        return False
    if actual_norm == expected_norm:
        return True
    if actual_norm in expected_norm or expected_norm in actual_norm:
        return True
    actual_compact = actual_norm.replace(" ", "")
    expected_compact = expected_norm.replace(" ", "")
    if actual_compact and (
        actual_compact in expected_compact or expected_compact in actual_compact
    ):
        return True
    actual_tokens = meaningful_tokens(actual_norm)
    expected_tokens = meaningful_tokens(expected_norm)
    if not actual_tokens or not expected_tokens:
        return False
    overlap = actual_tokens & expected_tokens
    required = 1 if min(len(actual_tokens), len(expected_tokens)) == 1 else 2
    return len(overlap) >= required


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def record_id(record: dict[str, Any]) -> str:
    input_data = record.get("input") or {}
    return (
        input_data.get("record_id")
        or input_data.get("shortcode")
        or record.get("id")
        or ""
    )


def ground_truth_by_id(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {record["id"]: record for record in records}


def compare_slots_to_ground_truth(slots: list[dict[str, Any]], gt_places: list[dict[str, Any]]) -> dict[str, Any]:
    matched_gt = set()
    matched_slots = set()

    for slot_index, slot in enumerate(slots):
        for gt_index, gt_place in enumerate(gt_places):
            if gt_index in matched_gt:
                continue
            if names_match(slot["name_candidate"], gt_place.get("name")):
                matched_gt.add(gt_index)
                matched_slots.add(slot_index)
                break

    return {
        "expected_count": len(gt_places),
        "slot_count": len(slots),
        "matched_count": len(matched_gt),
        "missing_gt": [
            gt_places[index].get("name")
            for index in range(len(gt_places))
            if index not in matched_gt
        ],
        "extra_slots": [
            slots[index]["name_candidate"]
            for index in range(len(slots))
            if index not in matched_slots
        ],
        "exact_count": len(gt_places) == len(slots),
    }


def compare_suggestions_to_ground_truth(suggestions: list[dict[str, Any]], gt_places: list[dict[str, Any]]) -> dict[str, Any]:
    selected = []
    unresolved_slots = []
    brand_slots = []

    for suggestion in suggestions:
        evidence = suggestion["evidence"]
        if suggestion["status"] == "brand_or_multiple_locations":
            brand_slots.append(evidence["name_candidate"])
            selected.append({"name": evidence["name_candidate"], "status": suggestion["status"]})
        elif suggestion.get("selected"):
            selected.append({"name": suggestion["selected"]["name"], "status": suggestion["status"]})
        else:
            unresolved_slots.append(evidence["name_candidate"])

    matched_gt = set()
    matched_selected = set()
    for selected_index, item in enumerate(selected):
        for gt_index, gt_place in enumerate(gt_places):
            if gt_index in matched_gt:
                continue
            if names_match(item["name"], gt_place.get("name")):
                matched_gt.add(gt_index)
                matched_selected.add(selected_index)
                break

    return {
        "expected_count": len(gt_places),
        "suggested_count": len(selected),
        "matched_count": len(matched_gt),
        "missing_gt": [
            gt_places[index].get("name")
            for index in range(len(gt_places))
            if index not in matched_gt
        ],
        "extra_suggestions": [
            selected[index]["name"]
            for index in range(len(selected))
            if index not in matched_selected
        ],
        "unresolved_slots": unresolved_slots,
        "brand_or_multiple_location_slots": brand_slots,
        "exact_count": len(gt_places) == len(selected),
    }


async def evaluate(
    metadata_path: Path,
    ground_truth_path: Path,
) -> dict[str, Any]:
    metadata_records = load_json(metadata_path)
    gt_records = ground_truth_by_id(load_json(ground_truth_path))

    evaluations = []
    total_expected = 0
    total_slots = 0
    total_slot_matches = 0
    total_suggested = 0
    total_suggestion_matches = 0
    records_with_exact_slot_count = 0
    records_with_exact_suggestion_count = 0

    for record in metadata_records:
        item_id = record_id(record)
        gt_record = gt_records.get(item_id, {})
        gt_places = gt_record.get("places", [])

        slots, suggestions, checked_sources = await run_bot_like_slot_pipeline_for_metadata(record)
        slot_dicts = [asdict(slot) | {"query": slot.query} for slot in slots]
        suggestion_dicts = suggestions_to_dict(suggestions)

        slot_comparison = compare_slots_to_ground_truth(slot_dicts, gt_places)
        suggestion_comparison = compare_suggestions_to_ground_truth(suggestion_dicts, gt_places)

        total_expected += len(gt_places)
        total_slots += len(slot_dicts)
        total_slot_matches += slot_comparison["matched_count"]
        records_with_exact_slot_count += int(slot_comparison["exact_count"])
        total_suggested += suggestion_comparison["suggested_count"]
        total_suggestion_matches += suggestion_comparison["matched_count"]
        records_with_exact_suggestion_count += int(suggestion_comparison["exact_count"])

        evaluations.append({
            "id": item_id,
            "platform": ((record.get("input") or {}).get("platform") or ""),
            "url": (record.get("input") or {}).get("url"),
            "ground_truth_status": gt_record.get("ground_truth_status"),
            "ground_truth_places": gt_places,
            "checked_sources": checked_sources,
            "slots": slot_dicts,
            "slot_comparison": slot_comparison,
            "suggestions": suggestion_dicts,
            "suggestion_comparison": suggestion_comparison,
        })

    summary = {
        "records": len(metadata_records),
        "total_expected_places": total_expected,
        "total_extracted_slots": total_slots,
        "total_slot_matches": total_slot_matches,
        "slot_precision": round(total_slot_matches / total_slots, 3) if total_slots else None,
        "slot_recall": round(total_slot_matches / total_expected, 3) if total_expected else None,
        "records_with_exact_slot_count": records_with_exact_slot_count,
        "total_suggested_places": total_suggested,
        "total_suggestion_matches": total_suggestion_matches,
        "suggestion_precision": (
            round(total_suggestion_matches / total_suggested, 3)
            if total_suggested else None
        ),
        "suggestion_recall": (
            round(total_suggestion_matches / total_expected, 3)
            if total_expected else None
        ),
        "records_with_exact_suggestion_count": records_with_exact_suggestion_count,
    }

    return {"summary": summary, "records": evaluations}


def write_markdown_report(result: dict[str, Any], path: Path) -> None:
    lines = [
        "# Social Slot Pipeline Evaluation",
        "",
        "This report evaluates the current bot-like slot extraction strategy against the cross-platform ground-truth dataset.",
        "",
        "## Summary",
        "",
    ]
    for key, value in result["summary"].items():
        lines.append(f"- `{key}`: {value}")

    lines.extend(["", "## Records", ""])
    for record in result["records"]:
        slot_cmp = record["slot_comparison"]
        suggestion_cmp = record["suggestion_comparison"]
        lines.extend([
            f"### {record['id']}",
            "",
            f"- Platform: `{record['platform']}`",
            f"- Ground truth status: `{record.get('ground_truth_status')}`",
            f"- Checked sources: {', '.join(record.get('checked_sources') or []) or 'None'}",
            f"- Expected places: {slot_cmp['expected_count']}",
            f"- Extracted slots: {slot_cmp['slot_count']}",
            f"- Slot matches: {slot_cmp['matched_count']}",
            f"- Missing GT from slots: {', '.join(slot_cmp['missing_gt']) or 'None'}",
            f"- Extra slots: {', '.join(slot_cmp['extra_slots']) or 'None'}",
            f"- Suggested places: {suggestion_cmp['suggested_count']}",
            f"- Suggestion matches: {suggestion_cmp['matched_count']}",
            f"- Missing GT from suggestions: {', '.join(suggestion_cmp['missing_gt']) or 'None'}",
            f"- Extra suggestions: {', '.join(suggestion_cmp['extra_suggestions']) or 'None'}",
            f"- Unresolved slots: {', '.join(suggestion_cmp['unresolved_slots']) or 'None'}",
            f"- Multiple-location slots: {', '.join(suggestion_cmp['brand_or_multiple_location_slots']) or 'None'}",
            "",
            "Extracted slots:",
            "",
        ])

        if record["slots"]:
            for slot in record["slots"]:
                lines.append(
                    f"- `{slot['source']}`: {slot['name_candidate']} | "
                    f"address={slot.get('address_candidate')} | query={slot['query']}"
                )
        else:
            lines.append("- None")

        if record["suggestions"]:
            lines.extend(["", "Suggestions:", ""])
            for suggestion in record["suggestions"]:
                selected = suggestion.get("selected")
                evidence = suggestion["evidence"]
                if selected:
                    lines.append(
                        f"- {evidence['name_candidate']} -> {selected['name']} "
                        f"({suggestion['status']}, {selected.get('confidence_label')})"
                    )
                else:
                    lines.append(
                        f"- {evidence['name_candidate']} -> {suggestion['status']} "
                        f"({suggestion.get('reason')})"
                    )

        lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--ground-truth", type=Path, default=DEFAULT_GROUND_TRUTH)
    parser.add_argument("--output-json", type=Path, default=DEFAULT_OUTPUT_JSON)
    parser.add_argument("--output-md", type=Path, default=DEFAULT_OUTPUT_MD)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    import asyncio

    result = asyncio.run(evaluate(args.metadata, args.ground_truth))
    args.output_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown_report(result, args.output_md)
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))
    print(args.output_json)
    print(args.output_md)


if __name__ == "__main__":
    main()
