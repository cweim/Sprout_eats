import asyncio
from dataclasses import asdict, dataclass, field
import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

from services.places import (
    PlaceResult,
    assess_candidate,
    infer_location_context,
    search_place,
    tokenize_meaningful_words,
)


PIN_MARKERS = ("📍", "📌", "🍴", "🍽️", "🥢", "🏠")
ADDRESS_HINT_RE = re.compile(
    r"("
    r"(?:Singapore|SG)\s*\d{6}"
    r"|\b\d{6}\b"
    r"|\b\d{5}\b.*(?:Malaysia|Selangor|Kuala\s*Lumpur|Petaling\s*Jaya|Ampang)"
    r"|\b(?:road|rd|street|st|jalan|jln|lane|ln|drive|dr|bukit|plaza|avenue|ave|boulevard|blvd|crescent|cres|terrace|tce|park(?:way)?|pkwy|pk|close|cl|court|ct|walk|way|gardens?|gdn)\b"
    r")",
    re.IGNORECASE,
)
LOCATION_ONLY_CUE_RE = re.compile(
    r"\b("
    r"level|lvl|floor|flr|next\s+to|near|opposite|beside|inside|within|"
    r"mrt|metro\s+station|train\s+station|"
    r"mall|shopping\s+centre|shopping\s+center|city|plaza|village|"
    r"centre|center|tower|building|financial|house"
    r")\b",
    re.IGNORECASE,
)
PRICE_RE = re.compile(r"(?:[$€£]\s*\d+|\bRM\s*\d+|\(\s*RM|\$\d+)", re.IGNORECASE)
NON_AREA_PARENTHETICAL_RE = re.compile(
    r"\b(counter|seats?|seating|menu|course|halal|non[- ]halal|"
    r"homebased|takeaway|take-out|dine-in)\b",
    re.IGNORECASE,
)
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


_HANDLE_COUNTRY_SUFFIX_RE = re.compile(r"(?:sg|my|ph|id|th|vn|tw|hk|com)$", re.IGNORECASE)


def normalize_handle(handle: str) -> str:
    name = re.sub(r"[._]+", " ", handle).strip()
    # If still a single unbroken token, strip trailing country/TLD suffix so
    # handles like "theacaitrucksg" become "theacairtruck" (better for search)
    if " " not in name:
        stripped = _HANDLE_COUNTRY_SUFFIX_RE.sub("", name).strip()
        if stripped and len(stripped) >= 4:
            name = stripped
    return name


def handle_tokens(handle: str) -> set[str]:
    return set(tokenize_meaningful_words(normalize_handle(handle)))


def compact_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def has_address_hint(text: str) -> bool:
    return bool(ADDRESS_HINT_RE.search(text or ""))


def is_multiple_locations(text: str) -> bool:
    return bool(re.search(r"\bmultiple\s+locations?\b", text or "", re.IGNORECASE))


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
        return clean_text(re.sub(r"multiple\s+locations?", "", text, flags=re.IGNORECASE)), "Multiple locations"

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
    text = re.sub(
        r"\[\s*(?:non[- ]?halal|halal|muslim[- ]owned)\s*\]",
        "",
        text,
        flags=re.IGNORECASE,
    )

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

        if not name and is_multiple_locations(address or raw):
            if previous_line and is_previous_line_venue_candidate(previous_line):
                name = strip_non_address_parentheticals(previous_line)
                address = "Multiple locations"

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
    if re.fullmatch(r"\d+[a-z]?", normalized):
        return True
    unit_pattern = r"(?:no\.?\s*)?[a-z]?\d+[a-z]?(?:\s*(?:-|/|&)\s*[a-z0-9]+)*"
    if re.fullmatch(
        unit_pattern,
        normalized,
        re.IGNORECASE,
    ):
        return True
    first_segment = normalized.split(",", 1)[0].strip()
    if "," in normalized and re.fullmatch(unit_pattern, first_segment, re.IGNORECASE):
        return True
    # Leading street number with 2+ meaningful words → address component, not venue name.
    # e.g. "27 Prince George's Pk" → True, but "49 Seats" (1 meaningful word) → False.
    if re.match(r"^\d+\s+\w", normalized) and len(tokenize_meaningful_words(normalized)) >= 2:
        return True
    return has_address_hint(normalized) and len(tokenize_meaningful_words(normalized)) <= 3


