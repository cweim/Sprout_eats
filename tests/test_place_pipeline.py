import asyncio
import json
from pathlib import Path

import pytest

from services.place_pipeline import (
    PlaceEvidence,
    build_runtime_metadata_record,
    candidate_matches_evidence,
    extract_caption_pin_slots,
    extract_numbered_list_slots,
    extract_place_evidence_from_metadata,
    is_creator_or_publisher_mention,
    resolve_place_slots,
)
from services.places import PlaceResult


DATASET = Path("place-extraction-pipeline/metadata_dataset/instagram_metadata_with_media.json")


def record_by_shortcode(shortcode: str) -> dict:
    if not DATASET.exists():
        pytest.skip(f"Optional metadata fixture is not available: {DATASET}")
    records = json.loads(DATASET.read_text(encoding="utf-8"))
    return next(record for record in records if record["input"]["shortcode"] == shortcode)


def test_extracts_all_caption_pin_slots_without_eight_item_cap():
    slots = extract_place_evidence_from_metadata(record_by_shortcode("DEAN_ZMyAtl"))

    assert len(slots) == 12
    assert slots[0].name_candidate == "One Fattened Calf Burgers"
    assert slots[-1].name_candidate == "A Hot Hideout"


def test_extracts_plain_caption_list_without_creator_mention_false_positive():
    slots = extract_place_evidence_from_metadata(record_by_shortcode("DS3v8C4j8dg"))
    names = [slot.name_candidate for slot in slots]

    assert names == [
        "Osteria Mozza",
        "GU:UM",
        "Uncle Fong Hotpot",
        "Sushi Zushi",
        "The Plump Frenchman",
        "Vios by Blu Kouzina",
        "Bochinche",
    ]
    assert "districtsixtyfive" not in [name.lower() for name in names]
    assert all(slot.area_candidate == "Singapore" for slot in slots)


def test_pairs_address_only_pin_with_nearby_venue_mention():
    slots = extract_place_evidence_from_metadata(record_by_shortcode("DUExJM_Ep6i"))

    assert len(slots) == 1
    assert slots[0].name_candidate == "Uokatsu Malaysia"
    assert "Plaza Damas 3" in slots[0].address_candidate
    assert "Singapore" not in slots[0].query


def test_pairs_wayfinding_pin_with_previous_venue_line():
    record = build_runtime_metadata_record(
        description=(
            "Possibly MY FAV RAMEN PLACE IN SINGAPORE NOW\n\n"
            "Mensho Tokyo (Michelin featured)\n"
            "📍 Raffles City Level 3 (next to Surrey Hills cafe)\n\n"
            "OMG THE GARLIC RAMEN WAS AMAZING!!"
        )
    )

    slots = extract_place_evidence_from_metadata(record)

    assert len(slots) == 1
    assert slots[0].name_candidate == "Mensho Tokyo"
    assert slots[0].address_candidate == "Raffles City Level 3 (next to Surrey Hills cafe)"
    assert slots[0].query == "Mensho Tokyo, Raffles City Level 3 (next to Surrey Hills cafe)"


def test_pairs_numeric_street_pin_with_previous_venue_name():
    record = build_runtime_metadata_record(
        description=(
            "Kee Kee Bentong Chicken Rice [Non-Halal]\n"
            "📍 33, Jalan SS 4d/2, Ss 4, 47301 Petaling Jaya, Selangor\n"
            "⏰Daily 10am til sold out"
        )
    )

    slots = extract_place_evidence_from_metadata(record)

    assert len(slots) == 1
    assert slots[0].name_candidate == "Kee Kee Bentong Chicken Rice"
    assert slots[0].address_candidate == "33 Jalan SS 4d/2, Ss 4, 47301 Petaling Jaya, Selangor"
    assert slots[0].query.startswith("Kee Kee Bentong Chicken Rice, 33 Jalan")


def test_pairs_unit_number_addresses_and_singular_multiple_location_with_venue_names():
    record = build_runtime_metadata_record(
        description=(
            "Kaki Corner\n"
            "📍 No. 20 & 22, Jalan Siput Akek, Kuala Lumpur 56100\n\n"
            "Yatie Kitchen\n"
            "📍 D3-G, Tingkat Bawah, Dataran Palma, Ampang, Selangor 68000\n\n"
            "WoodFire Burger\n"
            "📍 Multiple location"
        )
    )

    slots = extract_place_evidence_from_metadata(record)

    assert [slot.name_candidate for slot in slots] == [
        "Kaki Corner",
        "Yatie Kitchen",
        "WoodFire Burger",
    ]
    assert slots[0].address_candidate.startswith("No. 20 & 22")
    assert slots[1].address_candidate.startswith("D3-G")
    assert slots[2].address_candidate == "Multiple locations"
    assert slots[2].should_resolve is False


