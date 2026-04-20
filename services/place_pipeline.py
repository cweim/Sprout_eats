import asyncio
from dataclasses import asdict, dataclass, field
import re
from typing import Any, Optional

from services.places import (
    PlaceResult,
    assess_candidate,
    infer_location_context,
    search_place,
    tokenize_meaningful_words,
)


PIN_MARKERS = ("📍", "📌")
ADDRESS_HINT_RE = re.compile(
    r"("
    r"(?:Singapore|SG)\s*\d{6}"
    r"|\b\d{6}\b"
    r"|\b\d{5}\b.*(?:Malaysia|Selangor|Kuala\s*Lumpur|Petaling\s*Jaya|Ampang)"
    r"|\b(?:road|rd|street|st|jalan|jln|lane|ln|drive|dr|bukit|plaza)\b"
    r")",
    re.IGNORECASE,
)
LOCATION_ONLY_CUE_RE = re.compile(
    r"\b("
    r"level|lvl|floor|flr|next\s+to|near|opposite|beside|inside|within|"
    r"mall|shopping\s+centre|shopping\s+center|city|plaza"
    r")\b",
    re.IGNORECASE,
)
PRICE_RE = re.compile(r"(?:[$€£]\s*\d+|\bRM\s*\d+|\(\s*RM|\$\d+)", re.IGNORECASE)
HASHTAG_RE = re.compile(r"#[A-Za-z_]\w*")
MENTION_RE = re.compile(r"@([\w.]+)")

NON_PLACE_LINE_PREFIXES = (
    "opening hours",
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
    "sun",
    "daily",
    "price",
    "what you should order",
)

CREATOR_CONTEXT_WORDS = {
    "follow",
    "chef",
    "presenter",
    "creator",
    "voiceover",
    "actor",
}


@dataclass
class PlaceEvidence:
    """A source-backed place slot extracted before calling Google Places."""

    slot_id: str
    source: str
    raw_text: str
    name_candidate: str
    address_candidate: Optional[str] = None
    area_candidate: Optional[str] = None
    expected: bool = True
    should_resolve: bool = True
    confidence: str = "medium"
    notes: list[str] = field(default_factory=list)

    @property
    def query(self) -> str:
        parts = [self.name_candidate]
        if self.address_candidate and self.address_candidate.lower() != "multiple locations":
            parts.append(self.address_candidate)
        elif self.area_candidate:
            parts.append(self.area_candidate)
        return ", ".join(part for part in parts if part)


@dataclass
class PlaceSlotSuggestion:
    """Google Places resolution result for one evidence slot."""

    evidence: PlaceEvidence
    status: str
    candidates: list[PlaceResult] = field(default_factory=list)
    selected: Optional[PlaceResult] = None
    reason: Optional[str] = None


def clean_text(value: str) -> str:
    value = HASHTAG_RE.sub("", value or "")
    value = re.sub(r"\s+", " ", value)
    return value.strip(" \t\r\n-|")


def strip_leading_marker(line: str) -> tuple[Optional[str], str]:
    for marker in PIN_MARKERS:
        if marker in line:
            return marker, line.split(marker, 1)[1].strip()
    return None, line.strip()


def normalize_handle(handle: str) -> str:
    return re.sub(r"[._]+", " ", handle).strip()


def handle_tokens(handle: str) -> set[str]:
    return set(tokenize_meaningful_words(normalize_handle(handle)))


def compact_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def has_address_hint(text: str) -> bool:
    return bool(ADDRESS_HINT_RE.search(text or ""))


def is_multiple_locations(text: str) -> bool:
    return "multiple locations" in (text or "").lower()


def is_likely_non_place_line(line: str) -> bool:
    clean = clean_text(line).lower()
    if not clean:
        return True
    if clean.startswith(NON_PLACE_LINE_PREFIXES):
        return True
    if PRICE_RE.search(clean):
        return True
    return False


