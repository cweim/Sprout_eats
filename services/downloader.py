import asyncio
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import aiohttp
import yt_dlp

import config


DOWNLOAD_TIMEOUT = config.DOWNLOAD_TIMEOUT


class DownloadTimeoutError(Exception):
    """Raised when media download takes too long."""


class VideoTooLongError(Exception):
    """Raised when video exceeds max duration."""


@dataclass
class DownloadResult:
    video_path: Optional[Path]
    audio_path: Optional[Path]
    title: str
    description: str
    platform: str  # 'instagram' or 'tiktok'
    content_type: str = "video"  # video, image, carousel, mixed
    image_paths: list[Path] = field(default_factory=list)
    uploader: Optional[str] = None
    duration: Optional[int] = None
    hashtags: list[str] = field(default_factory=list)


def detect_platform(url: str) -> Optional[str]:
    if "instagram.com" in url or "instagr.am" in url:
        return "instagram"
    if "tiktok.com" in url or "vm.tiktok.com" in url:
        return "tiktok"
    return None


def is_valid_url(url: str) -> bool:
    return detect_platform(url) is not None


def _is_video_info(info: dict) -> bool:
    ext = (info.get("ext") or "").lower()
    return bool(
        info.get("duration")
        or info.get("vcodec")
        or ext in {"mp4", "webm", "mkv", "mov"}
        or "/reel/" in (info.get("webpage_url") or "")
    )


def _detect_content_type(info: dict, url: str) -> str:
    entries = [entry for entry in (info.get("entries") or []) if entry]
    if entries:
        has_video = any(_is_video_info(entry) for entry in entries)
        has_image = any(not _is_video_info(entry) for entry in entries)
        if has_video and has_image:
            return "mixed"
        if has_video:
            return "video"
        return "carousel"

    if _is_video_info(info):
        return "video"

    if "instagram.com/p/" in url or "instagram.com/p/" in (info.get("webpage_url") or ""):
        return "image"

    return "image"


def _collect_image_urls_from_info(info: dict) -> list[str]:
    urls: list[str] = []

    def add(url: Optional[str]) -> None:
        if url and url not in urls:
            urls.append(url)

    entries = [entry for entry in (info.get("entries") or []) if entry]
    for entry in entries:
        ext = (entry.get("ext") or "").lower()
        if ext in {"jpg", "jpeg", "png", "webp"}:
            add(entry.get("url"))
            add(entry.get("thumbnail"))
        elif not _is_video_info(entry):
            add(entry.get("url"))
            add(entry.get("thumbnail"))

    ext = (info.get("ext") or "").lower()
    if ext in {"jpg", "jpeg", "png", "webp"}:
        add(info.get("url"))
    add(info.get("thumbnail"))

    for thumb in info.get("thumbnails") or []:
        add(thumb.get("url"))

    return urls


async def _extract_instagram_image_urls_from_html(url: str) -> list[str]:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
    }
    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        async with session.get(url) as response:
            html = await response.text()

    urls: list[str] = []
    patterns = [
        r'"display_url":"(https:[^"]+)"',
        r'"image_versions2":\{"candidates":\[\{"height":\d+,"url":"(https:[^"]+)"',
        r'<meta property="og:image" content="([^"]+)"',
    ]
    for pattern in patterns:
        for match in re.findall(pattern, html):
            candidate = match.encode("utf-8").decode("unicode_escape").replace("\\/", "/")
            if candidate not in urls:
                urls.append(candidate)

    return urls


async def _download_images(image_urls: list[str], output_prefix: str) -> list[Path]:
    image_paths: list[Path] = []
    timeout = aiohttp.ClientTimeout(total=30)
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
    }
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        for index, image_url in enumerate(image_urls, start=1):
            parsed = urlparse(image_url)
            suffix = Path(parsed.path).suffix.lower() or ".jpg"
            if suffix not in {".jpg", ".jpeg", ".png", ".webp"}:
                suffix = ".jpg"

            image_path = Path(f"{output_prefix}_img_{index}{suffix}")
            try:
                async with session.get(image_url) as response:
                    if response.status != 200:
                        continue
                    image_path.write_bytes(await response.read())
                    image_paths.append(image_path)
            except Exception:
                continue

    return image_paths


async def download_content(url: str) -> DownloadResult:
    platform = detect_platform(url)
    if not platform:
        raise ValueError("URL must be from Instagram or TikTok")

    url_hash = str(abs(hash(url)))[:10]
    output_template = str(config.TEMP_DIR / f"{platform}_{url_hash}")
    loop = asyncio.get_event_loop()

    base_opts = {
        "outtmpl": output_template + ".%(ext)s",
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
    }

    def _extract_metadata():
        with yt_dlp.YoutubeDL(base_opts) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        async with asyncio.timeout(config.DOWNLOAD_TIMEOUT):
            info = await loop.run_in_executor(None, _extract_metadata)
    except asyncio.TimeoutError:
        raise DownloadTimeoutError(f"Download timed out after {config.DOWNLOAD_TIMEOUT} seconds")

    # Check video duration limit
    duration = info.get("duration")
    if duration and duration > config.MAX_VIDEO_DURATION:
        raise VideoTooLongError(
            f"Video is {duration}s, max allowed is {config.MAX_VIDEO_DURATION}s"
        )

    content_type = _detect_content_type(info, url)
    video_path: Optional[Path] = None
    audio_path: Optional[Path] = None
    image_paths: list[Path] = []

    if content_type == "video":
        ydl_opts = {
            **base_opts,
            "format": "best",
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }
            ],
            "keepvideo": True,
        }

        def _download_video():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(url, download=True)

        try:
            async with asyncio.timeout(config.DOWNLOAD_TIMEOUT):
                info = await loop.run_in_executor(None, _download_video)
        except asyncio.TimeoutError:
            raise DownloadTimeoutError(f"Download timed out after {config.DOWNLOAD_TIMEOUT} seconds")

        audio_path = Path(output_template + ".mp3")

        for ext in ["mp4", "webm", "mkv"]:
            potential_path = Path(output_template + f".{ext}")
            if potential_path.exists():
                video_path = potential_path
                break

        if not video_path:
            for file_path in config.TEMP_DIR.glob(f"{platform}_{url_hash}.*"):
                if file_path.suffix not in [".mp3", ".m4a", ".wav"]:
                    video_path = file_path
                    break
    else:
        image_urls = _collect_image_urls_from_info(info)
        if not image_urls and platform == "instagram":
            image_urls = await _extract_instagram_image_urls_from_html(url)
        image_paths = await _download_images(image_urls[:20], output_template)

    title = info.get("title", "")
    description = info.get("description", "") or ""
    uploader = info.get("uploader") or info.get("uploader_id")
    duration = info.get("duration")
    hashtags = info.get("tags", []) or []

    return DownloadResult(
        video_path=video_path,
        audio_path=audio_path,
        title=title,
        description=description,
        platform=platform,
        content_type=content_type,
        image_paths=image_paths,
        uploader=uploader,
        duration=duration,
        hashtags=hashtags,
    )


def cleanup_files(*paths: Path):
    for path in paths:
        if path and path.exists():
            path.unlink()