def test_seating_parenthetical_is_not_used_as_mention_area():
    record = build_runtime_metadata_record(
        description=(
            "Been wanting to try homebased @saikyopasta but now they have a pasta bar "
            "(counter seats~) at Icon Village, Tanjong Pagar!\n"
            "Small menu, but everything is well executed. #sgfood"
        )
    )

    slots = extract_place_evidence_from_metadata(record)

    assert len(slots) == 1
    assert slots[0].name_candidate == "Saikyopasta"
    assert slots[0].area_candidate == "Icon Village, Tanjong Pagar"
    assert "counter seats" not in slots[0].query.lower()


def test_true_parenthesized_area_is_preserved_for_mentions():
    slots = extract_place_evidence_from_metadata(
        build_runtime_metadata_record(
            description="Dinner at @examplecafe (Tanjong Pagar), a lovely Singapore cafe."
        )
    )

    assert len(slots) == 1
    assert slots[0].area_candidate == "Tanjong Pagar"


def test_generic_mrt_location_tag_does_not_override_venue_mention():
    record = build_runtime_metadata_record(
        description=(
            "Honestly my latest obsession - @joongsan.sg, nearest MRT Telok Ayer. "
            "If you're looking for Korean food in Singapore, this is the place."
        )
    )
    record["apify_location_tag"] = "Telok Ayer MRT Station"

    slots = extract_place_evidence_from_metadata(record)

    assert len(slots) == 1
    assert slots[0].source == "mention"
    assert slots[0].name_candidate == "Joongsan Sg"
    assert slots[0].query == "Joongsan Sg, Singapore"


def test_generic_or_visual_only_posts_do_not_guess_slots():
    assert extract_place_evidence_from_metadata(record_by_shortcode("DFCnSjRyk3C")) == []
    assert extract_place_evidence_from_metadata(record_by_shortcode("DQwiEYlEgft")) == []


def test_runtime_metadata_adapter_uses_caption_slots_before_ocr():
    record = build_runtime_metadata_record(
        title="",
        description="📍 Caption Cafe",
        source_url="https://www.instagram.com/reel/example/",
        platform="instagram",
        ocr_text="📍 OCR Cafe",
    )

    slots = extract_place_evidence_from_metadata(record)

    assert [slot.name_candidate for slot in slots] == ["Caption Cafe"]
    assert slots[0].source == "caption_pin"


def test_runtime_metadata_adapter_exposes_video_ocr_before_transcript():
    transcription = type(
        "Transcription",
        (),
        {
            "language": "en",
            "text": "📍 Transcript Cafe",
            "english_text": None,
            "preferred_text": "📍 Transcript Cafe",
            "raw_transcript_quality": "good",
        },
    )()
    record = build_runtime_metadata_record(
        video_ocr={"combined_text": "📍 Video Cafe"},
        transcription=transcription,
    )

    slots = extract_place_evidence_from_metadata(record)

    assert [slot.name_candidate for slot in slots] == ["Video Cafe"]
    assert slots[0].source == "video_ocr"


async def test_multiple_location_slots_do_not_resolve_to_random_branch():
    slots = [
        PlaceEvidence(
            slot_id="caption_pin_1",
            source="caption_pin",
            raw_text="Daily Fix Multiple locations",
            name_candidate="Daily Fix",
            address_candidate="Multiple locations",
            should_resolve=False,
        )
    ]

    suggestions = await resolve_place_slots(slots)

    assert suggestions[0].status == "brand_or_multiple_locations"
    assert suggestions[0].selected is None


@pytest.mark.asyncio
async def test_resolve_place_slots_preserves_completed_results_on_timeout(monkeypatch):
    slots = [
        PlaceEvidence(
            slot_id="fast",
            source="caption_pin",
            raw_text="Fast Cafe",
            name_candidate="Fast Cafe",
        ),
        PlaceEvidence(
            slot_id="slow",
            source="caption_pin",
            raw_text="Slow Cafe",
            name_candidate="Slow Cafe",
        ),
    ]
    fast_result = PlaceResult(
        name="Fast Cafe",
        address="1 Test Street",
        latitude=1.0,
        longitude=103.0,
        place_id="fast",
        types=["restaurant"],
    )

    async def fake_search(query: str, max_results: int):
        if query == "Slow Cafe":
            await asyncio.Event().wait()
        return [fast_result]

    monkeypatch.setattr("services.place_pipeline.search_place", fake_search)
    monkeypatch.setattr(
        "services.place_pipeline.candidate_matches_evidence",
        lambda candidate, slot: (True, "matched", 90),
    )

    suggestions = await resolve_place_slots(
        slots,
        timeout_seconds=0.01,
        max_concurrency=2,
    )

    assert suggestions[0].status == "resolved"
    assert suggestions[0].selected is fast_result
    assert suggestions[1].status == "timed_out"
    assert suggestions[1].selected is None


