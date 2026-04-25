from __future__ import annotations

from typing import Any

from services.place_pipeline import build_runtime_metadata_record
from services.public_metadata import MetadataCandidate


def metadata_candidate_to_runtime_record(
    candidate: MetadataCandidate,
    *,
    source_url: str,
    ocr_text: str = "",
    video_ocr: dict[str, Any] | None = None,
    transcription: Any = None,
) -> dict[str, Any]:
    record = build_runtime_metadata_record(
        title=candidate.title,
        description=candidate.description,
        source_url=source_url,
        platform=candidate.platform,
        content_type=candidate.content_type or "",
        uploader=candidate.uploader,
        duration=candidate.duration,
        hashtags=candidate.hashtags,
        ocr_text=ocr_text,
        video_ocr=video_ocr,
        transcription=transcription,
    )
    record.setdefault("debug", {})
    record["debug"]["metadata_source"] = candidate.source
    record["debug"]["raw_fields"] = candidate.raw_fields
    record["debug"]["thumbnail_url"] = candidate.thumbnail_url
    record["debug"]["video_url"] = candidate.video_url
    record["debug"]["image_urls"] = candidate.image_urls
    return record
