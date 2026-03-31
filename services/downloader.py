import re
import asyncio
from pathlib import Path
from dataclasses import dataclass
from typing import Optional
import yt_dlp

import config

# Download timeout in seconds (2 minutes default)
DOWNLOAD_TIMEOUT = 120


class DownloadTimeoutError(Exception):
    """Raised when video download takes too long."""
    pass


@dataclass
class DownloadResult:
    video_path: Path
    audio_path: Path
    title: str
    description: str
    platform: str  # 'instagram' or 'tiktok'


def detect_platform(url: str) -> Optional[str]:
    if "instagram.com" in url or "instagr.am" in url:
        return "instagram"
    elif "tiktok.com" in url or "vm.tiktok.com" in url:
        return "tiktok"
    return None


def is_valid_url(url: str) -> bool:
    return detect_platform(url) is not None


async def download_content(url: str) -> DownloadResult:
    platform = detect_platform(url)
    if not platform:
        raise ValueError("URL must be from Instagram or TikTok")

    # Create unique filename based on URL hash
    url_hash = str(abs(hash(url)))[:10]
    output_template = str(config.TEMP_DIR / f"{platform}_{url_hash}")

    ydl_opts = {
        "format": "best",
        "outtmpl": output_template + ".%(ext)s",
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
        "keepvideo": True,
    }

    loop = asyncio.get_event_loop()

    def _download():
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            return info

    try:
        async with asyncio.timeout(DOWNLOAD_TIMEOUT):
            info = await loop.run_in_executor(None, _download)
    except asyncio.TimeoutError:
        raise DownloadTimeoutError(
            f"Download timed out after {DOWNLOAD_TIMEOUT} seconds"
        )

    # Find the downloaded files
    video_path = None
    audio_path = Path(output_template + ".mp3")

    # Look for video file
    for ext in ["mp4", "webm", "mkv"]:
        potential_path = Path(output_template + f".{ext}")
        if potential_path.exists():
            video_path = potential_path
            break

    if not video_path:
        # Try to find any video file with the pattern
        for f in config.TEMP_DIR.glob(f"{platform}_{url_hash}.*"):
            if f.suffix not in [".mp3", ".m4a", ".wav"]:
                video_path = f
                break

    title = info.get("title", "")
    description = info.get("description", "") or ""

    return DownloadResult(
        video_path=video_path,
        audio_path=audio_path,
        title=title,
        description=description,
        platform=platform,
    )


def cleanup_files(*paths: Path):
    for path in paths:
        if path and path.exists():
            path.unlink()