def is_creator_or_publisher_mention(text: str, mention: str) -> bool:
    mention_pattern = f"@{mention}"
    for line in text.splitlines():
        if mention_pattern not in line:
            continue
        line_lower = line.lower()
        return any(word in line_lower for word in CREATOR_CONTEXT_WORDS)
    return False


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


def extract_numbered_list_slots(caption: str) -> list[PlaceEvidence]:
    """Extract '1. Name' or '1. Name — Address' list patterns (requires ≥2 matches)."""
    lines = [clean_text(line) for line in caption.splitlines()]
    slots: list[PlaceEvidence] = []
    location_context = infer_country_hint(caption)

    for line in lines:
        m = re.match(r"^\d+[.)]\s+(.+)$", line)
        if not m:
            continue
        content = clean_text(m.group(1))
        if not content or is_likely_non_place_line(content):
            continue
        parts = re.split(r"\s*[—–]\s*|\s+[-]\s+", content, maxsplit=1)
        name = clean_text(parts[0])
        address = clean_text(parts[1]) if len(parts) > 1 else None
        if not name or not has_place_name_shape(name) or len(name.split()) > 6:
            continue
        slots.append(
            PlaceEvidence(
                slot_id=f"numbered_list_{len(slots) + 1}",
                source="caption_list",
                raw_text=line,
                name_candidate=name,
                address_candidate=address,
                area_candidate=location_context if not address else None,
                confidence="high",
            )
        )

    return slots if len(slots) >= 2 else []


def extract_first_line_slot(caption: str) -> list[PlaceEvidence]:
    """Last resort: treat first meaningful line as venue name when location context is present."""
    lines = [clean_text(l) for l in caption.splitlines() if clean_text(l)]
    if not lines:
        return []
    first = lines[0]
    if MENTION_RE.search(first) or HASHTAG_RE.search(first):
        return []
    if len(first.split()) > 6 or not has_place_name_shape(first):
        return []
    if is_likely_non_place_line(first):
        return []
    first_lower = first.lower()
    # Filter creator/attribution lines
    if first_lower.startswith(("video by", "post by", "by ", "filmed by", "photo by")):
        return []
    # Filter domain-like strings (e.g. "foodstamp.sg")
    if re.search(r"\b\w+\.(sg|com|my|co|net|io|app)\b", first_lower):
        return []
    location_context = infer_country_hint(caption)
    if not location_context:
        return []
    return [
        PlaceEvidence(
            slot_id="first_line_1",
            source="first_line",
            raw_text=first,
            name_candidate=first,
            area_candidate=location_context,
            confidence="low",
        )
    ]


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
    caption_has_food = has_food_context(caption)
    for mention in mentions:
        if is_creator_or_publisher_mention(caption, mention):
            continue

        mention_name = normalize_handle(mention)
        mention_context_match = re.search(rf"@{re.escape(mention)}([^.\n]*)", caption)
        mention_context = mention_context_match.group(0) if mention_context_match else f"@{mention}"
        area = (
            extract_parenthesized_area(mention_context)
            or extract_explicit_area(mention_context)
            or country_hint
        )

        if not area and not has_food_context(mention_context) and not caption_has_food:
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
        if (
            not PRICE_RE.search(match)
            and not re.search(r"\d{5,6}", match)
            and not NON_AREA_PARENTHETICAL_RE.search(match)
        ):
            return clean_text(match)
    return None


