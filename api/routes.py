import logging
import math
from typing import Optional, List

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Depends
from pydantic import BaseModel, Field

from api.telegram_auth import get_current_user, TelegramUser
from database import supabase_repository as repository
from database.supabase_client import upload_photo as storage_upload_photo
from services.places import search_place

logger = logging.getLogger(__name__)


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance between two points in kilometers."""
    R = 6371  # Earth radius in km
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat/2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(d_lon/2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c


router = APIRouter(prefix="/api")


@router.get("/health")
async def health_check():
    """Health check endpoint for monitoring."""
    return {"status": "ok"}


class PlaceUpdate(BaseModel):
    """Request model for partial place updates."""
    name: Optional[str] = None
    is_visited: Optional[bool] = None
    notes: Optional[str] = None
    place_types: Optional[str] = None


class PlaceCreate(BaseModel):
    """Request model for creating a new place."""
    name: str
    address: str
    latitude: float
    longitude: float
    google_place_id: Optional[str] = None
    place_types: Optional[str] = None
    place_rating: Optional[float] = None
    place_rating_count: Optional[int] = None
    place_price_level: Optional[str] = None
    place_opening_hours: Optional[str] = None


def place_to_dict(place: dict) -> dict:
    """Convert place dict for JSON response."""
    return {
        "id": place.get("id"),
        "name": place.get("name"),
        "address": place.get("address"),
        "latitude": place.get("latitude"),
        "longitude": place.get("longitude"),
        "google_place_id": place.get("google_place_id"),
        "source_url": place.get("source_url"),
        "source_platform": place.get("source_platform"),
        "created_at": place.get("created_at"),
        "source_title": place.get("source_title"),
        "source_uploader": place.get("source_uploader"),
        "source_duration": place.get("source_duration"),
        "source_hashtags": place.get("source_hashtags"),
        "place_types": place.get("place_types"),
        "place_rating": place.get("place_rating"),
        "place_rating_count": place.get("place_rating_count"),
        "place_price_level": place.get("place_price_level"),
        "place_opening_hours": place.get("place_opening_hours"),
        "source_language": place.get("source_language"),
        "source_transcript": place.get("source_transcript"),
        "source_transcript_en": place.get("source_transcript_en"),
        "is_visited": place.get("is_visited") or False,
        "notes": place.get("notes"),
    }


@router.get("/places")
async def get_places(user: TelegramUser = Depends(get_current_user)):
    """Get all saved places for current user."""
    places = repository.get_all_places(user.id)
    return {"places": [place_to_dict(p) for p in places]}


@router.get("/places/nearby")
async def get_nearby_places(
    lat: float,
    lng: float,
    radius_km: float = 5.0,
    user: TelegramUser = Depends(get_current_user)
):
    """Get places within radius of given coordinates."""
    all_places = repository.get_all_places(user.id)

    nearby = []
    for place in all_places:
        if place.get("latitude") and place.get("longitude"):
            dist = haversine_distance(lat, lng, place["latitude"], place["longitude"])
            if dist <= radius_km:
                place_dict = place_to_dict(place)
                place_dict['distance_km'] = round(dist, 2)
                nearby.append(place_dict)

    nearby.sort(key=lambda p: p['distance_km'])
    return {"places": nearby, "count": len(nearby), "radius_km": radius_km}


@router.get("/places/{place_id}")
async def get_place(place_id: int, user: TelegramUser = Depends(get_current_user)):
    """Get a single place by ID."""
    place = repository.get_place_by_id(user.id, place_id)
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")
    return {"place": place_to_dict(place)}


@router.patch("/places/{place_id}")
async def update_place(
    place_id: int,
    update: PlaceUpdate,
    user: TelegramUser = Depends(get_current_user)
):
    """Update a place's name, visited status, or notes."""
    from datetime import datetime

    old_place = repository.get_place_by_id(user.id, place_id)
    if not old_place:
        raise HTTPException(status_code=404, detail="Place not found")

    update_data = {}
    if update.name is not None:
        update_data['name'] = update.name
    if update.is_visited is not None:
        update_data['is_visited'] = update.is_visited
    if update.notes is not None:
        update_data['notes'] = update.notes
    if update.place_types is not None:
        update_data['place_types'] = update.place_types

    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    place = repository.update_place(user.id, place_id, **update_data)
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")

    # Create reminder if place just marked visited and no review exists
    if update.is_visited and not old_place.get("is_visited"):
        existing_review = repository.get_review(user.id, place_id)
        if not existing_review:
            repository.create_reminder(
                user_id=user.id,
                place_id=place_id,
                visited_at=datetime.utcnow()
            )

    return {"place": place_to_dict(place)}


