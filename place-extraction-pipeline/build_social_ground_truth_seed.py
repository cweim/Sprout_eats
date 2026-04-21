#!/usr/bin/env python3
"""Seed a cross-platform ground-truth file from existing Instagram truth data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
PIPELINE_DIR = SCRIPT_PATH.parent
DEFAULT_METADATA = PIPELINE_DIR / "metadata_dataset" / "social_metadata_with_media.json"
DEFAULT_EXISTING_IG_GT = PIPELINE_DIR / "datasets" / "instagram_ground_truth.json"
DEFAULT_OUTPUT = PIPELINE_DIR / "datasets" / "social_ground_truth_seed.json"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def record_id(record: dict[str, Any]) -> str:
    input_data = record.get("input") or {}
    return input_data.get("record_id") or input_data.get("shortcode") or ""


def make_placeholder(record: dict[str, Any]) -> dict[str, Any]:
    input_data = record.get("input") or {}
    core = record.get("yt_dlp_core") or {}
    derived = record.get("derived") or {}
    return {
        "id": record_id(record),
        "url": input_data.get("url"),
        "platform": input_data.get("platform"),
        "media_type": derived.get("content_type") or input_data.get("url_type"),
        "creator": core.get("channel") or core.get("uploader"),
        "category": None,
        "ground_truth_status": "needs_manual_review",
        "notes": "New record. Review metadata packet and fill places manually.",
        "places": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--instagram-ground-truth", type=Path, default=DEFAULT_EXISTING_IG_GT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    metadata_records = load_json(args.metadata)
    existing_ig = {item["id"]: item for item in load_json(args.instagram_ground_truth)}

    seeded = []
    for record in metadata_records:
        item_id = record_id(record)
        seeded.append(existing_ig.get(item_id) or make_placeholder(record))

    args.output.write_text(json.dumps(seeded, ensure_ascii=False, indent=2), encoding="utf-8")
    print(args.output)


if __name__ == "__main__":
    main()
