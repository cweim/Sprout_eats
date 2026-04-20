#!/usr/bin/env python3
"""Build a per-link Instagram metadata dataset for pipeline research."""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
import yt_dlp

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from services.downloader import cleanup_files, download_content  # noqa: E402
from services.ocr import extract_text_from_image, extract_text_from_video  # noqa: E402
from services.transcriber import transcribe_audio  # noqa: E402


SCRIPT_PATH = Path(__file__).resolve()
DATASET_DIR = SCRIPT_PATH.parents[1]
PIPELINE_DIR = DATASET_DIR.parent
REPO_ROOT = PIPELINE_DIR.parent
DEFAULT_INPUT = PIPELINE_DIR / "ig_links.md"
DEFAULT_JSON = DATASET_DIR / "instagram_metadata_dataset.json"
DEFAULT_JSONL = DATASET_DIR / "instagram_metadata_dataset.jsonl"
DEFAULT_RAW_DIR = DATASET_DIR / "raw"
DEFAULT_MEDIA_DIR = DATASET_DIR / "media_evidence"

HTML_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

MEDIA_URL_KEYS = {
    "url",
    "manifest_url",
    "fragment_base_url",
}

LARGE_KEYS = {
    "formats",
    "requested_formats",
    "automatic_captions",
    "subtitles",
    "http_headers",
}


def read_links(path: Path) -> list[str]:
    links = []
    for line in path.read_text(encoding="utf-8").splitlines():
        clean = line.strip()
        if clean and not clean.startswith("#"):
            links.append(clean)
    return links


def round_seconds(seconds: float) -> float:
    return round(seconds, 3)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def shortcode_from_url(url: str) -> str:
    match = re.search(r"instagram\.com/(?:reel|p|tv)/([^/?#]+)", url)
    if match:
        return match.group(1)
    parsed = urlparse(url)
    fallback = re.sub(r"[^a-zA-Z0-9_-]+", "_", parsed.path.strip("/"))
    return fallback or str(abs(hash(url)))


def infer_url_type(url: str) -> str:
    if "/reel/" in url:
        return "reel"
    if "/p/" in url:
        return "post"
    if "/tv/" in url:
        return "tv"
    return "unknown"


def is_video_info(info: dict[str, Any]) -> bool:
    ext = (info.get("ext") or "").lower()
    return bool(
        info.get("duration")
        or info.get("vcodec")
        or ext in {"mp4", "webm", "mkv", "mov"}
        or "/reel/" in (info.get("webpage_url") or "")
    )


def detect_content_type(info: dict[str, Any] | None, url: str) -> str:
    if not info:
        return "unknown"

    entries = [entry for entry in (info.get("entries") or []) if isinstance(entry, dict)]
    if entries:
        has_video = any(is_video_info(entry) for entry in entries)
        has_image = any(not is_video_info(entry) for entry in entries)
        if has_video and has_image:
            return "mixed"
        if has_video:
            return "video"
        return "carousel"

    if is_video_info(info):
        return "video"

    webpage_url = info.get("webpage_url") or ""
    if "instagram.com/p/" in url or "instagram.com/p/" in webpage_url:
        return "image_or_carousel"

    return "unknown"


