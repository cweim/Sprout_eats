import asyncio
import base64
import binascii
import logging
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import aiohttp
import yt_dlp
from yt_dlp.utils import DownloadError

import config

logger = logging.getLogger(__name__)

DOWNLOAD_TIMEOUT = config.DOWNLOAD_TIMEOUT
INSTAGRAM_ACCESS_ERROR_MARKERS = (
    "login required",
    "requested content is not available",
    "rate-limit reached",
    "rate limit reached",
    "please wait a few minutes",
    "checkpoint required",
    "challenge_required",
)
INSTAGRAM_COOKIEFILE_PATH = config.TEMP_DIR / "instagram_cookies.txt"
INSTAGRAM_MAX_CONCURRENT_FETCHES = max(1, config.INSTAGRAM_MAX_CONCURRENT_FETCHES)
_instagram_fetch_semaphore = asyncio.Semaphore(INSTAGRAM_MAX_CONCURRENT_FETCHES)
_instagram_state_lock = asyncio.Lock()
_instagram_active_jobs = 0
_instagram_waiting_jobs = 0
_instagram_failure_streak = 0
_instagram_cooldown_until = 0.0
_ffmpeg_resolution_logged = False


class DownloadTimeoutError(Exception):
    """Raised when media download takes too long."""


class VideoTooLongError(Exception):
    """Raised when video exceeds max duration."""


class InstagramAccessError(Exception):
    """Raised when Instagram blocks anonymous/authenticated retrieval."""


class InstagramCooldownError(Exception):
    """Raised when Instagram retrieval is temporarily paused after repeated failures."""


def _log_media_tool_resolution_once() -> None:
    global _ffmpeg_resolution_logged
    if _ffmpeg_resolution_logged:
        return

    logger.info(
        "Media tools resolved: ffmpeg=%s ffprobe=%s",
        shutil.which("ffmpeg"),
        shutil.which("ffprobe"),
    )
    _ffmpeg_resolution_logged = True


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


def instagram_request_will_queue() -> bool:
    return _instagram_active_jobs >= INSTAGRAM_MAX_CONCURRENT_FETCHES or _instagram_waiting_jobs > 0


def get_instagram_queue_status() -> tuple[int, int]:
    return _instagram_active_jobs, _instagram_waiting_jobs


def _is_instagram_access_error(error_text: str) -> bool:
    lowered = error_text.lower()
    return any(marker in lowered for marker in INSTAGRAM_ACCESS_ERROR_MARKERS)


def _ensure_instagram_cookiefile() -> Optional[str]:
    if not config.INSTAGRAM_COOKIES_B64:
        return None

    if INSTAGRAM_COOKIEFILE_PATH.exists() and INSTAGRAM_COOKIEFILE_PATH.stat().st_size > 0:
        return str(INSTAGRAM_COOKIEFILE_PATH)

    try:
        cookie_bytes = base64.b64decode(config.INSTAGRAM_COOKIES_B64)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("INSTAGRAM_COOKIES_B64 is not valid base64") from exc

    INSTAGRAM_COOKIEFILE_PATH.write_bytes(cookie_bytes)
    return str(INSTAGRAM_COOKIEFILE_PATH)


def _find_downloaded_video_path(platform: str, url_hash: str) -> Optional[Path]:
    for ext in ["mp4", "webm", "mkv", "mov"]:
        potential_path = Path(config.TEMP_DIR / f"{platform}_{url_hash}.{ext}")
        if potential_path.exists():
            return potential_path

    for file_path in config.TEMP_DIR.glob(f"{platform}_{url_hash}.*"):
        if file_path.suffix.lower() not in {".mp3", ".m4a", ".wav", ".jpg", ".jpeg", ".png", ".webp"}:
            return file_path

    return None


def _is_ffmpeg_postprocess_error(error_text: str) -> bool:
    lowered = error_text.lower()
    return "postprocessing:" in lowered and ("ffprobe" in lowered or "ffmpeg" in lowered)


async def _enter_instagram_fetch_queue() -> None:
    global _instagram_waiting_jobs, _instagram_active_jobs

    async with _instagram_state_lock:
        if _instagram_cooldown_until > time.time():
            remaining = max(1, int(_instagram_cooldown_until - time.time()))
            raise InstagramCooldownError(
                f"Instagram retrieval is cooling down for {remaining} more seconds"
            )
        _instagram_waiting_jobs += 1

    try:
        await _instagram_fetch_semaphore.acquire()
    finally:
        async with _instagram_state_lock:
            _instagram_waiting_jobs = max(0, _instagram_waiting_jobs - 1)
            _instagram_active_jobs += 1


async def _leave_instagram_fetch_queue(success: bool) -> None:
    global _instagram_active_jobs, _instagram_failure_streak, _instagram_cooldown_until

    async with _instagram_state_lock:
        _instagram_active_jobs = max(0, _instagram_active_jobs - 1)
        if success:
            _instagram_failure_streak = 0
        else:
            _instagram_failure_streak += 1
            if _instagram_failure_streak >= 3:
                _instagram_cooldown_until = time.time() + config.INSTAGRAM_COOLDOWN_SECONDS
        _instagram_fetch_semaphore.release()


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

    instagram_success = True
    if platform == "instagram":
        await _enter_instagram_fetch_queue()

    url_hash = str(abs(hash(url)))[:10]
    output_template = str(config.TEMP_DIR / f"{platform}_{url_hash}")
    loop = asyncio.get_event_loop()
    _log_media_tool_resolution_once()

    base_opts = {
        "outtmpl": output_template + ".%(ext)s",
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
    }

    if platform == "instagram":
        cookiefile = _ensure_instagram_cookiefile()
        if cookiefile:
            base_opts["cookiefile"] = cookiefile

    def _extract_metadata():
        with yt_dlp.YoutubeDL(base_opts) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        try:
            async with asyncio.timeout(config.DOWNLOAD_TIMEOUT):
                info = await loop.run_in_executor(None, _extract_metadata)
        except asyncio.TimeoutError:
            raise DownloadTimeoutError(f"Download timed out after {config.DOWNLOAD_TIMEOUT} seconds")
        except DownloadError as exc:
            if platform == "instagram" and _is_instagram_access_error(str(exc)):
                instagram_success = False
                raise InstagramAccessError(str(exc)) from exc
            raise

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
            except DownloadError as exc:
                if platform == "instagram" and _is_instagram_access_error(str(exc)):
                    instagram_success = False
                    raise InstagramAccessError(str(exc)) from exc
                if _is_ffmpeg_postprocess_error(str(exc)):
                    video_path = _find_downloaded_video_path(platform, url_hash)
                    if video_path:
                        logger.warning(
                            "Audio extraction failed after video download; continuing without audio. "
                            "platform=%s url_hash=%s video_path=%s error=%s",
                            platform,
                            url_hash,
                            video_path,
                            exc,
                        )
                        audio_path = None
                    else:
                        logger.error(
                            "Postprocessing failed and no downloaded video was recoverable. "
                            "platform=%s url_hash=%s error=%s",
                            platform,
                            url_hash,
                            exc,
                        )
                        raise
                else:
                    raise
            else:
                audio_path = Path(output_template + ".mp3")

            if not video_path:
                video_path = _find_downloaded_video_path(platform, url_hash)
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
    finally:
        if platform == "instagram":
            await _leave_instagram_fetch_queue(success=instagram_success)


def cleanup_files(*paths: Path):
    for path in paths:
        if path and path.exists():
            path.unlink()
