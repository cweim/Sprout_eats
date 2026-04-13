import logging
import math
import asyncio
import httpx
from typing import Optional, List

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field

import config
from database import repository
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


@router.get("/places/nearby")
async def get_nearby_places(lat: float, lng: float, radius_km: float = 5.0):
    """
    Get places within radius of given coordinates.

    Returns places sorted by distance, with distance included.
    """
    all_places = repository.get_all_places()

    nearby = []
    for place in all_places:
        if place.latitude and place.longitude:
            dist = haversine_distance(lat, lng, place.latitude, place.longitude)
            if dist <= radius_km:
                place_dict = place_to_dict(place)
                place_dict['distance_km'] = round(dist, 2)
                nearby.append(place_dict)

    # Sort by distance
    nearby.sort(key=lambda p: p['distance_km'])

    return {"places": nearby, "count": len(nearby), "radius_km": radius_km}


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
    Update a place's name, visited status, or notes.

    Only non-None fields in the request body will be updated.
    """
    from datetime import datetime

    # Get the place before update to check visited status change
    old_place = repository.get_place_by_id(place_id)
    if not old_place:
        raise HTTPException(status_code=404, detail="Place not found")

    # Build kwargs from non-None fields
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

    place = repository.update_place(place_id, **update_data)
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")

    # If place was just marked as visited, create a reminder
    if update.is_visited is not None and update.is_visited and not old_place.is_visited:
        # Check if review already exists
        existing_review = repository.get_review(place_id)

        if not existing_review:
            # Create reminder for 1 hour from now
            # For API, we'll use user_id=1 (single-user bot)
            repository.create_reminder(
                place_id=place_id,
                user_id=1,
                visited_at=datetime.utcnow()
            )

    return {"place": place_to_dict(place)}


@router.get("/search")
async def search_places_api(q: str, max_results: int = 5):
    """
    Search Google Places API for places.

    Returns results that can be added to saved places.
    """
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
async def create_place(place: PlaceCreate):
    """
    Add a new place manually (e.g., from search results).
    """
    saved_place = repository.add_place(
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
async def delete_place(place_id: int):
    """Delete a place by ID."""
    deleted = repository.delete_place(place_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Place not found")
    return {"success": True, "message": "Place deleted"}


@router.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}


# =============================================================================
# Review Models
# =============================================================================


class DishRequest(BaseModel):
    """Request model for a dish in a review."""
    id: Optional[int] = None  # None for new dish
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


def review_to_dict(review) -> dict:
    """Convert Review model to dictionary for JSON response."""
    # Get dish photos vs overall photos
    dish_ids = {d.id for d in review.dishes} if review.dishes else set()

    overall_photos = []
    if review.photos:
        for photo in review.photos:
            if photo.dish_id is None:
                overall_photos.append({
                    "id": photo.id,
                    "url": photo.file_url,
                    "dish_id": None,
                    "sort_order": photo.sort_order
                })

    dishes = []
    if review.dishes:
        for dish in review.dishes:
            dish_photos = []
            if dish.photos:
                for photo in dish.photos:
                    dish_photos.append({
                        "id": photo.id,
                        "url": photo.file_url,
                        "dish_id": photo.dish_id
                    })
            dishes.append({
                "id": dish.id,
                "name": dish.dish_name,
                "rating": dish.rating,
                "remarks": dish.remarks,
                "updated_at": dish.updated_at.isoformat() if dish.updated_at else None,
                "photos": dish_photos
            })

    return {
        "id": review.id,
        "place_id": review.place_id,
        "overall_rating": review.overall_rating,
        "price_rating": review.price_rating,
        "overall_remarks": review.overall_remarks,
        "created_at": review.created_at.isoformat() if review.created_at else None,
        "updated_at": review.updated_at.isoformat() if review.updated_at else None,
        "dishes": dishes,
        "overall_photos": overall_photos
    }


# =============================================================================
# Review Endpoints
# =============================================================================


@router.get("/places/{place_id}/review")
async def get_review(place_id: int):
    """Get review for a place with dishes and photos."""
    review = repository.get_review(place_id)
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")
    return {"review": review_to_dict(review)}


@router.post("/places/{place_id}/review")
async def create_or_update_review(place_id: int, request: ReviewRequest):
    """Create or update review for a place."""
    # Verify place exists
    place = repository.get_place_by_id(place_id)
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")

    # Convert dishes to dict format
    dishes_data = [
        {
            "id": d.id,
            "name": d.name,
            "rating": d.rating,
            "remarks": d.remarks
        }
        for d in request.dishes
    ]

    # Create/update review (user_id hardcoded to 1 for single-user bot)
    review = repository.create_or_update_review(
        place_id=place_id,
        user_id=1,
        overall_rating=request.overall_rating,
        price_rating=request.price_rating,
        overall_remarks=request.overall_remarks,
        dishes=dishes_data
    )

    return {"review": review_to_dict(review), "message": "Review saved!"}


@router.delete("/places/{place_id}/review")
async def delete_review(place_id: int):
    """Delete review for a place."""
    deleted = repository.delete_review(place_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Review not found")
    return {"success": True, "message": "Review deleted"}


@router.get("/reviews")
async def get_all_reviews():
    """Get all reviews for the user."""
    # Hardcoded user_id=1 for single-user bot
    reviews = repository.get_all_reviews(user_id=1)

    result = []
    for review in reviews:
        review_dict = review_to_dict(review)
        # Include place name for display
        if review.place:
            review_dict["place_name"] = review.place.name
        result.append(review_dict)

    return {"reviews": result}


@router.post("/reviews/{review_id}/photos")
async def upload_photo(
    review_id: int,
    file: UploadFile = File(...),
    dish_id: Optional[int] = Form(None)
):
    """
    Upload a photo to a review.

    Photos are sent to Telegram Bot API to get a file_id,
    then stored in the database.
    """
    # Verify the review exists (get it from any place)
    # We need to find the review by ID
    from database.models import Review, SessionLocal

    with SessionLocal() as session:
        review = session.query(Review).filter_by(id=review_id).first()
        if not review:
            raise HTTPException(status_code=404, detail="Review not found")
        place_id = review.place_id

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

    # Validate Telegram configuration
    if not config.TELEGRAM_BOT_TOKEN:
        raise HTTPException(status_code=500, detail="Telegram bot token not configured")

    if not config.TELEGRAM_CHAT_ID:
        raise HTTPException(
            status_code=500,
            detail="TELEGRAM_CHAT_ID not configured in .env (get your chat ID from @userinfobot)"
        )

    # Upload photo to Telegram to get file_id
    telegram_file_id = None
    file_url = None

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            # Send photo to Telegram Bot API
            url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendPhoto"

            files = {"photo": (file.filename or "photo.jpg", content, file.content_type or "image/jpeg")}
            data = {"chat_id": config.TELEGRAM_CHAT_ID}

            response = await client.post(url, data=data, files=files)
            result = response.json()

            if not result.get("ok"):
                logger.error(f"Telegram API error: {result}")
                raise HTTPException(status_code=500, detail=f"Failed to upload to Telegram: {result.get('description', 'Unknown error')}")

            # Extract file_id from the largest photo size
            photos = result["result"]["photo"]
            telegram_file_id = photos[-1]["file_id"]  # Largest size

            # Get file path from Telegram
            get_file_url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/getFile"
            file_response = await client.get(get_file_url, params={"file_id": telegram_file_id})
            file_result = file_response.json()

            if not file_result.get("ok"):
                logger.error(f"Failed to get file path: {file_result}")
                raise HTTPException(status_code=500, detail="Failed to get photo file path")

            file_path = file_result["result"]["file_path"]

            # Construct download URL
            file_url = f"https://api.telegram.org/file/bot{config.TELEGRAM_BOT_TOKEN}/{file_path}"

        except httpx.RequestError as e:
            logger.error(f"Failed to upload photo to Telegram: {e}")
            raise HTTPException(status_code=500, detail="Failed to upload photo to Telegram")

    # Store photo in database with file_id
    photo = repository.add_photo(
        review_id=review_id,
        telegram_file_id=telegram_file_id,
        dish_id=dish_id,
        file_url=file_url
    )

    if not photo:
        raise HTTPException(status_code=400, detail="Failed to add photo (limit reached?)")

    return {
        "photo": {
            "id": photo.id,
            "url": photo.file_url,
            "telegram_file_id": photo.telegram_file_id,
            "dish_id": photo.dish_id
        },
        "message": "Photo uploaded!"
    }


@router.delete("/reviews/{review_id}/photos/{photo_id}")
async def delete_photo(review_id: int, photo_id: int):
    """Delete a photo from a review."""
    # Verify photo belongs to the review
    from database.models import ReviewPhoto, SessionLocal

    with SessionLocal() as session:
        photo = session.query(ReviewPhoto).filter_by(id=photo_id, review_id=review_id).first()
        if not photo:
            raise HTTPException(status_code=404, detail="Photo not found")

    deleted = repository.delete_photo(photo_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Photo not found")

    return {"success": True, "message": "Photo deleted"}
