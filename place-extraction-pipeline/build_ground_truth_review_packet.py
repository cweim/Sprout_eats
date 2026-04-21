#!/usr/bin/env python3
"""Build a compact markdown packet for manual ground-truth review from metadata."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
PIPELINE_DIR = SCRIPT_PATH.parent
DEFAULT_METADATA = PIPELINE_DIR / "metadata_dataset" / "social_metadata_with_media.json"
DEFAULT_OUTPUT = PIPELINE_DIR / "datasets" / "social_ground_truth_review.md"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def clip(text: str | None, limit: int = 900) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def record_id(record: dict[str, Any]) -> str:
    input_data = record.get("input") or {}
    return input_data.get("record_id") or input_data.get("shortcode") or ""


def write_review_packet(records: list[dict[str, Any]], output_path: Path) -> None:
    lines = [
        "# Social Ground Truth Review Packet",
        "",
        "This file summarizes the extracted metadata used to manually determine ground truth for each IG/TikTok link.",
        "",
    ]

    for record in records:
        input_data = record.get("input") or {}
        core = record.get("yt_dlp_core") or {}
        derived = record.get("derived") or {}
        media = record.get("media_evidence") or {}
        ocr = (media.get("ocr") or {}).get("combined") or {}
        video_ocr = media.get("video_ocr") or {}
        video_ocr_combined = (video_ocr.get("combined") or {}).get("text") or video_ocr.get("combined_text") or ""
        transcription = media.get("transcription") or {}

        lines.extend([
            f"## {record_id(record)}",
            "",
            f"- Platform: `{input_data.get('platform')}`",
            f"- URL type: `{input_data.get('url_type')}`",
            f"- URL: {input_data.get('url')}",
            f"- Status: `{record.get('status')}`",
            f"- Content type: `{derived.get('content_type')}`",
            f"- Uploader/channel: `{core.get('channel') or core.get('uploader')}`",
            f"- Duration: `{core.get('duration')}`",
            f"- Location pin lines: {', '.join(derived.get('location_pin_lines') or []) or 'None'}",
            f"- Bracketed names: {', '.join(derived.get('bracketed_names') or []) or 'None'}",
            f"- Address-like snippets: {', '.join(derived.get('address_like_snippets') or []) or 'None'}",
            "",
            "### Title",
            "",
            clip(core.get("title") or "", 1200) or "None",
            "",
            "### Description",
            "",
            clip(core.get("description") or "", 2400) or "None",
            "",
            "### OCR",
            "",
            clip(ocr.get("text") or "", 2000) or "None",
            "",
            "### Video OCR",
            "",
            clip(video_ocr_combined, 2000) or "None",
            "",
            "### Transcript Preferred Text",
            "",
            clip(transcription.get("preferred_text") or "", 2400) or "None",
            "",
            "### Extraction Errors",
            "",
            json.dumps(record.get("errors") or [], ensure_ascii=False),
            "",
        ])

    output_path.write_text("\n".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    records = load_json(args.metadata)
    write_review_packet(records, args.output)
    print(args.output)


if __name__ == "__main__":
    main()
