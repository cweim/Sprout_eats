import json
from pathlib import Path

from services.place_pipeline import (
    PlaceEvidence,
    build_runtime_metadata_record,
    candidate_matches_evidence,
    extract_place_evidence_from_metadata,
    resolve_place_slots,
)
from services.places import PlaceResult


DATASET = Path("place-extraction-pipeline/metadata_dataset/instagram_metadata_with_media.json")


def record_by_shortcode(shortcode: str) -> dict:
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