def split_name_and_inline_address(text: str) -> tuple[str, Optional[str]]:
    """Split a source line into probable venue name and address portion."""
    text = clean_text(text)
    if not text:
        return "", None

    if is_multiple_locations(text):
        return clean_text(re.sub(r"multiple locations", "", text, flags=re.IGNORECASE)), "Multiple locations"

    paren_match = re.search(r"\(([^)]*)\)", text)
    if paren_match:
        paren_text = clean_text(paren_match.group(1))
        if has_address_hint(paren_text):
            address = paren_text
            name = clean_text(text[:paren_match.start()] + text[paren_match.end():])
            return name, address

    comma_parts = [part.strip() for part in text.split(",")]
    for index, part in enumerate(comma_parts):
        if index == 0:
            continue
        tail = ", ".join(comma_parts[index:]).strip()
        if has_address_hint(tail):
            return clean_text(", ".join(comma_parts[:index])), clean_text(tail)

    return text, None


def next_meaningful_line(lines: list[str], start_index: int) -> Optional[str]:
    for index in range(start_index + 1, len(lines)):
        line = clean_text(lines[index])
        if line:
            return line
    return None


def previous_meaningful_line(lines: list[str], start_index: int) -> Optional[str]:
    for index in range(start_index - 1, -1, -1):
        line = clean_text(lines[index])
        if line:
            return line
    return None


def strip_non_address_parentheticals(text: str) -> str:
    """Remove descriptive parentheticals while keeping branch/address hints."""
    def replace(match: re.Match) -> str:
        inner = clean_text(match.group(1))
        if has_address_hint(inner) or re.search(r"\b(?:ion|raffles|orchard|amoy|pudu|pj|kl)\b", inner, re.IGNORECASE):
            return f" ({inner})"
        return ""

    return clean_text(re.sub(r"\(([^)]*)\)", replace, text))


def is_location_only_pin_text(text: str) -> bool:
    """Return True when a pin line is wayfinding/address context, not venue name."""
    normalized = clean_text(text).lower()
    if not normalized:
        return False
    if is_address_only_name(normalized):
        return True
    if LOCATION_ONLY_CUE_RE.search(normalized):
        return True
    return False


def is_previous_line_venue_candidate(line: str) -> bool:
    clean = clean_text(line)
    if not clean or is_likely_non_place_line(clean):
        return False
    if MENTION_RE.search(clean):
        return False
    if len(clean.split()) > 8:
        return False
    return has_place_name_shape(clean)


def previous_context(text: str, needle: str, chars: int = 120) -> str:
    position = text.find(needle)
    if position < 0:
        return ""
    return text[max(0, position - chars):position]


def extract_caption_pin_slots(caption: str) -> list[PlaceEvidence]:
    lines = caption.splitlines()
    slots: list[PlaceEvidence] = []
    location_context = infer_country_hint(caption)

    for index, line in enumerate(lines):
        marker, after_marker = strip_leading_marker(line)
        if not marker:
            continue

        raw = clean_text(after_marker)
        if not raw or is_likely_non_place_line(raw):
            continue

        name, address = split_name_and_inline_address(raw)
        previous_line = previous_meaningful_line(lines, index)
        next_line = next_meaningful_line(lines, index)

        if next_line and not address:
            if is_multiple_locations(next_line):
                address = "Multiple locations"
            elif has_address_hint(next_line):
                address = clean_text(next_line)

        if is_location_only_pin_text(name):
            if previous_line and is_previous_line_venue_candidate(previous_line):
                address = clean_text(" ".join(part for part in [name, address] if part))
                name = strip_non_address_parentheticals(previous_line)
            else:
                # Address-only pin. Pair it with a nearby venue mention if possible.
                mention_name = best_venue_mention_near_text(caption, raw)
                if mention_name:
                    address = clean_text(" ".join(part for part in [name, address] if part))
                    name = mention_name

        if is_address_only_name(name):
            mention_name = best_venue_mention_near_text(caption, raw)
            if mention_name:
                address = clean_text(" ".join(part for part in [name, address] if part))
                name = mention_name

        if not name:
            continue

        should_resolve = not is_multiple_locations(address or "")
        notes = []
        if not should_resolve:
            notes.append("source says multiple locations")

        slots.append(
            PlaceEvidence(
                slot_id=f"caption_pin_{len(slots) + 1}",
                source="caption_pin",
                raw_text=raw,
                name_candidate=name,
                address_candidate=address,
                area_candidate=location_context if not address else None,
                should_resolve=should_resolve,
                confidence="high",
                notes=notes,
            )
        )

    return slots


