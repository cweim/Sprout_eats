from __future__ import annotations

import asyncio
import re
from typing import Optional

from services.public_metadata import MetadataCandidate, extract_public_metadata


def extract_tiktok_video_id(url: str) -> Optional[str]:
    match = re.search(r"/video/(\d+)", url)
    return match.group(1) if match else None


async def extract_tiktok_public_html(url: str) -> MetadataCandidate:
    candidate = await extract_public_metadata(url, "tiktok")
    candidate.source = "tiktok_public_html"
    return candidate


async def extract_tiktok_oembed(url: str) -> MetadataCandidate:
    import aiohttp

    endpoint = f"https://www.tiktok.com/oembed?url={url}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(endpoint) as response:
                response.raise_for_status()
                payload = await response.json()
    except Exception as exc:
        return MetadataCandidate(
            source="tiktok_oembed",
            platform="tiktok",
            url=url,
            success=False,
            error=str(exc),
        )

    description = str(payload.get("title") or "")
    thumbnail_url = payload.get("thumbnail_url")
    return MetadataCandidate(
        source="tiktok_oembed",
        platform="tiktok",
        url=url,
        success=bool(description or thumbnail_url),
        title=description,
        description=description,
        uploader=payload.get("author_name"),
        thumbnail_url=thumbnail_url,
        image_urls=[thumbnail_url] if thumbnail_url else [],
        raw_fields=payload,
    )


async def extract_tiktok_api(url: str) -> MetadataCandidate:
    try:
        from TikTokApi import TikTokApi
    except ImportError as exc:
        return MetadataCandidate(
            source="tiktok_api",
            platform="tiktok",
            url=url,
            success=False,
            error=f"TikTokApi not installed: {exc}",
        )

    async def _extract() -> MetadataCandidate:
        async with TikTokApi() as api:
            video = api.video(url=url)
            data = await video.info()
        item = data.get("itemInfo", {}).get("itemStruct", {})
        author = data.get("itemInfo", {}).get("author", {}) or data.get("author", {}) or {}
        desc = item.get("desc") or ""
        cover = item.get("video", {}).get("cover")
        play = item.get("video", {}).get("playAddr")
        return MetadataCandidate(
            source="tiktok_api",
            platform="tiktok",
            url=url,
            success=bool(desc or cover or play),
            title=desc[:150],
            description=desc,
            uploader=author.get("uniqueId") or author.get("nickname"),
            duration=item.get("video", {}).get("duration"),
            hashtags=[challenge.get("title") for challenge in item.get("challenges", []) if challenge.get("title")],
            content_type="video",
            thumbnail_url=cover,
            video_url=play,
            image_urls=[cover] if cover else [],
            raw_fields=item,
        )

    try:
        return await _extract()
    except Exception as exc:
        return MetadataCandidate(
            source="tiktok_api",
            platform="tiktok",
            url=url,
            success=False,
            error=str(exc),
        )


async def extract_tiktok_ytdlp(url: str) -> MetadataCandidate:
    try:
        import yt_dlp
    except ImportError as exc:
        return MetadataCandidate(
            source="tiktok_ytdlp_no_cookies",
            platform="tiktok",
            url=url,
            success=False,
            error=f"yt_dlp not installed: {exc}",
        )

    def _extract() -> MetadataCandidate:
        options = {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": False,
            "skip_download": True,
        }
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
        thumbs = info.get("thumbnails") or []
        thumb = next((item.get("url") for item in thumbs if item.get("url")), info.get("thumbnail"))
        return MetadataCandidate(
            source="tiktok_ytdlp_no_cookies",
            platform="tiktok",
            url=url,
            success=True,
            title=info.get("title") or "",
            description=info.get("description") or "",
            uploader=info.get("uploader") or info.get("uploader_id"),
            duration=info.get("duration"),
            hashtags=info.get("tags", []) or [],
            content_type="video",
            thumbnail_url=thumb,
            video_url=info.get("url"),
            image_urls=[thumb] if thumb else [],
            raw_fields={
                "id": info.get("id"),
                "webpage_url": info.get("webpage_url"),
            },
        )

    try:
        return await asyncio.to_thread(_extract)
    except Exception as exc:
        return MetadataCandidate(
            source="tiktok_ytdlp_no_cookies",
            platform="tiktok",
            url=url,
            success=False,
            error=str(exc),
        )


async def extract_tiktok_metadata(url: str) -> list[MetadataCandidate]:
    return [
        await extract_tiktok_public_html(url),
        await extract_tiktok_oembed(url),
        await extract_tiktok_api(url),
        await extract_tiktok_ytdlp(url),
    ]