@router.get("/search")
async def search_places_api(
    q: str,
    max_results: int = 5,
    user: TelegramUser = Depends(get_current_user)
):
    """Search Google Places API for places."""
    if not q or len(q) < 2:
        raise HTTPException(status_code=400, detail="Query too short")

    try:
        results = await search_place(q, max_results=max_results)

        if isinstance(results, list):
            places = results
        elif results:
            places = [results]
        else:
            places = []

        return {
            "results": [
                {
                    "name": p.name,
                    "address": p.address,
                    "latitude": p.latitude,
                    "longitude": p.longitude,
                    "google_place_id": p.place_id,
                    "place_types": ",".join(p.types) if p.types else None,
                    "place_rating": p.rating,
                    "place_rating_count": p.rating_count,
                    "place_price_level": p.price_level,
                    "place_opening_hours": p.opening_hours,
                }
                for p in places
            ],
            "count": len(places)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/places")
async def create_place(
    place: PlaceCreate,
    user: TelegramUser = Depends(get_current_user)
):
    """Add a new place manually."""
    saved_place = repository.add_place(
        user_id=user.id,
        name=place.name,
        address=place.address,
        latitude=place.latitude,
        longitude=place.longitude,
        google_place_id=place.google_place_id,
        source_url=None,
        source_platform="manual",
        place_types=place.place_types,
        place_rating=place.place_rating,
        place_rating_count=place.place_rating_count,
        place_price_level=place.place_price_level,
        place_opening_hours=place.place_opening_hours,
    )

    return {"place": place_to_dict(saved_place), "message": "Place added!"}


@router.delete("/places/{place_id}")
async def delete_place(place_id: int, user: TelegramUser = Depends(get_current_user)):
    """Delete a place by ID."""
    deleted = repository.delete_place(user.id, place_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Place not found")
    return {"success": True, "message": "Place deleted"}


@router.get("/health")
async def health_check():
    """Health check endpoint (no auth required)."""
    return {"status": "ok"}


# =============================================================================
# Review Models
# =============================================================================


class DishRequest(BaseModel):
    """Request model for a dish in a review."""
    id: Optional[int] = None
    name: str = Field(..., min_length=1)
    rating: int = Field(..., ge=1, le=5)
    remarks: Optional[str] = None


class ReviewRequest(BaseModel):
    """Request model for creating/updating a review."""
    overall_rating: int = Field(..., ge=1, le=5)
    price_rating: int = Field(..., ge=1, le=5)
    overall_remarks: Optional[str] = None
    dishes: List[DishRequest] = []


class PhotoResponse(BaseModel):
    """Response model for a photo."""
    id: int
    url: Optional[str] = None
    dish_id: Optional[int] = None


class DishResponse(BaseModel):
    """Response model for a dish in a review."""
    id: int
    name: str
    rating: int
    remarks: Optional[str] = None
    updated_at: Optional[str] = None
    photos: List[PhotoResponse] = []


class ReviewResponse(BaseModel):
    """Response model for a review."""
    id: int
    place_id: int
    overall_rating: int
    price_rating: int
    overall_remarks: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    dishes: List[DishResponse] = []
    overall_photos: List[PhotoResponse] = []


def review_to_dict(review: dict) -> dict:
    """Convert review dict for JSON response."""
    overall_photos = []
    if review.get("photos"):
        for photo in review["photos"]:
            if photo.get("dish_id") is None:
                overall_photos.append({
                    "id": photo["id"],
                    "url": photo.get("file_url"),
                    "dish_id": None,
                    "sort_order": photo.get("sort_order", 0)
                })

    dishes = []
    if review.get("dishes"):
        for dish in review["dishes"]:
            dish_photos = []
            if dish.get("photos"):
                for photo in dish["photos"]:
                    dish_photos.append({
                        "id": photo["id"],
                        "url": photo.get("file_url"),
                        "dish_id": photo.get("dish_id")
                    })
            dishes.append({
                "id": dish["id"],
                "name": dish.get("dish_name"),
                "rating": dish.get("rating"),
                "remarks": dish.get("remarks"),
                "updated_at": dish.get("updated_at"),
                "photos": dish_photos
            })

    return {
        "id": review["id"],
        "place_id": review.get("place_id"),
        "overall_rating": review.get("overall_rating"),
        "price_rating": review.get("price_rating"),
        "overall_remarks": review.get("overall_remarks"),
        "created_at": review.get("created_at"),
        "updated_at": review.get("updated_at"),
        "dishes": dishes,
        "overall_photos": overall_photos
    }


# =============================================================================
# Review Endpoints
# =============================================================================


@router.get("/places/{place_id}/review")
async def get_review(place_id: int, user: TelegramUser = Depends(get_current_user)):
    """Get review for a place with dishes and photos."""
    review = repository.get_review(user.id, place_id)
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")
    return {"review": review_to_dict(review)}


@router.post("/places/{place_id}/review")
async def create_or_update_review(
    place_id: int,
    request: ReviewRequest,
    user: TelegramUser = Depends(get_current_user)
):
    """Create or update review for a place."""
    place = repository.get_place_by_id(user.id, place_id)
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")

    dishes_data = [
        {
            "id": d.id,
            "name": d.name,
            "rating": d.rating,
            "remarks": d.remarks
        }
        for d in request.dishes
    ]

    review = repository.create_or_update_review(
        user_id=user.id,
        place_id=place_id,
        overall_rating=request.overall_rating,
        price_rating=request.price_rating,
        overall_remarks=request.overall_remarks,
        dishes=dishes_data
    )

    return {"review": review_to_dict(review), "message": "Review saved!"}


@router.delete("/places/{place_id}/review")
async def delete_review(place_id: int, user: TelegramUser = Depends(get_current_user)):
    """Delete review for a place."""
    deleted = repository.delete_review(user.id, place_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Review not found")
    return {"success": True, "message": "Review deleted"}


@router.get("/reviews")
async def get_all_reviews(user: TelegramUser = Depends(get_current_user)):
    """Get all reviews for the user."""
    reviews = repository.get_all_reviews(user.id)

    result = []
    for review in reviews:
        review_dict = review_to_dict(review)
        if review.get("place_name"):
            review_dict["place_name"] = review["place_name"]
        result.append(review_dict)

    return {"reviews": result}


@router.post("/reviews/{review_id}/photos")
async def upload_photo(
    review_id: int,
    file: UploadFile = File(...),
    dish_id: Optional[int] = Form(None),
    user: TelegramUser = Depends(get_current_user)
):
    """Upload a photo to a review (Supabase Storage)."""
    # Verify review exists and belongs to user
    review = repository.get_review_by_id(review_id)
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    if review.get("user_id") != user.id:
        raise HTTPException(status_code=403, detail="Not your review")

    # Check photo limits
    count = repository.get_photo_count(review_id, dish_id)
    max_photos = 2 if dish_id else 3
    if count >= max_photos:
        raise HTTPException(
            status_code=400,
            detail=f"Photo limit reached ({max_photos} max per {'dish' if dish_id else 'overall'})"
        )

    # Read file content
    content = await file.read()

    # Upload to Supabase Storage
    try:
        file_url, storage_path = storage_upload_photo(
            user_id=user.id,
            review_id=review_id,
            file_content=content,
            filename=file.filename or "photo.jpg"
        )
    except Exception as e:
        logger.error(f"Failed to upload photo: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload photo")

    # Store in database
    photo = repository.add_photo(
        review_id=review_id,
        file_url=file_url,
        storage_path=storage_path,
        dish_id=dish_id,
    )

    if not photo:
        raise HTTPException(status_code=400, detail="Failed to add photo (limit reached?)")

    return {
        "photo": {
            "id": photo["id"],
            "url": photo.get("file_url"),
            "dish_id": photo.get("dish_id")
        },
        "message": "Photo uploaded!"
    }


@router.delete("/reviews/{review_id}/photos/{photo_id}")
async def delete_photo(
    review_id: int,
    photo_id: int,
    user: TelegramUser = Depends(get_current_user)
):
    """Delete a photo from a review."""
    # Verify photo belongs to the review and user
    photo = repository.get_photo_by_id(photo_id, review_id)
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")

    # Verify review belongs to user
    review = repository.get_review_by_id(review_id)
    if not review or review.get("user_id") != user.id:
        raise HTTPException(status_code=403, detail="Not your review")

    deleted = repository.delete_photo(photo_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Photo not found")

    return {"success": True, "message": "Photo deleted"}
