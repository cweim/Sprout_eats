from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import repository

router = APIRouter(prefix="/api")


class PlaceUpdate(BaseModel):
    """Request model for partial place updates."""
    is_visited: Optional[bool] = None
    notes: Optional[str] = None


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
        "is_visited": place.is_visited or False,
        "notes": place.notes,
    }


@router.get("/places")
async def get_places():
    """Get all saved places."""
    places = repository.get_all_places()
    return {"places": [place_to_dict(p) for p in places]}


@router.get("/places/{place_id}")
async def get_place(place_id: int):
    """Get a single place by ID."""
    place = repository.get_place_by_id(place_id)
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")
    return {"place": place_to_dict(place)}


@router.patch("/places/{place_id}")
async def update_place(place_id: int, update: PlaceUpdate):
    """
    Update a place's visited status or notes.

    Only non-None fields in the request body will be updated.
    """
    # Build kwargs from non-None fields
    update_data = {}
    if update.is_visited is not None:
        update_data['is_visited'] = update.is_visited
    if update.notes is not None:
        update_data['notes'] = update.notes

    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    place = repository.update_place(place_id, **update_data)
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")

    return {"place": place_to_dict(place)}


@router.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}