def extract_explicit_area(text: str) -> Optional[str]:
    """Extract a bounded, location-shaped phrase introduced by 'at' or 'located in'."""
    match = re.search(
        r"\b(?:at|located\s+(?:at|in))\s+([^.!?\n]{3,80})",
        text,
        re.IGNORECASE,
    )
    if not match:
        return None
    candidate = clean_text(match.group(1))
    if len(candidate.split()) > 8:
        return None
    if not LOCATION_ONLY_CUE_RE.search(candidate) and not infer_country_hint(candidate):
        return None
    return candidate


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

    slots = extract_numbered_list_slots(caption)
    if slots:
        return dedupe_slots(slots)

    # Instagram location tag from Apify — high confidence only when it's an actual venue name
    # (filter out country/city strings and building/area descriptors)
    location_tag = record.get("apify_location_tag", "").strip()
    if (
        location_tag
        and has_place_name_shape(location_tag)
        and not is_address_only_name(location_tag)
        and not is_location_only_pin_text(location_tag)
    ):
        country_hint = infer_country_hint(caption)
        slots = [
            PlaceEvidence(
                slot_id="location_tag_1",
                source="location_tag",
                raw_text=location_tag,
                name_candidate=location_tag,
                area_candidate=country_hint,
                confidence="high",
                notes=["Instagram location tag"],
            )
        ]
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

    slots = extract_first_line_slot(caption)
    if slots:
        return dedupe_slots(slots)

    # Last resort: try the reel account handle itself as a venue name.
    # Many food venues post their own reels (@theacaitrucksg, @allhands.cafe).
    # Gate on food context so blogger handles don't fire on non-food posts.
    uploader = (core.get("uploader") or "").strip()
    if uploader and has_food_context(caption):
        uploader_name = normalize_handle(uploader).title()
        if uploader_name and has_place_name_shape(uploader_name):
            country_hint = infer_country_hint(caption)
            return dedupe_slots([
                PlaceEvidence(
                    slot_id="uploader_1",
                    source="mention",
                    raw_text=f"@{uploader}",
                    name_candidate=uploader_name,
                    area_candidate=country_hint,
                    confidence="low",
                    notes=["venue inferred from reel account handle"],
                )
            ])

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


def build_runtime_metadata_record_from_dataset(
    record: dict[str, Any],
    *,
    include_ocr: bool = False,
    include_video_ocr: bool = False,
    include_transcription: bool = False,
) -> dict[str, Any]:
    """Build a staged runtime record from a normalized dataset entry."""
    core = record.get("yt_dlp_core") or {}
    media_evidence = record.get("media_evidence") or {}
    ocr = media_evidence.get("ocr") or {}
    video_ocr = media_evidence.get("video_ocr") or {}
    transcription = media_evidence.get("transcription") or {}

    ocr_text = ""
    if include_ocr:
        ocr_text = ((ocr.get("combined") or {}).get("text") or "").strip()

    video_ocr_payload: dict[str, Any] | None = None
    if include_video_ocr and video_ocr:
        video_ocr_payload = video_ocr

    transcription_payload: dict[str, Any] | None = None
    if include_transcription and transcription:
        transcription_payload = transcription

    return build_runtime_metadata_record(
        title=core.get("title") or "",
        description=core.get("description") or "",
        source_url=((record.get("input") or {}).get("url") or ""),
        platform=((record.get("input") or {}).get("platform") or ""),
        content_type=((record.get("derived") or {}).get("content_type") or ""),
        uploader=core.get("uploader"),
        duration=core.get("duration"),
        hashtags=core.get("tags") or [],
        ocr_text=ocr_text,
        video_ocr=video_ocr_payload,
        transcription=transcription_payload,
    )