def best_venue_mention_near_text(text: str, nearby_text: str) -> Optional[str]:
    context = previous_context(text, nearby_text, chars=320)
    mentions = MENTION_RE.findall(context)
    if not mentions:
        mentions = MENTION_RE.findall(text)
    if not mentions:
        return None

    for mention in reversed(mentions):
        mention_name = normalize_handle(mention)
        if mention_name and not is_creator_or_publisher_mention(text, mention):
            return mention_name.title()
    return None


def is_address_only_name(name: str) -> bool:
    normalized = clean_text(name).lower()
    if not normalized:
        return False
    if normalized in {"singapore", "malaysia", "kuala lumpur", "petaling jaya"}:
        return True
    if normalized.startswith(("malaysia", "singapore", "federal territory", "wilayah persekutuan")):
        return True
    return has_address_hint(normalized) and len(tokenize_meaningful_words(normalized)) <= 3


def is_creator_or_publisher_mention(text: str, mention: str) -> bool:
    mention_pattern = f"@{mention}"
    context = previous_context(text, mention_pattern, chars=80).lower()
    following_start = text.find(mention_pattern)
    following = text[following_start:following_start + 100].lower() if following_start >= 0 else ""
    combined = f"{context} {following}"
    return any(word in combined for word in CREATOR_CONTEXT_WORDS)


def extract_plain_caption_list_slots(caption: str) -> list[PlaceEvidence]:
    """Extract list-style venue names when no pin slots are present."""
    lines = [clean_text(line) for line in caption.splitlines()]
    candidates: list[str] = []
    location_context = infer_country_hint(caption)

    for line in lines:
        if not line or is_likely_non_place_line(line):
            continue

        if MENTION_RE.search(line) or line.lower().startswith(("post by", "video by")):
            continue

        # Food list posts often use emoji bullets followed by title-cased venue names.
        bullet_match = re.match(r"^[^\w@#]{1,4}\s*(.+)$", line)
        if not bullet_match:
            continue

        candidate = clean_text(bullet_match.group(1))
        if not candidate or has_address_hint(candidate):
            continue
        if len(candidate.split()) > 6:
            continue
        if not has_place_name_shape(candidate):
            continue

        candidates.append(candidate)

    if len(candidates) < 3:
        return []

    slots = []
    seen = set()
    for candidate in candidates:
        key = candidate.lower()
        if key in seen:
            continue
        seen.add(key)
        slots.append(
            PlaceEvidence(
                slot_id=f"caption_list_{len(slots) + 1}",
                source="caption_list",
                raw_text=candidate,
                name_candidate=candidate,
                area_candidate=location_context,
                confidence="high",
            )
        )
    return slots


def has_place_name_shape(text: str) -> bool:
    if ":" in text and len(text.split()) > 2:
        return False
    words = re.findall(r"[A-Za-z0-9:'’&]+", text)
    if not words:
        return False
    lower = text.lower()
    generic_dish_words = {
        "porridge",
        "frogleg",
        "omelette",
        "kailan",
        "kangkong",
        "stingray",
        "scallops",
        "rice",
        "chicken",
        "crab",
        "fish",
    }
    if any(word in generic_dish_words for word in tokenize_meaningful_words(lower)) and len(words) <= 3:
        return False
    return any(char.isupper() for char in text) or ":" in text


def extract_mention_slots(caption: str, *, country_hint: Optional[str] = None) -> list[PlaceEvidence]:
    slots: list[PlaceEvidence] = []
    mentions = MENTION_RE.findall(caption)
    if not mentions:
        return slots

    country_hint = country_hint or infer_country_hint(caption)
    for mention in mentions:
        if is_creator_or_publisher_mention(caption, mention):
            continue

        mention_name = normalize_handle(mention)
        mention_context_match = re.search(rf"@{re.escape(mention)}([^.\n]*)", caption)
        mention_context = mention_context_match.group(0) if mention_context_match else f"@{mention}"
        area = extract_parenthesized_area(mention_context) or country_hint

        if not area and not has_food_context(mention_context):
            continue

        slots.append(
            PlaceEvidence(
                slot_id=f"mention_{len(slots) + 1}",
                source="mention",
                raw_text=mention_context,
                name_candidate=mention_name.title(),
                area_candidate=area,
                confidence="medium",
                notes=["venue handle inferred from caption mention"],
            )
        )

    return dedupe_slots(slots)


