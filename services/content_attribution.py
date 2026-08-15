"""Canonical identity helpers for Instagram/TikTok content attribution."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit


@dataclass(frozen=True)
class CanonicalContent:
    platform: str
    content_id: str | None
    canonical_url: str


def canonicalize_content_url(platform: str | None, url: str) -> CanonicalContent:
    """Collapse tracking variants while preserving a stable platform post ID."""
    clean_platform = (platform or "unknown").strip().lower()
    raw = (url or "").strip()
    if not raw:
        return CanonicalContent(clean_platform, None, "")

    parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
    host = parsed.netloc.lower().removeprefix("www.")
    path = re.sub(r"/{2,}", "/", parsed.path).rstrip("/")

    if clean_platform == "instagram" or "instagram.com" in host:
        clean_platform = "instagram"
        match = re.search(r"/(?:reel|p|tv)/([^/?#]+)", path, re.IGNORECASE)
        if match:
            content_id = match.group(1)
            return CanonicalContent(
                clean_platform,
                content_id,
                f"https://www.instagram.com/reel/{content_id}/",
            )

    if clean_platform == "tiktok" or "tiktok.com" in host:
        clean_platform = "tiktok"
        match = re.search(r"/video/(\d+)", path, re.IGNORECASE)
        if match:
            content_id = match.group(1)
            return CanonicalContent(
                clean_platform,
                content_id,
                f"https://www.tiktok.com/video/{content_id}",
            )

    canonical = urlunsplit((parsed.scheme or "https", host, path or "/", "", ""))
    return CanonicalContent(clean_platform, None, canonical)


def normalize_source_account(value: str | None) -> str | None:
    account = (value or "").strip().lstrip("@").lower()
    return account or None
