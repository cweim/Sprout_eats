from fastapi import APIRouter
from database import repository

router = APIRouter(prefix="/api")


def place_to_dict(place) -> dict:
    """Convert Place model to dictionary for JSON response."""
    return {
        "id": place.id,
        "name": place.name,
        "address": place.address,
        "latitude": place.latitude,
        "longitude": place.longitude,
        "google_place_id": place.google_place_id,
        "source_url": place.source_url,
        "source_platform": place.source_platform,
        "created_at": place.created_at.isoformat() if place.created_at else None,
        "source_title": place.source_title,
        "source_uploader": place.source_uploader,
        "source_duration": place.source_duration,
        "source_hashtags": place.source_hashtags,
        "place_types": place.place_types,
        "place_rating": place.place_rating,
        "place_rating_count": place.place_rating_count,
        "place_price_level": place.place_price_level,
        "place_opening_hours": place.place_opening_hours,
        "source_language": place.source_language,
        "source_transcript": place.source_transcript,
        "source_transcript_en": place.source_transcript_en,
    }


@router.get("/places")
async def get_places():
    """Get all saved places."""
    places = repository.get_all_places()
    return {"places": [place_to_dict(p) for p in places]}


@router.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}