def has_food_context(text: str) -> bool:
    return bool(re.search(r"\b(food|restaurant|cafe|bakery|eat|dining|spot|mexican|korean|thai|japanese)\b", text, re.IGNORECASE))


def extract_parenthesized_area(text: str) -> Optional[str]:
    matches = re.findall(r"\(([^)]{3,60})\)", text)
    for match in matches:
        if not PRICE_RE.search(match) and not re.search(r"\d{5,6}", match):
            return clean_text(match)
    return None


def infer_country_hint(text: str) -> Optional[str]:
    return infer_location_context(text)


def dedupe_slots(slots: list[PlaceEvidence]) -> list[PlaceEvidence]:
    deduped: list[PlaceEvidence] = []
    seen = set()
    for slot in slots:
        key = (
            re.sub(r"\W+", "", slot.name_candidate.lower()),
            re.sub(r"\W+", "", (slot.address_candidate or slot.area_candidate or "").lower()),
        )
        if key in seen:
            continue
        seen.add(key)
        slot.slot_id = f"{slot.source}_{len(deduped) + 1}"
        deduped.append(slot)
    return deduped


def extract_place_evidence_from_metadata(record: dict[str, Any]) -> list[PlaceEvidence]:
    core = record.get("yt_dlp_core") or {}
    media_evidence = record.get("media_evidence") or {}
    transcription = media_evidence.get("transcription") or {}
    ocr = media_evidence.get("ocr") or {}
    video_ocr = media_evidence.get("video_ocr") or {}

    caption = "\n".join(
        part for part in [core.get("title") or "", core.get("description") or ""]
        if part
    )

    slots = extract_caption_pin_slots(caption)
    if slots:
        return dedupe_slots(slots)

    slots = extract_plain_caption_list_slots(caption)
    if slots:
        return dedupe_slots(slots)

    ocr_text = ((ocr.get("combined") or {}).get("text") or "").strip()
    if ocr_text:
        slots = extract_caption_pin_slots(ocr_text) or extract_plain_caption_list_slots(ocr_text)
        if slots:
            for slot in slots:
                slot.source = "ocr"
                slot.confidence = "high"
            return dedupe_slots(slots)

    video_ocr_text = (
        ((video_ocr.get("combined") or {}).get("text") or "")
        or (video_ocr.get("combined_text") or "")
    ).strip()
    if video_ocr_text:
        slots = extract_caption_pin_slots(video_ocr_text) or extract_plain_caption_list_slots(video_ocr_text)
        if slots:
            for slot in slots:
                slot.source = "video_ocr"
                slot.confidence = "medium"
            return dedupe_slots(slots)

    slots = extract_mention_slots(caption)
    if slots:
        return dedupe_slots(slots)

    transcript_text = (transcription.get("preferred_text") or "").strip()
    if transcript_text and transcription.get("raw_transcript_quality") != "poor":
        slots = extract_caption_pin_slots(transcript_text) or extract_plain_caption_list_slots(transcript_text)
        if slots:
            for slot in slots:
                slot.source = "transcript"
                slot.confidence = "low"
            return dedupe_slots(slots)

    return []


def build_runtime_metadata_record(
    *,
    title: str = "",
    description: str = "",
    source_url: str = "",
    platform: str = "",
    content_type: str = "",
    uploader: Optional[str] = None,
    duration: Optional[int] = None,
    hashtags: Optional[list[str]] = None,
    ocr_text: str = "",
    video_ocr: Optional[dict[str, Any]] = None,
    transcription: Optional[Any] = None,
) -> dict[str, Any]:
    """Build the metadata shape used by the slot pipeline from bot runtime data."""
    transcription_payload: dict[str, Any] = {}
    if transcription:
        transcription_payload = {
            "language": getattr(transcription, "language", None),
            "text": getattr(transcription, "text", "") or "",
            "english_text": getattr(transcription, "english_text", "") or "",
            "preferred_text": getattr(transcription, "preferred_text", "") or "",
            "raw_transcript_quality": getattr(transcription, "raw_transcript_quality", None),
        }

    return {
        "input": {
            "url": source_url,
            "platform": platform,
        },
        "yt_dlp_core": {
            "title": title or "",
            "description": description or "",
            "uploader": uploader,
            "duration": duration,
            "tags": hashtags or [],
            "webpage_url": source_url,
            "content_type": content_type,
        },
        "media_evidence": {
            "ocr": {
                "combined": {
                    "text": ocr_text or "",
                    "text_length": len(ocr_text or ""),
                }
            },
            "video_ocr": video_ocr or {},
            "transcription": transcription_payload,
        },
    }


