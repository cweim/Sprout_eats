from __future__ import annotations

import asyncio
import re
from typing import Optional

from services.public_metadata import MetadataCandidate, extract_public_metadata


def extract_instagram_shortcode(url: str) -> Optional[str]:
    match = re.search(r"instagram\.com/(?:reel|p|tv)/([^/?#]+)", url)
    return match.group(1) if match else None


async def extract_instagram_public_html(url: str) -> MetadataCandidate:
    candidate = await extract_public_metadata(url, "instagram")
    candidate.source = "instagram_public_html"
    return candidate


async def extract_instagram_instaloader(shortcode: str) -> MetadataCandidate:
    try:
        import instaloader
    except ImportError as exc:
        return MetadataCandidate(
            source="instagram_instaloader",
            platform="instagram",
            url=f"https://www.instagram.com/p/{shortcode}/",
            success=False,
            error=f"instaloader not installed: {exc}",
        )

    def _extract() -> MetadataCandidate:
        loader = instaloader.Instaloader(
            download_pictures=False,
            download_videos=False,
            download_video_thumbnails=False,
            download_comments=False,
            save_metadata=False,
        )
        post = instaloader.Post.from_shortcode(loader.context, shortcode)
        content_type = "video" if getattr(post, "is_video", False) else "image"
        hashtags = list(getattr(post, "caption_hashtags", []) or [])
        image_urls = []
        if getattr(post, "url", None):
            image_urls.append(str(post.url))
        return MetadataCandidate(
            source="instagram_instaloader",
            platform="instagram",
            url=f"https://www.instagram.com/p/{shortcode}/",
            success=True,
            title="",
            description=getattr(post, "caption", "") or "",
            uploader=getattr(post, "owner_username", None),
            duration=getattr(post, "video_duration", None),
            hashtags=hashtags,
            content_type=content_type,
            thumbnail_url=image_urls[0] if image_urls else None,
            video_url=str(post.video_url) if getattr(post, "is_video", False) and getattr(post, "video_url", None) else None,
            image_urls=image_urls,
            raw_fields={
                "shortcode": shortcode,
                "likes": getattr(post, "likes", None),
                "comments": getattr(post, "comments", None),
            },
        )

    try:
        return await asyncio.to_thread(_extract)
    except Exception as exc:
        return MetadataCandidate(
            source="instagram_instaloader",
            platform="instagram",
            url=f"https://www.instagram.com/p/{shortcode}/",
            success=False,
            error=str(exc),
        )


async def extract_instagram_metadata(url: str) -> list[MetadataCandidate]:
    candidates = [await extract_instagram_public_html(url)]
    shortcode = extract_instagram_shortcode(url)
    if shortcode:
        candidates.append(await extract_instagram_instaloader(shortcode))
    return candidates
