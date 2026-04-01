import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
import whisper

import config

# Load model lazily
_model = None


@dataclass
class TranscriptionResult:
    """Result of audio transcription with language detection."""
    text: str  # Original transcription in detected language
    language: str  # ISO language code (e.g., "en", "ja", "ko")
    english_text: Optional[str]  # English translation (None if already English)


def _get_model():
    global _model
    if _model is None:
        _model = whisper.load_model(config.WHISPER_MODEL)
    return _model


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

        # First pass: transcribe in original language
        result = model.transcribe(str(audio_path), task="transcribe")
        text = result["text"].strip()
        language = result.get("language", "en")

        # If English, no translation needed
        if language == "en":
            return TranscriptionResult(
                text=text,
                language=language,
                english_text=text
            )

        # Second pass: translate to English for non-English content
        translate_result = model.transcribe(str(audio_path), task="translate")
        english_text = translate_result["text"].strip()

        return TranscriptionResult(
            text=text,
            language=language,
            english_text=english_text
        )

    return await loop.run_in_executor(None, _transcribe)