def candidate_matches_evidence(candidate: PlaceResult, evidence: PlaceEvidence) -> tuple[bool, str, int]:
    """Validate a Google result against a single evidence slot."""
    evidence_compact = compact_name(evidence.name_candidate)
    candidate_compact = compact_name(candidate.name)
    compact_name_match = evidence_compact and (
        evidence_compact in candidate_compact or candidate_compact in evidence_compact
    )

    if compact_name_match:
        return True, "Compact venue-name match against source slot", 92

    if evidence.address_candidate and evidence.address_candidate.lower() != "multiple locations":
        source_text = f"{evidence.name_candidate} {evidence.address_candidate}"
        assessment = assess_candidate(
            candidate,
            source_text,
            source_type="location_pin",
            allow_address_match=True,
        )
    else:
        source_text = " ".join(
            part for part in [evidence.name_candidate, evidence.area_candidate]
            if part
        )
        assessment = assess_candidate(
            candidate,
            source_text,
            source_type="location_pin" if evidence.source != "transcript" else "chunk",
            allow_address_match=False,
        )

    if not assessment.accepted:
        return False, assessment.reason, assessment.score

    if evidence.source == "mention":
        overlap = handle_tokens(evidence.name_candidate) & set(tokenize_meaningful_words(candidate.name))
        if not overlap and not compact_name_match:
            return False, "Mention handle does not overlap Google place name", 0

    return True, assessment.reason, assessment.score


async def resolve_place_slots(
    slots: list[PlaceEvidence],
    *,
    per_slot_results: int = 5,
) -> list[PlaceSlotSuggestion]:
    suggestions: list[PlaceSlotSuggestion] = []

    for slot in slots:
        if not slot.should_resolve:
            suggestions.append(
                PlaceSlotSuggestion(
                    evidence=slot,
                    status="brand_or_multiple_locations",
                    reason="Source says multiple locations; not forcing one branch.",
                )
            )
            continue

        if not slot.query:
            suggestions.append(
                PlaceSlotSuggestion(evidence=slot, status="unresolved", reason="No query")
            )
            continue

        results = await search_place(slot.query, max_results=per_slot_results)
        candidates = results if isinstance(results, list) else ([results] if results else [])
        accepted: list[PlaceResult] = []

        for candidate in candidates:
            ok, reason, score = candidate_matches_evidence(candidate, slot)
            if not ok:
                continue
            candidate.confidence_score = score
            candidate.confidence_label = "high" if score >= 85 else "likely" if score >= 60 else "possible"
            candidate.confidence_reason = reason
            candidate.matched_query = slot.query
            candidate.matched_source_type = slot.source
            accepted.append(candidate)

        accepted.sort(key=lambda item: (item.confidence_score, item.rating or 0, item.rating_count or 0), reverse=True)

        suggestions.append(
            PlaceSlotSuggestion(
                evidence=slot,
                status="resolved" if accepted else "unresolved",
                candidates=accepted,
                selected=accepted[0] if accepted else None,
                reason=None if accepted else "No Google result passed slot validation",
            )
        )

    return suggestions


async def run_slot_pipeline_for_metadata(record: dict[str, Any]) -> list[PlaceSlotSuggestion]:
    slots = extract_place_evidence_from_metadata(record)
    if not slots:
        return []
    return await resolve_place_slots(slots)


def slots_to_dict(slots: list[PlaceEvidence]) -> list[dict[str, Any]]:
    return [asdict(slot) | {"query": slot.query} for slot in slots]


def suggestions_to_dict(suggestions: list[PlaceSlotSuggestion]) -> list[dict[str, Any]]:
    output = []
    for suggestion in suggestions:
        item = {
            "evidence": asdict(suggestion.evidence) | {"query": suggestion.evidence.query},
            "status": suggestion.status,
            "reason": suggestion.reason,
            "selected": asdict(suggestion.selected) if suggestion.selected else None,
            "candidates": [asdict(candidate) for candidate in suggestion.candidates],
        }
        output.append(item)
    return output


def run_async(coro):
    return asyncio.run(coro)
