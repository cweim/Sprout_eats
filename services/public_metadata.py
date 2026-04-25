from __future__ import annotations

from dataclasses import dataclass, field
import html
import json
import re
from typing import Any, Optional

import aiohttp


HTML_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


@dataclass
class MetadataCandidate:
    source: str
    platform: str
    url: str
    success: bool
    title: str = ""
    description: str = ""
    uploader: Optional[str] = None
    duration: Optional[int] = None
    hashtags: list[str] = field(default_factory=list)
    content_type: Optional[str] = None
    thumbnail_url: Optional[str] = None
    video_url: Optional[str] = None
    image_urls: list[str] = field(default_factory=list)
    raw_fields: dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


def _extract_meta_tags(raw_html: str) -> dict[str, str]:
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


def _extract_json_ld(raw_html: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    matches = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        raw_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for block in matches:
        text = html.unescape(block).strip()
        if not text:
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            items.append(payload)
        elif isinstance(payload, list):
            items.extend(item for item in payload if isinstance(item, dict))
    return items


def _extract_urls(raw_html: str, patterns: list[str]) -> list[str]:
    urls: list[str] = []
    for pattern in patterns:
        for match in re.findall(pattern, raw_html):
            candidate = match if isinstance(match, str) else match[0]
            candidate = html.unescape(candidate).replace("\\/", "/")
            if candidate not in urls:
                urls.append(candidate)
    return urls


def _extract_hashtags(text: str) -> list[str]:
    seen = set()
    tags = []
    for tag in re.findall(r"#([\w]+)", text or ""):
        if tag not in seen:
            seen.add(tag)
            tags.append(tag)
    return tags


async def fetch_public_html(url: str, *, timeout_seconds: int = 20) -> str:
    timeout = aiohttp.ClientTimeout(total=timeout_seconds)
    async with aiohttp.ClientSession(timeout=timeout, headers=HTML_HEADERS) as session:
        async with session.get(url) as response:
            response.raise_for_status()
            return await response.text()


def extract_basic_meta_from_html(html_text: str, url: str, platform: str) -> MetadataCandidate:
    tags = _extract_meta_tags(html_text)
    json_ld = _extract_json_ld(html_text)

    title = (
        tags.get("og:title")
        or tags.get("twitter:title")
        or tags.get("title")
        or ""
    ).strip()
    description = (
        tags.get("og:description")
        or tags.get("twitter:description")
        or tags.get("description")
        or ""
    ).strip()

    uploader = None
    for key in ("instapp:owner_user_name", "author", "twitter:site"):
        value = tags.get(key)
        if value:
            uploader = value.lstrip("@")
            break

    image_urls = _extract_urls(
        html_text,
        [
            r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']',
            r'<meta\s+name=["\']twitter:image["\']\s+content=["\']([^"\']+)["\']',
            r'"display_url":"(https:[^"]+)"',
            r'"thumbnail_url":"(https:[^"]+)"',
        ],
    )
    video_urls = _extract_urls(
        html_text,
        [
            r'<meta\s+property=["\']og:video["\']\s+content=["\']([^"\']+)["\']',
            r'"contentUrl":"(https:[^"]+)"',
            r'"video_url":"(https:[^"]+)"',
            r'"playAddr":"(https:[^"]+)"',
        ],
    )

    duration = None
    for item in json_ld:
        duration_raw = item.get("duration")
        if isinstance(duration_raw, str):
            iso_match = re.search(r"PT(?:(\d+)M)?(?:(\d+)S)?", duration_raw)
            if iso_match:
                minutes = int(iso_match.group(1) or 0)
                seconds = int(iso_match.group(2) or 0)
                duration = minutes * 60 + seconds
                break

    content_type = None
    if video_urls:
        content_type = "video"
    elif image_urls:
        content_type = "image"

    candidate = MetadataCandidate(
        source="public_html",
        platform=platform,
        url=url,
        success=bool(title or description or image_urls or video_urls),
        title=title,
        description=description,
        uploader=uploader,
        duration=duration,
        hashtags=_extract_hashtags(f"{title}\n{description}"),
        content_type=content_type,
        thumbnail_url=image_urls[0] if image_urls else None,
        video_url=video_urls[0] if video_urls else None,
        image_urls=image_urls,
        raw_fields={
            "meta_tags": tags,
            "json_ld": json_ld,
            "video_urls": video_urls,
        },
    )
    if not candidate.success:
        candidate.error = "No meaningful public metadata found in HTML"
    return candidate


async def extract_public_metadata(url: str, platform: str) -> MetadataCandidate:
    try:
        html_text = await fetch_public_html(url)
        return extract_basic_meta_from_html(html_text, url, platform)
    except Exception as exc:
        return MetadataCandidate(
            source="public_html",
            platform=platform,
            url=url,
            success=False,
            error=str(exc),
        )