def extract_place_evidence_with_runtime_order(
    record: dict[str, Any]
) -> tuple[list[PlaceEvidence], list[str]]:
    """
    Emulate the bot's staged source order for slot extraction.

    Order:
    1. caption/title
    2. image OCR
    3. video OCR
    4. audio transcription
    """
    slots = extract_place_evidence_from_metadata(
        build_runtime_metadata_record_from_dataset(record)
    )
    if slots:
        return slots, ["caption"]

    ocr_text = (((record.get("media_evidence") or {}).get("ocr") or {}).get("combined") or {}).get("text")
    if ocr_text:
        slots = extract_place_evidence_from_metadata(
            build_runtime_metadata_record_from_dataset(record, include_ocr=True)
        )
        if slots:
            return slots, ["caption", "image_ocr"]

    video_ocr = (record.get("media_evidence") or {}).get("video_ocr") or {}
    video_ocr_text = ((video_ocr.get("combined") or {}).get("text") or video_ocr.get("combined_text") or "").strip()
    if video_ocr_text:
        slots = extract_place_evidence_from_metadata(
            build_runtime_metadata_record_from_dataset(record, include_video_ocr=True)
        )
        if slots:
            return slots, ["caption", "image_ocr", "video_ocr"]

    transcription = (record.get("media_evidence") or {}).get("transcription") or {}
    transcript_text = (
        transcription.get("preferred_text")
        or transcription.get("english_text")
        or transcription.get("text")
        or ""
    ).strip()
    if transcript_text:
        slots = extract_place_evidence_from_metadata(
            build_runtime_metadata_record_from_dataset(record, include_transcription=True)
        )
        if slots:
            return slots, ["caption", "image_ocr", "video_ocr", "transcription"]

    return [], ["caption", "image_ocr", "video_ocr", "transcription"]


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
    timeout_seconds: float | None = None,
    max_concurrency: int = 1,
) -> list[PlaceSlotSuggestion]:
    async def resolve_slot(slot: PlaceEvidence) -> PlaceSlotSuggestion:
        if not slot.should_resolve:
            return PlaceSlotSuggestion(
                evidence=slot,
                status="brand_or_multiple_locations",
                reason="Source says multiple locations; not forcing one branch.",
            )

        if not slot.query:
            return PlaceSlotSuggestion(
                evidence=slot,
                status="unresolved",
                reason="No query",
            )

        async with semaphore:
            results = await search_place(slot.query, max_results=per_slot_results)
        candidates = results if isinstance(results, list) else ([results] if results else [])
        effective_query = slot.query

        # Fallback 1: area hint may be too vague (e.g. "pgp", "cbd") — retry name-only
        if not candidates and slot.area_candidate and slot.name_candidate:
            effective_query = slot.name_candidate
            async with semaphore:
                r2 = await search_place(effective_query, max_results=per_slot_results)
            candidates = r2 if isinstance(r2, list) else ([r2] if r2 else [])

        # Fallback 2: mention handles with no area — retry "{name} food" to force food category
        if not candidates and slot.source == "mention" and slot.name_candidate:
            effective_query = f"{slot.name_candidate} food"
            async with semaphore:
                r3 = await search_place(effective_query, max_results=per_slot_results)
            candidates = r3 if isinstance(r3, list) else ([r3] if r3 else [])

        accepted: list[PlaceResult] = []

        for candidate in candidates:
            ok, reason, score = candidate_matches_evidence(candidate, slot)
            if not ok:
                continue
            candidate.confidence_score = score
            candidate.confidence_label = "high" if score >= 85 else "likely" if score >= 60 else "possible"
            candidate.confidence_reason = reason
            candidate.matched_query = effective_query
            candidate.matched_source_type = slot.source
            accepted.append(candidate)

        accepted.sort(key=lambda item: (item.confidence_score, item.rating or 0, item.rating_count or 0), reverse=True)

        # Detect chain: 2+ accepted candidates all sharing the same compact venue name
        # (e.g. 5 McDonald's branches). Surface all to user instead of auto-picking one.
        if len(accepted) >= 2:
            nc = compact_name(slot.name_candidate)
            if nc and all(
                nc in compact_name(c.name) or compact_name(c.name) in nc
                for c in accepted
            ):
                return PlaceSlotSuggestion(
                    evidence=slot,
                    status="chain",
                    candidates=accepted[:8],
                    selected=None,
                    reason=f"Multiple branches found for '{slot.name_candidate}'",
                )

        return PlaceSlotSuggestion(
            evidence=slot,
            status="resolved" if accepted else "unresolved",
            candidates=accepted if accepted else candidates,
            selected=accepted[0] if accepted else None,
            reason=None if accepted else "No Google result passed slot validation",
        )

    if not slots:
        return []

    semaphore = asyncio.Semaphore(max(1, max_concurrency))
    if timeout_seconds is None and max_concurrency <= 1:
        return [await resolve_slot(slot) for slot in slots]

    tasks = [asyncio.create_task(resolve_slot(slot)) for slot in slots]
    done, pending = await asyncio.wait(tasks, timeout=timeout_seconds)

    if pending:
        logger.warning(
            "Place resolution timed out with %d of %d slots still pending",
            len(pending),
            len(tasks),
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    suggestions: list[PlaceSlotSuggestion] = []
    for slot, task in zip(slots, tasks):
        if task in pending:
            suggestions.append(
                PlaceSlotSuggestion(
                    evidence=slot,
                    status="timed_out",
                    reason="Place lookup timed out",
                )
            )
            continue
        suggestions.append(task.result())

    return suggestions


async def extract_slots_via_llm(
    caption: str,
    platform: str = "",
    uploader: str = "",
    hashtags: list[str] | None = None,
) -> list[PlaceEvidence]:
    """Groq llama-3.1-8b-instant fallback when all rule-based extractors return no slots."""
    import config  # local import to avoid circular dependency
    if not getattr(config, "ENABLE_LLM_PLACE_FALLBACK", False):
        return []
    if not getattr(config, "GROQ_API_KEY", ""):
        logger.warning("LLM place fallback enabled but GROQ_API_KEY not set — skipping")
        return []
    try:
        import json as _json

        from groq import AsyncGroq

        client = AsyncGroq(api_key=config.GROQ_API_KEY)

        # Build context block with everything available
        context_parts = []
        if caption:
            context_parts.append(f"Caption:\n{caption[:2000]}")
        if uploader:
            context_parts.append(f"Account handle: @{uploader}")
        if hashtags:
            context_parts.append(f"Hashtags: {' '.join(f'#{h}' for h in hashtags[:20])}")
        context = "\n\n".join(context_parts)

        prompt = (
            f"Extract restaurant/cafe/bar/venue names from this {platform} reel. "
            "Use ALL provided context — caption, account handle, and hashtags — as clues. "
            "Return ONLY a JSON array of objects with keys: name (string), address (string or null), area (string or null). "
            "Return [] if no venues are clearly mentioned. No prose, no markdown.\n\n"
            + context
        )
        response = await client.chat.completions.create(
            model="llama-3.1-8b-instant",
            max_tokens=256,
            temperature=0,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.choices[0].message.content.strip()
        items = _json.loads(raw)
        if not isinstance(items, list):
            return []
        country_hint = infer_country_hint(caption)
        slots: list[PlaceEvidence] = []
        for item in items:
            name = (item.get("name") or "").strip()
            if not name or not has_place_name_shape(name):
                continue
            slots.append(
                PlaceEvidence(
                    slot_id=f"llm_{len(slots) + 1}",
                    source="llm_fallback",
                    raw_text=name,
                    name_candidate=name,
                    address_candidate=(item.get("address") or "").strip() or None,
                    area_candidate=(item.get("area") or "").strip() or country_hint or None,
                    confidence="low",
                )
            )
        return slots
    except Exception as exc:
        logger.warning("LLM place fallback failed: %s", exc)
        return []


async def extract_place_evidence_from_metadata_async(
    record: dict[str, Any], *, platform: str = ""
) -> list[PlaceEvidence]:
    """Async variant of extract_place_evidence_from_metadata with LLM fallback."""
    slots = extract_place_evidence_from_metadata(record)
    if slots:
        return slots
    core = record.get("yt_dlp_core") or {}
    caption = "\n".join(
        part for part in [core.get("title") or "", core.get("description") or ""] if part
    )
    uploader = (core.get("uploader") or "").strip()
    hashtags = [h for h in (core.get("tags") or []) if isinstance(h, str) and h]
    return await extract_slots_via_llm(caption, platform=platform, uploader=uploader, hashtags=hashtags)


async def run_slot_pipeline_for_metadata(
    record: dict[str, Any], *, platform: str = ""
) -> list[PlaceSlotSuggestion]:
    slots = await extract_place_evidence_from_metadata_async(record, platform=platform)
    if not slots:
        return []
    return await resolve_place_slots(slots)


async def run_bot_like_slot_pipeline_for_metadata(
    record: dict[str, Any]
) -> tuple[list[PlaceEvidence], list[PlaceSlotSuggestion], list[str]]:
    """Run the current staged slot pipeline the same way the bot does."""
    slots, checked_sources = extract_place_evidence_with_runtime_order(record)
    if not slots:
        return [], [], checked_sources
    suggestions = await resolve_place_slots(slots)
    return slots, suggestions, checked_sources


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
