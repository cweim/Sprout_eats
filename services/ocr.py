import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from PIL import Image
import pytesseract


DEFAULT_VIDEO_OCR_FRAME_INTERVAL_SECONDS = 1.0
DEFAULT_VIDEO_OCR_MAX_FRAMES = 30


def extract_text_from_image(image_path: Path) -> str:
    """Extract OCR text from a single image file."""
    if not image_path or not image_path.exists():
        return ""

    with Image.open(image_path) as image:
        # OCR tends to work better on RGB than palette-based formats.
        rgb_image = image.convert("RGB")
        text = pytesseract.image_to_string(rgb_image)
        return text.strip()


def extract_text_from_images(image_paths: list[Path]) -> str:
    """Extract OCR text from multiple images and combine it."""
    texts = []
    for image_path in image_paths:
        text = extract_text_from_image(image_path)
        if text:
            texts.append(text)
    return "\n\n".join(texts)


def _parse_frame_rate(raw_rate: str) -> float:
    if not raw_rate or raw_rate == "0/0":
        return 0.0
    if "/" in raw_rate:
        numerator, denominator = raw_rate.split("/", 1)
        denominator_value = float(denominator)
        if denominator_value == 0:
            return 0.0
        return float(numerator) / denominator_value
    return float(raw_rate)


def probe_video(video_path: Path) -> dict:
    """Return basic video metadata needed for frame sampling."""
    if not video_path or not video_path.exists():
        return {
            "duration_seconds": 0.0,
            "fps": 0.0,
            "estimated_total_frames": 0,
        }

    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=duration,avg_frame_rate,nb_frames",
        "-of",
        "json",
        str(video_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        return {
            "duration_seconds": 0.0,
            "fps": 0.0,
            "estimated_total_frames": 0,
            "error": completed.stderr.strip(),
        }

    data = json.loads(completed.stdout or "{}")
    streams = data.get("streams") or []
    stream = streams[0] if streams else {}
    duration = float(stream.get("duration") or 0)
    fps = _parse_frame_rate(stream.get("avg_frame_rate") or "")
    nb_frames = int(stream.get("nb_frames") or 0)
    estimated_total_frames = nb_frames or int(duration * fps) if duration and fps else 0

    return {
        "duration_seconds": round(duration, 3),
        "fps": round(fps, 3),
        "estimated_total_frames": estimated_total_frames,
    }


def build_video_ocr_timestamps(
    duration_seconds: float,
    estimated_total_frames: int,
    *,
    frame_interval_seconds: float = DEFAULT_VIDEO_OCR_FRAME_INTERVAL_SECONDS,
    max_frames: int = DEFAULT_VIDEO_OCR_MAX_FRAMES,
) -> list[float]:
    """Build evenly spaced timestamps for bounded OCR frame sampling."""
    if duration_seconds <= 0:
        return []

    del estimated_total_frames  # Kept in the signature because callers report it.
    frame_interval_seconds = max(frame_interval_seconds, 0.25)
    sample_count = max(1, min(int(duration_seconds // frame_interval_seconds) or 1, max_frames))

    if sample_count == 1:
        return [round(duration_seconds / 2, 3)]

    timestamps = []
    timestamp = frame_interval_seconds / 2
    while timestamp < duration_seconds and len(timestamps) < sample_count:
        timestamps.append(round(timestamp, 3))
        timestamp += frame_interval_seconds
    return timestamps


def _extract_video_frame(video_path: Path, timestamp_seconds: float, output_path: Path) -> bool:
    command = [
        "ffmpeg",
        "-y",
        "-ss",
        str(timestamp_seconds),
        "-i",
        str(video_path),
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(output_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    return completed.returncode == 0 and output_path.exists()


def _dedupe_texts(texts: list[str]) -> list[str]:
    seen = set()
    deduped = []
    for text in texts:
        normalized = " ".join(text.lower().split())
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(text)
    return deduped


def extract_text_from_video(
    video_path: Path,
    *,
    frame_interval_seconds: float = DEFAULT_VIDEO_OCR_FRAME_INTERVAL_SECONDS,
    max_frames: int = DEFAULT_VIDEO_OCR_MAX_FRAMES,
) -> dict:
    """
    OCR a bounded, evenly spaced sample of video frames.

    The returned payload records the estimated full frame count, but OCR work is
    capped because running OCR on half of every frame in a reel is usually too slow.
    """
    probe = probe_video(video_path)
    timestamps = build_video_ocr_timestamps(
        probe.get("duration_seconds", 0.0),
        probe.get("estimated_total_frames", 0),
        frame_interval_seconds=frame_interval_seconds,
        max_frames=max_frames,
    )

    payload = {
        **probe,
        "sampling_policy": "one_frame_per_second_capped",
        "frame_interval_seconds": frame_interval_seconds,
        "max_frames": max_frames,
        "target_sampled_frames": len(timestamps),
        "sampled_frames": [],
        "frames_with_text": 0,
        "combined_text": "",
    }

    if not video_path or not video_path.exists() or not timestamps:
        return payload

    temp_dir = Path(tempfile.mkdtemp(prefix="video_ocr_"))
    try:
        frame_texts = []
        for index, timestamp in enumerate(timestamps, start=1):
            frame_path = temp_dir / f"frame_{index:03d}.jpg"
            extracted = _extract_video_frame(video_path, timestamp, frame_path)
            text = extract_text_from_image(frame_path) if extracted else ""
            if text:
                frame_texts.append(text)

            payload["sampled_frames"].append({
                "index": index,
                "timestamp_seconds": timestamp,
                "text": text,
                "text_length": len(text),
            })

        deduped = _dedupe_texts(frame_texts)
        payload["frames_with_text"] = sum(
            1 for frame in payload["sampled_frames"]
            if frame["text"]
        )
        payload["combined_text"] = "\n\n".join(deduped)
        return payload
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