def sanitize_for_raw(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized = {}
        for key, item in value.items():
            if key in MEDIA_URL_KEYS and isinstance(item, str):
                sanitized[key] = {
                    "redacted": True,
                    "length": len(item),
                    "host": urlparse(item).netloc,
                }
            elif key in LARGE_KEYS:
                sanitized[key] = summarize_large_key(key, item)
            else:
                sanitized[key] = sanitize_for_raw(item)
        return sanitized

    if isinstance(value, list):
        return [sanitize_for_raw(item) for item in value[:100]]

    return value


def summarize_large_key(key: str, value: Any) -> Any:
    if key in {"formats", "requested_formats"} and isinstance(value, list):
        return {
            "count": len(value),
            "items": [summarize_format(item) for item in value[:20] if isinstance(item, dict)],
            "truncated": len(value) > 20,
        }

    if isinstance(value, dict):
        return {"keys": sorted(value.keys()), "count": len(value)}

    if isinstance(value, list):
        return {"count": len(value), "truncated": len(value) > 0}

    return value


def summarize_format(fmt: dict[str, Any]) -> dict[str, Any]:
    return {
        "format_id": fmt.get("format_id"),
        "ext": fmt.get("ext"),
        "width": fmt.get("width"),
        "height": fmt.get("height"),
        "resolution": fmt.get("resolution"),
        "format_note": fmt.get("format_note"),
        "vcodec": fmt.get("vcodec"),
        "acodec": fmt.get("acodec"),
        "tbr": fmt.get("tbr"),
        "abr": fmt.get("abr"),
        "vbr": fmt.get("vbr"),
        "url_host": urlparse(fmt.get("url") or "").netloc or None,
    }


def extract_yt_dlp_metadata(url: str) -> dict[str, Any]:
    options = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        return ydl.extract_info(url, download=False)


def fetch_html(url: str, timeout: int = 20) -> tuple[str | None, dict[str, Any]]:
    response = requests.get(url, headers=HTML_HEADERS, timeout=timeout)
    diagnostics = {
        "status_code": response.status_code,
        "final_url": response.url,
        "content_type": response.headers.get("content-type"),
        "content_length": len(response.text),
    }
    response.raise_for_status()
    return response.text, diagnostics


def extract_meta_tags(raw_html: str) -> dict[str, str]:
    tags: dict[str, str] = {}
    pattern = re.compile(r"<meta\s+([^>]+)>", re.IGNORECASE)
    attr_pattern = re.compile(r'([a-zA-Z_:.-]+)\s*=\s*["\']([^"\']*)["\']')

    for match in pattern.finditer(raw_html):
        attrs = dict(attr_pattern.findall(match.group(1)))
        key = attrs.get("property") or attrs.get("name")
        content = attrs.get("content")
        if key and content:
            tags[key] = html.unescape(content)

    return tags


def extract_html_image_urls(raw_html: str) -> list[str]:
    urls: list[str] = []
    patterns = [
        r'"display_url":"(https:[^"]+)"',
        r'"image_versions2":\{"candidates":\[\{"height":\d+,"url":"(https:[^"]+)"',
        r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']',
        r'<meta\s+name=["\']twitter:image["\']\s+content=["\']([^"\']+)["\']',
        r"https:[^\"' ]+(?:cdninstagram|fbcdn)[^\"' ]+",
    ]

    for pattern in patterns:
        for match in re.findall(pattern, raw_html):
            candidate = match if isinstance(match, str) else match[0]
            candidate = html.unescape(candidate)
            candidate = candidate.replace("\\/", "/")
            if candidate not in urls:
                urls.append(candidate)

    return urls


def extract_hashtags(text: str) -> list[str]:
    return unique_preserve_order(re.findall(r"#([\w]+)", text or ""))


def extract_mentions(text: str) -> list[str]:
    return unique_preserve_order(re.findall(r"@([\w.]+)", text or ""))


def extract_location_pin_lines(text: str) -> list[str]:
    lines = []
    for line in (text or "").splitlines():
        if "📍" in line:
            lines.append(line.strip())
    return lines


def extract_bracketed_names(text: str) -> list[str]:
    return unique_preserve_order([
        item.strip()
        for item in re.findall(r"[《【「]([^》】」]+)[》】」]", text or "")
        if item.strip()
    ])


def extract_address_like_snippets(text: str) -> list[str]:
    snippets: list[str] = []
    patterns = [
        r"[^#\n]*(?:Singapore|SG)\s*\d{6}[^#\n]*",
        r"[^#\n]*\d{5}\s+(?:Selangor|Kuala\s*Lumpur|Penang|Johor|Perak)[^#\n]*",
        r"[^#\n]*\b(?:road|rd|street|st|avenue|ave|lane|ln|drive|dr|jalan|jln)\b[^#\n]*",
    ]
    for pattern in patterns:
        for match in re.findall(pattern, text or "", flags=re.IGNORECASE):
            clean = " ".join(match.strip().split())
            if len(clean) > 8 and clean not in snippets:
                snippets.append(clean)
    return snippets[:30]


def unique_preserve_order(items: list[str]) -> list[str]:
    seen = set()
    unique = []
    for item in items:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


def safe_text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def summarize_comments(info: dict[str, Any] | None) -> dict[str, Any]:
    comments = (info or {}).get("comments") or []
    if not isinstance(comments, list):
        return {"available": False, "count": 0, "sample": []}

    sample = []
    for comment in comments[:5]:
        if not isinstance(comment, dict):
            continue
        sample.append({
            "author": comment.get("author"),
            "text": comment.get("text"),
            "timestamp": comment.get("timestamp"),
        })

    return {
        "available": bool(comments),
        "count": len(comments),
        "sample": sample,
    }


def summarize_entries(info: dict[str, Any] | None) -> dict[str, Any]:
    entries = (info or {}).get("entries") or []
    if not isinstance(entries, list):
        return {"count": 0, "items": []}

    items = []
    for entry in entries[:20]:
        if not isinstance(entry, dict):
            continue
        items.append({
            "id": entry.get("id"),
            "title": entry.get("title"),
            "description": entry.get("description"),
            "duration": entry.get("duration"),
            "ext": entry.get("ext"),
            "width": entry.get("width"),
            "height": entry.get("height"),
            "thumbnail": bool(entry.get("thumbnail")),
            "is_video": is_video_info(entry),
        })

    return {
        "count": len(entries),
        "items": items,
        "truncated": len(entries) > 20,
    }


def summarize_media(info: dict[str, Any] | None) -> dict[str, Any]:
    if not info:
        return {}

    formats = info.get("formats") or []
    requested_formats = info.get("requested_formats") or []
    thumbnails = info.get("thumbnails") or []

    return {
        "ext": info.get("ext"),
        "width": info.get("width"),
        "height": info.get("height"),
        "resolution": info.get("resolution"),
        "fps": info.get("fps"),
        "format_id": info.get("format_id"),
        "format": info.get("format"),
        "vcodec": info.get("vcodec"),
        "acodec": info.get("acodec"),
        "filesize": info.get("filesize"),
        "filesize_approx": info.get("filesize_approx"),
        "thumbnail": info.get("thumbnail"),
        "thumbnail_count": len(thumbnails) if isinstance(thumbnails, list) else 0,
        "formats_count": len(formats) if isinstance(formats, list) else 0,
        "requested_formats_count": len(requested_formats) if isinstance(requested_formats, list) else 0,
        "has_audio_only_format": any(
            isinstance(fmt, dict) and fmt.get("vcodec") == "none"
            for fmt in formats
        ),
        "has_video_only_format": any(
            isinstance(fmt, dict) and fmt.get("acodec") == "none"
            for fmt in formats
        ),
    }


def summarize_core(info: dict[str, Any] | None, url: str) -> dict[str, Any]:
    info = info or {}
    return {
        "id": info.get("id"),
        "display_id": info.get("display_id"),
        "webpage_url": info.get("webpage_url"),
        "original_url": info.get("original_url") or url,
        "title": info.get("title"),
        "fulltitle": info.get("fulltitle"),
        "description": info.get("description"),
        "uploader": info.get("uploader"),
        "uploader_id": info.get("uploader_id"),
        "channel": info.get("channel"),
        "duration": info.get("duration"),
        "timestamp": info.get("timestamp"),
        "upload_date": info.get("upload_date"),
        "like_count": info.get("like_count"),
        "comment_count": info.get("comment_count"),
        "tags": info.get("tags") or [],
        "categories": info.get("categories") or [],
        "extractor": info.get("extractor"),
        "extractor_key": info.get("extractor_key"),
        "_type": info.get("_type"),
        "playlist_count": info.get("playlist_count"),
        "available_keys": sorted(info.keys()),
    }


def build_derived(
    url: str,
    info: dict[str, Any] | None,
    meta_tags: dict[str, str],
    html_image_urls: list[str],
) -> dict[str, Any]:
    title = safe_text((info or {}).get("title")) or meta_tags.get("og:title", "")
    description = safe_text((info or {}).get("description")) or meta_tags.get("og:description", "")
    meta_description = meta_tags.get("description", "")
    combined_text = "\n".join(part for part in [title, description, meta_description] if part)

    return {
        "url_type": infer_url_type(url),
        "content_type": detect_content_type(info, url),
        "shortcode": shortcode_from_url(url),
        "caption_length": len(description),
        "title_length": len(title),
        "combined_text_length": len(combined_text),
        "has_caption": bool(description.strip()),
        "hashtags": extract_hashtags(combined_text),
        "mentions": extract_mentions(combined_text),
        "location_pin_lines": extract_location_pin_lines(combined_text),
        "bracketed_names": extract_bracketed_names(combined_text),
        "address_like_snippets": extract_address_like_snippets(combined_text),
        "html_image_url_count": len(html_image_urls),
        "html_image_url_hosts": sorted({urlparse(item).netloc for item in html_image_urls if item}),
    }


def build_availability(
    info: dict[str, Any] | None,
    html_text: str | None,
    html_image_urls: list[str],
) -> dict[str, Any]:
    info = info or {}
    formats = info.get("formats") or []
    entries = info.get("entries") or []
    description = safe_text(info.get("description"))

    return {
        "yt_dlp_metadata": bool(info),
        "html_metadata": bool(html_text),
        "caption": bool(description.strip()),
        "formats": bool(formats),
        "entries": bool(entries),
        "comments": bool(info.get("comments")),
        "html_image_urls": bool(html_image_urls),
        "thumbnail": bool(info.get("thumbnail")),
        "likely_requires_auth_for_full_carousel": (
            info.get("_type") == "playlist"
            and not entries
            and "/p/" in safe_text(info.get("webpage_url") or info.get("original_url"))
        ),
    }


def summarize_text_signal(text: str) -> dict[str, Any]:
    return {
        "text": text,
        "length": len(text),
        "hashtags": extract_hashtags(text),
        "mentions": extract_mentions(text),
        "location_pin_lines": extract_location_pin_lines(text),
        "bracketed_names": extract_bracketed_names(text),
        "address_like_snippets": extract_address_like_snippets(text),
    }


def extract_media_evidence(url: str, media_dir: Path) -> dict[str, Any]:
    """
    Download media and extract OCR/transcription evidence.

    This is intentionally opt-in because it is slower and can download media.
    """
    shortcode = shortcode_from_url(url)
    media_dir.mkdir(parents=True, exist_ok=True)

    result = asyncio.run(download_content(url))
    evidence: dict[str, Any] = {
        "content_type": result.content_type,
        "platform": result.platform,
        "downloaded_video": bool(result.video_path and result.video_path.exists()),
        "downloaded_audio": bool(result.audio_path and result.audio_path.exists()),
        "downloaded_images_count": len(result.image_paths),
        "ocr": {
            "images": [],
            "combined": summarize_text_signal(""),
        },
        "video_ocr": None,
        "transcription": None,
    }

    cleanup_paths = [result.video_path, result.audio_path, *result.image_paths]
    try:
        ocr_texts = []
        for index, image_path in enumerate(result.image_paths, start=1):
            text = extract_text_from_image(image_path)
            if text:
                ocr_texts.append(text)
            evidence["ocr"]["images"].append({
                "index": index,
                "filename": image_path.name,
                "text": text,
                "text_length": len(text),
                "signals": summarize_text_signal(text),
            })

        combined_ocr = "\n\n".join(ocr_texts)
        evidence["ocr"]["combined"] = summarize_text_signal(combined_ocr)

        if result.video_path and result.video_path.exists():
            video_ocr = extract_text_from_video(result.video_path)
            video_ocr["combined"] = summarize_text_signal(video_ocr.get("combined_text") or "")
            evidence["video_ocr"] = video_ocr

        if result.audio_path and result.audio_path.exists():
            transcription = asyncio.run(transcribe_audio(result.audio_path))
            transcript_payload = {
                "language": transcription.language,
                "language_detection_reliable": transcription.language_detection_reliable,
                "text": transcription.text,
                "text_length": len(transcription.text or ""),
                "english_text": transcription.english_text,
                "english_text_length": len(transcription.english_text or ""),
                "preferred_text": transcription.preferred_text,
                "preferred_text_length": len(transcription.preferred_text or ""),
                "preferred_text_source": transcription.preferred_text_source,
                "raw_transcript_quality": transcription.raw_transcript_quality,
                "translation_quality": transcription.translation_quality,
                "raw_transcript_score": transcription.raw_transcript_score,
                "translation_score": transcription.translation_score,
                "text_signals": summarize_text_signal(transcription.text or ""),
                "english_text_signals": summarize_text_signal(transcription.english_text or ""),
                "preferred_text_signals": summarize_text_signal(transcription.preferred_text or ""),
            }
            evidence["transcription"] = transcript_payload

        (media_dir / f"{shortcode}.media_evidence.json").write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return evidence
    finally:
        cleanup_files(*cleanup_paths)


def extract_one(
    url: str,
    raw_dir: Path,
    media_dir: Path,
    include_media_evidence: bool = False,
) -> dict[str, Any]:
    total_start = time.perf_counter()
    shortcode = shortcode_from_url(url)
    errors: list[dict[str, str]] = []
    timings: dict[str, float] = {}
    info: dict[str, Any] | None = None
    html_text: str | None = None
    html_diagnostics: dict[str, Any] = {}
    meta_tags: dict[str, str] = {}
    html_image_urls: list[str] = []
    media_evidence: dict[str, Any] | None = None

    start = time.perf_counter()
    try:
        info = extract_yt_dlp_metadata(url)
        (raw_dir / f"{shortcode}.yt_dlp.json").write_text(
            json.dumps(sanitize_for_raw(info), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001 - research script should keep going per URL.
        errors.append({"stage": "yt_dlp_metadata", "message": str(exc)})
    timings["yt_dlp_metadata_seconds"] = round_seconds(time.perf_counter() - start)

    start = time.perf_counter()
    try:
        html_text, html_diagnostics = fetch_html(url)
        (raw_dir / f"{shortcode}.html").write_text(html_text, encoding="utf-8")
        meta_tags = extract_meta_tags(html_text)
        html_image_urls = extract_html_image_urls(html_text)
    except Exception as exc:  # noqa: BLE001
        errors.append({"stage": "html_metadata", "message": str(exc)})
    timings["html_metadata_seconds"] = round_seconds(time.perf_counter() - start)

    start = time.perf_counter()
    derived = build_derived(url, info, meta_tags, html_image_urls)
    availability = build_availability(info, html_text, html_image_urls)
    timings["derived_processing_seconds"] = round_seconds(time.perf_counter() - start)

    if include_media_evidence:
        start = time.perf_counter()
        try:
            media_evidence = extract_media_evidence(url, media_dir)
        except Exception as exc:  # noqa: BLE001
            errors.append({"stage": "media_evidence", "message": str(exc)})
        timings["media_evidence_seconds"] = round_seconds(time.perf_counter() - start)
    else:
        timings["media_evidence_seconds"] = None

    timings["total_seconds"] = round_seconds(time.perf_counter() - total_start)

    status = "ok"
    if errors and (info or html_text):
        status = "partial"
    elif errors:
        status = "failed"

    return {
        "schema_version": 1,
        "extracted_at": now_iso(),
        "status": status,
        "input": {
            "url": url,
            "shortcode": shortcode,
            "url_type": infer_url_type(url),
        },
        "yt_dlp_core": summarize_core(info, url),
        "yt_dlp_media": summarize_media(info),
        "yt_dlp_social": {
            "comments": summarize_comments(info),
        },
        "yt_dlp_carousel": summarize_entries(info),
        "html_metadata": {
            "diagnostics": html_diagnostics,
            "meta_tags": {
                key: meta_tags.get(key)
                for key in [
                    "description",
                    "og:type",
                    "og:title",
                    "og:description",
                    "og:image",
                    "og:url",
                    "twitter:title",
                    "twitter:image",
                    "twitter:card",
                ]
                if key in meta_tags
            },
            "meta_tag_count": len(meta_tags),
            "image_url_count": len(html_image_urls),
            "image_url_sample": html_image_urls[:10],
        },
        "derived": derived,
        "media_evidence": media_evidence,
        "availability": availability,
        "timings": timings,
        "errors": errors,
    }


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
            handle.write("\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output-json", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--output-jsonl", type=Path, default=DEFAULT_JSONL)
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_DIR)
    parser.add_argument("--media-dir", type=Path, default=DEFAULT_MEDIA_DIR)
    parser.add_argument(
        "--include-media-evidence",
        action="store_true",
        help="Download media and include OCR/transcription evidence. Slower.",
    )
    parser.add_argument("--limit", type=int, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    links = read_links(args.input)
    if args.limit is not None:
        links = links[:args.limit]

    args.raw_dir.mkdir(parents=True, exist_ok=True)
    args.media_dir.mkdir(parents=True, exist_ok=True)
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_jsonl.parent.mkdir(parents=True, exist_ok=True)

    records = []
    for index, url in enumerate(links, start=1):
        print(f"[{index}/{len(links)}] extracting {url}", file=sys.stderr)
        record = extract_one(
            url,
            args.raw_dir,
            args.media_dir,
            include_media_evidence=args.include_media_evidence,
        )
        records.append(record)
        print(
            f"  -> {record['status']} in {record['timings']['total_seconds']}s "
            f"({record['input']['shortcode']})",
            file=sys.stderr,
        )

    args.output_json.write_text(
        json.dumps(records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_jsonl(args.output_jsonl, records)

    ok_count = sum(1 for record in records if record["status"] == "ok")
    partial_count = sum(1 for record in records if record["status"] == "partial")
    failed_count = sum(1 for record in records if record["status"] == "failed")
    print(
        f"wrote {len(records)} records: ok={ok_count}, partial={partial_count}, failed={failed_count}",
        file=sys.stderr,
    )
    print(args.output_json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
