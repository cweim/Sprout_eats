import asyncio
from dataclasses import dataclass
from pathlib import Path
import re
from typing import Optional
import whisper

import config

# Load model lazily
_model = None

ENGLISH_HINT_WORDS = {
    "a", "about", "also", "and", "are", "as", "at", "be", "but", "by",
    "can", "come", "day", "every", "food", "for", "from", "gem", "go",
    "good", "great", "has", "have", "here", "hidden", "i", "if", "in",
    "is", "it", "its", "like", "love", "me", "near", "not", "of", "on",
    "open", "or", "order", "place", "restaurant", "shop", "so", "that",
    "the", "their", "there", "they", "this", "to", "try", "very", "we",
    "with", "you", "your",
}


@dataclass(frozen=True)
class TranscriptQuality:
    """Lightweight signal for choosing between raw and translated Whisper text."""
    score: float
    label: str
    looks_english: bool
    suspicious_char_ratio: float
    english_hint_ratio: float


@dataclass
class TranscriptionResult:
    """Result of audio transcription with language detection."""
    text: str  # Original transcription in detected language
    language: str  # ISO language code (e.g., "en", "ja", "ko")
    english_text: Optional[str]  # English translation (None if already English)
    preferred_text: Optional[str] = None  # Best text to use for downstream search
    preferred_text_source: str = "transcribe"  # "transcribe" or "translate"
    language_detection_reliable: bool = True
    raw_transcript_quality: str = "unknown"
    translation_quality: Optional[str] = None
    raw_transcript_score: float = 0.0
    translation_score: Optional[float] = None


def _get_model():
    global _model
    if _model is None:
        _model = whisper.load_model(config.WHISPER_MODEL)
    return _model


def preload_model():
    """Pre-load Whisper model into memory. Call at startup."""
    global _model
    if _model is None:
        _model = whisper.load_model(config.WHISPER_MODEL)
    return _model


def is_model_ready() -> bool:
    """Check if Whisper model is loaded and ready."""
    return _model is not None


def evaluate_transcript_quality(text: str) -> TranscriptQuality:
    """
    Score whether a transcript is useful English text.

    Whisper can mis-detect noisy English food reels as another language and return
    a phonetically plausible but unusable raw transcript. This heuristic is not a
    language detector; it is a guardrail for choosing the cleaner text candidate.
    """
    clean = (text or "").strip()
    if not clean:
        return TranscriptQuality(0.0, "empty", False, 1.0, 0.0)

    non_space_chars = [char for char in clean if not char.isspace()]
    char_count = max(len(non_space_chars), 1)
    ascii_letters = sum(char.isascii() and char.isalpha() for char in non_space_chars)
    suspicious_chars = sum(
        not char.isascii() and not char.isdigit()
        for char in non_space_chars
    )
    words = re.findall(r"[A-Za-z][A-Za-z']+", clean.lower())

    latin_ratio = ascii_letters / char_count
    suspicious_char_ratio = suspicious_chars / char_count
    english_hint_ratio = (
        sum(word.strip("'") in ENGLISH_HINT_WORDS for word in words) / len(words)
        if words else 0.0
    )
    word_volume = min(len(words) / 24, 1.0)

    score = (
        latin_ratio * 0.45
        + min(english_hint_ratio * 3.5, 1.0) * 0.4
        + word_volume * 0.15
        - min(suspicious_char_ratio * 2.5, 0.6)
    )
    score = max(0.0, min(score, 1.0))

    if english_hint_ratio < 0.06 and score < 0.62:
        label = "poor"
    elif score >= 0.72:
        label = "good"
    elif score >= 0.52:
        label = "weak"
    else:
        label = "poor"

    looks_english = (
        len(words) >= 5
        and score >= 0.58
        and english_hint_ratio >= 0.12
        and suspicious_char_ratio <= 0.08
    )

    return TranscriptQuality(
        score=round(score, 3),
        label=label,
        looks_english=looks_english,
        suspicious_char_ratio=round(suspicious_char_ratio, 3),
        english_hint_ratio=round(english_hint_ratio, 3),
    )


def _should_translate(raw_quality: TranscriptQuality) -> bool:
    if raw_quality.label in {"empty", "poor"}:
        return True
    if not raw_quality.looks_english:
        return True
    return False


def _build_result(
    *,
    text: str,
    language: str,
    english_text: Optional[str],
    raw_quality: TranscriptQuality,
    translation_quality: Optional[TranscriptQuality],
) -> TranscriptionResult:
    if translation_quality and english_text:
        use_translation = translation_quality.score >= max(raw_quality.score + 0.08, 0.62)
    else:
        use_translation = False

    language_detection_reliable = not (
        language != "en"
        and use_translation
        and raw_quality.label in {"empty", "poor"}
        and translation_quality
        and translation_quality.score >= raw_quality.score + 0.2
    )

    return TranscriptionResult(
        text=text,
        language=language,
        english_text=english_text,
        preferred_text=english_text if use_translation else text,
        preferred_text_source="translate" if use_translation else "transcribe",
        language_detection_reliable=language_detection_reliable,
        raw_transcript_quality=raw_quality.label,
        translation_quality=translation_quality.label if translation_quality else None,
        raw_transcript_score=raw_quality.score,
        translation_score=translation_quality.score if translation_quality else None,
    )


async def transcribe_audio(audio_path: Path) -> TranscriptionResult:
    """
    Transcribe audio file with language detection and optional English translation.

    For non-English audio, performs two-pass transcription:
    1. First pass: transcribe in original language to detect language
    2. Second pass: translate to English for better place search

    Returns:
        TranscriptionResult with text, language, and english_text
    """
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    loop = asyncio.get_event_loop()

    def _transcribe():
        model = _get_model()

        # First pass: transcribe normally, then judge whether the text is usable.
        result = model.transcribe(str(audio_path), task="transcribe")
        text = result["text"].strip()
        language = result.get("language", "en")
        raw_quality = evaluate_transcript_quality(text)

        if not _should_translate(raw_quality):
            return _build_result(
                text=text,
                language=language,
                english_text=text if raw_quality.looks_english else None,
                raw_quality=raw_quality,
                translation_quality=None,
            )

        # Second pass: only translate when the raw pass is non-English or low quality.
        translate_result = model.transcribe(str(audio_path), task="translate")
        english_text = translate_result["text"].strip()
        translation_quality = evaluate_transcript_quality(english_text)

        return _build_result(
            text=text,
            language=language,
            english_text=english_text,
            raw_quality=raw_quality,
            translation_quality=translation_quality,
        )

    return await loop.run_in_executor(None, _transcribe)