def test_compact_name_validation_handles_punctuation_and_fused_handles():
    guum = PlaceResult(
        name="GUUM Contemporary Grill",
        address="29 Keong Saik Rd., Singapore 089136",
        latitude=1.0,
        longitude=103.0,
        place_id="guum",
        types=["restaurant", "food"],
    )
    fuego = PlaceResult(
        name="Fuego Mesa",
        address="681 Race Course Rd, #01-305, Singapore 210681",
        latitude=1.0,
        longitude=103.0,
        place_id="fuego",
        types=["restaurant", "food"],
    )

    guum_slot = extract_place_evidence_from_metadata(record_by_shortcode("DS3v8C4j8dg"))[1]
    fuego_slot = extract_place_evidence_from_metadata(record_by_shortcode("DOmzzsxEq_9"))[0]

    assert candidate_matches_evidence(guum, guum_slot)[0] is True
    assert candidate_matches_evidence(fuego, fuego_slot)[0] is True


# ── Fix 1: creator false-positive with per-line context ──────────────────────

def test_creator_check_does_not_bleed_across_lines():
    """'follow' on a different line must not flag @venue as creator."""
    caption = "follow @aidenandmaddy for more Singapore tips\n@kinkibar"
    assert is_creator_or_publisher_mention(caption, "kinkibar") is False


def test_creator_check_flags_same_line_follow():
    """'follow @venue' on the same line is a creator mention."""
    caption = "follow @kinkibar for more tips"
    assert is_creator_or_publisher_mention(caption, "kinkibar") is True


# ── Fix 3: food emoji markers treated as pin markers ────────────────────────

def test_food_emoji_marker_extracts_venue():
    """🍴 marker should produce a caption_pin slot like 📍."""
    caption = "🍴 49 Seats\nSingapore"
    slots = extract_caption_pin_slots(caption)
    assert len(slots) == 1
    assert slots[0].name_candidate == "49 Seats"
    assert slots[0].source == "caption_pin"


def test_fork_knife_emoji_with_address():
    """🍽️ marker with inline address should split correctly."""
    caption = "🍽️ Osteria Mozza, 333 Orchard Rd"
    slots = extract_caption_pin_slots(caption)
    assert len(slots) == 1
    assert slots[0].name_candidate == "Osteria Mozza"


# ── Fix 4: numbered list extractor ──────────────────────────────────────────

def test_numbered_list_extracts_venues():
    """1. Name pattern (≥2 items) should be extracted."""
    caption = "Best cafes in Singapore:\n1. Chye Seng Huat\n2. Papa Palheta\n3. Nylon Coffee"
    slots = extract_numbered_list_slots(caption)
    names = [s.name_candidate for s in slots]
    assert "Chye Seng Huat" in names
    assert "Papa Palheta" in names
    assert "Nylon Coffee" in names


def test_numbered_list_requires_two_entries():
    """Single numbered item should not produce slots."""
    caption = "1. Chye Seng Huat"
    slots = extract_numbered_list_slots(caption)
    assert slots == []


def test_numbered_list_splits_name_and_address():
    """'1. Name — Address' should split into name + address."""
    caption = "1. Chye Seng Huat — 150 Tyrwhitt Rd, Singapore\n2. Papa Palheta — Erskine Road"
    slots = extract_numbered_list_slots(caption)
    assert slots[0].name_candidate == "Chye Seng Huat"
    assert "Tyrwhitt" in (slots[0].address_candidate or "")


# ── Fix 2: Apify locationName → direct slot ─────────────────────────────────

def test_apify_location_tag_creates_slot_when_caption_empty():
    """apify_location_tag in record should produce a high-confidence slot."""
    record = build_runtime_metadata_record(title="", description="Singapore")
    record["apify_location_tag"] = "Laifabar"
    slots = extract_place_evidence_from_metadata(record)
    assert len(slots) == 1
    assert slots[0].name_candidate == "Laifabar"
    assert slots[0].source == "location_tag"
    assert slots[0].confidence == "high"


def test_apify_location_tag_not_used_when_caption_slots_found():
    """Caption pin slots take priority over apify_location_tag."""
    record = build_runtime_metadata_record(description="📍 Mensho Tokyo")
    record["apify_location_tag"] = "Some Area Tag"
    slots = extract_place_evidence_from_metadata(record)
    assert slots[0].name_candidate == "Mensho Tokyo"
    assert slots[0].source == "caption_pin"
