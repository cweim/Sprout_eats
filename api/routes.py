import logging
import math
from typing import Optional, List

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile, File, Form, Depends, Request
from pydantic import BaseModel, Field

from api.telegram_auth import get_current_user, TelegramUser
from api.limiter import limiter
from database import supabase_repository as repository
from database.supabase_client import upload_photo as storage_upload_photo, delete_photo as storage_delete_photo
from services.places import search_place
import config as app_config

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


class ReminderActionResponse(BaseModel):
    """Response model for reminder preference actions."""
    success: bool
    message: str


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
        "place_description": place.get("place_description"),
        "source_language": place.get("source_language"),
        "source_transcript": place.get("source_transcript"),
        "source_transcript_en": place.get("source_transcript_en"),
        "is_visited": place.get("is_visited") or False,
        "notes": place.get("notes"),
    }


@router.get("/places")
@limiter.limit("120/minute")
async def get_places(
    request: Request,
    page: int = 1,
    per_page: int = 100,
    user: TelegramUser = Depends(get_current_user),
):
    """Get saved places for current user with pagination."""
    total = repository.get_place_count(user.id)
    offset = (page - 1) * per_page
    places = repository.get_all_places(user.id, limit=per_page, offset=offset)
    return {
        "places": [place_to_dict(p) for p in places],
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": (offset + len(places)) < total,
    }


def group_place_to_dict(place: dict) -> dict:
    """Convert group place dict for JSON response, including attribution and vote count."""
    base = place_to_dict(place)
    base["vote_count"] = place.get("vote_count", 0)
    base["visit_count"] = place.get("visit_count", 0)
    saved_by = place.get("saved_by_user") or {}
    if isinstance(saved_by, dict):
        uname = saved_by.get("username")
        fname = saved_by.get("first_name")
        base["saved_by"] = f"@{uname}" if uname else (fname or "")
    else:
        base["saved_by"] = ""
    # voters: list of display names (capped at 3 with "+N more")
    voters_raw = place.get("voters", [])
    base["voters"] = voters_raw[:3] + ([f"+{len(voters_raw) - 3} more"] if len(voters_raw) > 3 else [])
    return base


@router.get("/groups/{group_id}/places")
@limiter.limit("120/minute")
async def get_group_places(
    request: Request,
    group_id: int,
    page: int = 1,
    per_page: int = 100,
):
    """Get saved places for a Telegram group map."""
    total = repository.get_group_place_count(group_id)
    offset = (page - 1) * per_page
    places = repository.get_group_places(group_id, limit=per_page, offset=offset)
    return {
        "places": [group_place_to_dict(p) for p in places],
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": (offset + len(places)) < total,
        "group_id": group_id,
    }


@router.get("/groups/{group_id}/places/{place_id}/reviews")
@limiter.limit("120/minute")
async def get_group_place_reviews(request: Request, group_id: int, place_id: int):
    """Get all reviews for a group place."""
    reviews = repository.get_group_place_reviews(place_id)
    return {"reviews": reviews, "total": len(reviews)}


@router.patch("/groups/{group_id}/places/{place_id}/visited")
@limiter.limit("60/minute")
async def toggle_group_place_visited(request: Request, group_id: int, place_id: int):
    """Toggle visited status for a group place (no auth — group_id acts as access token)."""
    result = repository.toggle_group_place_visited(place_id)
    return result


@router.get("/my-share")
@limiter.limit("30/minute")
async def get_my_share(request: Request, user: TelegramUser = Depends(get_current_user)):
    """Return (or create) the authenticated user's permanent share token and URL."""
    token = repository.get_or_create_map_share(user.id)
    share_url = f"{app_config.WEBAPP_URL}?share={token}" if app_config.WEBAPP_URL else ""
    return {"token": token, "share_url": share_url}


@router.get("/shares/{token}/places")
@limiter.limit("60/minute")
async def get_shared_places(request: Request, token: str, page: int = 1, per_page: int = 50):
    """Return places for a shared map (no auth — token acts as access key)."""
    user_id = repository.get_map_share_owner(token)
    if not user_id:
        raise HTTPException(status_code=404, detail="Share not found")
    offset = (page - 1) * per_page
    places = repository.get_all_places(user_id, limit=per_page, offset=offset)
    total = repository.count_user_places(user_id)
    owner = repository.get_user_by_id(user_id) or {}
    return {
        "places": [place_to_dict(p) for p in places],
        "total": total,
        "has_more": (offset + per_page) < total,
        "owner_name": owner.get("first_name", ""),
        "owner_username": owner.get("username", ""),
    }


@router.get("/shares/{token}/reviews")
@limiter.limit("60/minute")
async def get_all_shared_reviews(request: Request, token: str):
    """Return all owner's reviews for a shared map."""
    user_id = repository.get_map_share_owner(token)
    if not user_id:
        raise HTTPException(status_code=404, detail="Share not found")
    reviews = repository.get_all_reviews(user_id)
    return {"reviews": reviews, "total": len(reviews)}


@router.get("/shares/{token}/places/{place_id}/reviews")
@limiter.limit("60/minute")
async def get_shared_place_reviews(request: Request, token: str, place_id: int):
    """Return owner's reviews for a single place in a shared map."""
    user_id = repository.get_map_share_owner(token)
    if not user_id:
        raise HTTPException(status_code=404, detail="Share not found")
    reviews = repository.get_place_reviews(user_id, place_id)
    return {"reviews": reviews, "total": len(reviews)}


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

    # Delete review if place just unmarked as visited
    if update.is_visited is False and old_place.get("is_visited"):
        repository.delete_review(user.id, place_id)

    # Create reminder if place just marked visited and no review exists
    if update.is_visited and not old_place.get("is_visited"):
        existing_review = repository.get_review(user.id, place_id)
        if not existing_review:
            repository.create_reminder(
                user_id=user.id,
                place_id=place_id,
                visited_at=datetime.utcnow()
            )
            repository.create_app_event(
                user_id=user.id,
                event_name="review_prompt_shown",
                event_source="mini_app",
                entity_type="place",
                entity_id=str(place_id),
                metadata={"place_name": place.get("name")},
            )
        repository.create_app_event(
            user_id=user.id,
            event_name="place_marked_visited",
            event_source="mini_app",
            entity_type="place",
            entity_id=str(place_id),
            metadata={"place_name": place.get("name")},
        )
        # Set visited_at timestamp and log to activity feed
        visited_at = datetime.utcnow().isoformat()
        repository.update_place(user.id, place_id, visited_at=visited_at)
        repository.log_activity(
            user_id=user.id,
            activity_type="visited",
            place_id=place_id,
            metadata={
                "place_name": place.get("name"),
                "address": place.get("address"),
                "google_place_id": place.get("google_place_id"),
                "place_rating": place.get("place_rating"),
            },
        )

    return {"place": place_to_dict(place)}


@router.post("/places/{place_id}/review-reminder/dont-ask", response_model=ReminderActionResponse)
async def dont_ask_review_again(
    place_id: int,
    user: TelegramUser = Depends(get_current_user)
):
    """Opt out of future review reminders for a specific place."""
    place = repository.get_place_by_id(user.id, place_id)
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")

    repository.set_dont_ask_again(user.id, place_id)
    repository.create_app_event(
        user_id=user.id,
        event_name="review_prompt_dont_ask_clicked",
        event_source="mini_app",
        entity_type="place",
        entity_id=str(place_id),
        metadata={"place_name": place.get("name")},
    )
    return {"success": True, "message": "Won't ask again for this place"}


@router.get("/search")
async def search_places_api(
    q: str,
    max_results: int = 5,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    user: TelegramUser = Depends(get_current_user)
):
    """Search Google Places API for places."""
    if not q or len(q) < 2:
        raise HTTPException(status_code=400, detail="Query too short")

    try:
        results = await search_place(q, max_results=max_results, lat=lat, lng=lng)

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
@limiter.limit("30/minute")
async def create_place(
    request: Request,
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
    rating: Optional[int] = Field(None, ge=1, le=5)
    remarks: Optional[str] = None


_SENTIMENT_TO_RATING = {"loved": 5, "okay": 3, "meh": 1}


class ReviewRequest(BaseModel):
    """Request model for creating/updating a review."""
    # New fields
    sentiment: Optional[str] = None  # "loved" | "okay" | "meh"
    food_score: Optional[int] = Field(None, ge=1, le=10)
    vibe_score: Optional[int] = Field(None, ge=1, le=10)
    value_score: Optional[int] = Field(None, ge=1, le=10)
    caption: Optional[str] = None
    # Legacy fields (kept for backwards compat; derived from sentiment when absent)
    overall_rating: Optional[int] = Field(None, ge=1, le=5)
    price_rating: int = Field(0, ge=0, le=5)
    overall_remarks: Optional[str] = None
    dishes: List[DishRequest] = []

    def resolved_rating(self) -> int:
        if self.overall_rating is not None:
            return self.overall_rating
        return _SENTIMENT_TO_RATING.get(self.sentiment or "", 3)

    def resolved_remarks(self) -> Optional[str]:
        return self.caption or self.overall_remarks


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
        "sentiment": review.get("sentiment"),
        "food_score": review.get("food_score"),
        "vibe_score": review.get("vibe_score"),
        "value_score": review.get("value_score"),
        "caption": review.get("caption"),
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
    place = repository.get_place_by_id(user.id, place_id) or repository.get_group_place_by_id(place_id)
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
        overall_rating=request.resolved_rating(),
        price_rating=request.price_rating,
        overall_remarks=request.resolved_remarks(),
        dishes=dishes_data,
        sentiment=request.sentiment,
        food_score=request.food_score,
        vibe_score=request.vibe_score,
        value_score=request.value_score,
        caption=request.caption,
    )

    # Log to activity feed
    place = repository.get_place_by_id(user.id, place_id)
    repository.log_activity(
        user_id=user.id,
        activity_type="reviewed",
        place_id=place_id,
        metadata={
            "place_name": place.get("name") if place else None,
            "address": place.get("address") if place else None,
            "google_place_id": place.get("google_place_id") if place else None,
            "rating": request.resolved_rating(),
            "sentiment": request.sentiment,
            "remarks": (request.resolved_remarks() or "")[:100],
        },
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
@limiter.limit("120/minute")
async def get_all_reviews(
    request: Request,
    page: int = 1,
    per_page: int = 50,
    user: TelegramUser = Depends(get_current_user),
):
    """Get reviews for the user with pagination."""
    total = repository.get_reviews_count(user.id)
    offset = (page - 1) * per_page
    reviews = repository.get_all_reviews(user.id, limit=per_page, offset=offset)

    result = []
    for review in reviews:
        review_dict = review_to_dict(review)
        if review.get("place_name"):
            review_dict["place_name"] = review["place_name"]
        result.append(review_dict)

    return {
        "reviews": result,
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": (offset + len(reviews)) < total,
    }


@router.post("/reviews/{review_id}/photos")
@limiter.limit("30/minute")
async def upload_photo(
    request: Request,
    review_id: int,
    file: UploadFile = File(...),
    dish_id: Optional[int] = Form(None),
    user: TelegramUser = Depends(get_current_user)
):
    """Upload a photo to a review (Supabase Storage)."""
    # Verify review exists and belongs to user (ownership enforced in query)
    review = repository.get_review_by_id(review_id, user_id=user.id)
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    # Check photo limits
    count = repository.get_photo_count(review_id, dish_id)
    max_photos = 10
    if count >= max_photos:
        raise HTTPException(
            status_code=400,
            detail=f"Photo limit reached ({max_photos} max per review)"
        )

    # Read file content and enforce size limit
    content = await file.read()
    max_size = 10 * 1024 * 1024  # 10MB
    if len(content) > max_size:
        raise HTTPException(status_code=413, detail="Photo too large (max 10MB)")

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

    # Store in database — clean up storage file if this fails
    try:
        photo = repository.add_photo(
            review_id=review_id,
            file_url=file_url,
            storage_path=storage_path,
            dish_id=dish_id,
        )
    except Exception as e:
        storage_delete_photo(storage_path)
        logger.error(f"DB insert failed after photo upload, storage file cleaned up: {e}")
        raise HTTPException(status_code=500, detail="Failed to save photo")

    if not photo:
        storage_delete_photo(storage_path)
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
        # Debug: check if photo exists at all (wrong review_id passed?)
        raw = repository.get_photo_by_id_only(photo_id)
        logger.warning(
            f"DELETE photo 404: photo_id={photo_id} review_id={review_id} "
            f"actual_photo={raw}"
        )
        raise HTTPException(status_code=404, detail="Photo not found")

    # Verify review belongs to user
    review = repository.get_review_by_id(review_id)
    if not review or review.get("user_id") != user.id:
        raise HTTPException(status_code=403, detail="Not your review")

    deleted = repository.delete_photo(photo_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Photo not found")

    return {"success": True, "message": "Photo deleted"}


# =============================================================================
# Profile Endpoints
# =============================================================================

class ProfileUpdate(BaseModel):
    display_name: Optional[str] = None
    bio: Optional[str] = None
    is_public: Optional[bool] = None


@router.get("/me")
async def get_my_profile(user: TelegramUser = Depends(get_current_user)):
    """Get authenticated user's own profile with stats."""
    profile = repository.get_my_profile(user.id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {"profile": profile}


@router.patch("/me")
async def update_my_profile(update: ProfileUpdate, user: TelegramUser = Depends(get_current_user)):
    """Update display name, bio, or privacy setting."""
    updated = repository.update_user_profile(
        user.id,
        display_name=update.display_name,
        bio=update.bio,
        is_public=update.is_public,
    )
    profile = repository.get_my_profile(user.id)
    return {"profile": profile}


@router.get("/users/search")
async def search_users(q: str = "", user: TelegramUser = Depends(get_current_user)):
    """Search public users by Telegram username."""
    if len(q) < 2:
        return {"users": []}
    results = repository.search_users_by_username(q)
    results = [r for r in results if r["id"] != user.id]
    # Annotate with friendship status
    for r in results:
        r["friendship_status"] = repository.get_friendship_status(user.id, r["id"])
    return {"users": results}


@router.get("/users/{target_user_id}/profile")
async def get_user_profile(target_user_id: int, user: TelegramUser = Depends(get_current_user)):
    """Get another user's public profile."""
    profile = repository.get_public_profile(target_user_id)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found or profile is private")
    friendship_status = repository.get_friendship_status(user.id, target_user_id)
    return {"profile": profile, "friendship_status": friendship_status}


# =============================================================================
# Friends Endpoints
# =============================================================================

class FriendRequestBody(BaseModel):
    target_user_id: int


class LogVisitBody(BaseModel):
    rating: Optional[int] = Field(None, ge=1, le=5)
    review_text: Optional[str] = Field(None, max_length=500)


@router.get("/friends")
async def list_friends(user: TelegramUser = Depends(get_current_user)):
    """List all accepted friends."""
    friends = repository.get_friends(user.id)
    return {"friends": friends}


@router.get("/friends/requests")
async def get_friend_requests(user: TelegramUser = Depends(get_current_user)):
    """Get pending incoming friend requests."""
    requests = repository.get_pending_friend_requests(user.id)
    return {"requests": requests}


@router.post("/friends/request")
async def send_friend_request(body: FriendRequestBody, user: TelegramUser = Depends(get_current_user)):
    """Send a friend request to another user."""
    if body.target_user_id == user.id:
        raise HTTPException(status_code=400, detail="Cannot add yourself")
    friendship = repository.send_friend_request(user.id, body.target_user_id)
    if not friendship:
        raise HTTPException(status_code=409, detail="Friend request already exists")
    return {"friendship": friendship}


@router.post("/friends/{friendship_id}/accept")
async def accept_friend_request(friendship_id: str, user: TelegramUser = Depends(get_current_user)):
    """Accept an incoming friend request."""
    result = repository.accept_friend_request(friendship_id, user.id)
    if not result:
        raise HTTPException(status_code=404, detail="Request not found or already handled")
    repository.log_activity(user.id, "friend_added", metadata={"friendship_id": friendship_id})
    return {"friendship": result}


@router.delete("/friends/{friendship_id}")
async def remove_or_decline_friend(friendship_id: str, user: TelegramUser = Depends(get_current_user)):
    """Decline a pending request or remove an accepted friendship."""
    repository.decline_or_remove_friendship(friendship_id, user.id)
    return {"ok": True}


# =============================================================================
# Feed Endpoint
# =============================================================================

@router.get("/feed")
async def get_feed(
    page: int = 1,
    per_page: int = 20,
    user: TelegramUser = Depends(get_current_user),
):
    """Get friend activity feed."""
    offset = (page - 1) * per_page
    activities = repository.get_friend_feed(user.id, limit=per_page, offset=offset)
    return {"activities": activities, "page": page, "has_more": len(activities) == per_page}


@router.get("/friends/map-activity")
async def get_friends_map_activity(
    user: TelegramUser = Depends(get_current_user),
):
    """Get recent friend visited/saved activities with coordinates for map pins."""
    activities = repository.get_friend_map_activity(user.id)
    return {"activities": activities}


# =============================================================================
# Restaurant Page (friend reviews for any google_place_id)
# =============================================================================

@router.get("/restaurant/{google_place_id}/friend-reviews")
async def get_friend_reviews_for_restaurant(
    google_place_id: str,
    user: TelegramUser = Depends(get_current_user),
):
    """Get friends' reviews for any restaurant by Google Place ID."""
    reviews = repository.get_friend_reviews_for_place(user.id, google_place_id)
    return {"reviews": reviews, "count": len(reviews)}


# =============================================================================
# Invite Link Helper
# =============================================================================

@router.get("/invite-link")
async def get_invite_link(user: TelegramUser = Depends(get_current_user)):
    """Generate a friend invite deeplink for this user."""
    bot_username = app_config.TELEGRAM_BOT_USERNAME
    if not bot_username:
        return {"link": None, "message": "Bot username not configured"}
    link = f"https://t.me/{bot_username}?start=addfriend_{user.id}"
    return {"link": link, "user_id": user.id}


# =============================================================================
# Log Visit (atomic: mark visited + review + activity + notify friends)
# =============================================================================

async def _notify_friends_of_visit(user_id: int, place_name: str, google_place_id: Optional[str]):
    """Fire-and-forget: send Telegram notification to all friends via Bot API."""
    friend_ids = repository.get_friend_ids(user_id)
    if not friend_ids:
        return
    user = repository.get_user_by_id(user_id)
    actor = (user.get("display_name") or user.get("first_name") or "Your friend") if user else "Your friend"
    text = f"🌱 *{actor}* just visited *{place_name}*!"
    bot_token = app_config.TELEGRAM_BOT_TOKEN
    if not bot_token:
        return

    reply_markup = None
    if app_config.WEBAPP_URL and google_place_id:
        app_url = f"{app_config.WEBAPP_URL}?startapp=gplace_{google_place_id}"
        reply_markup = {"inline_keyboard": [[{"text": "See their visit 👀", "web_app": {"url": app_url}}]]}

    async with httpx.AsyncClient(timeout=5) as client:
        for fid in friend_ids:
            try:
                payload: dict = {"chat_id": fid, "text": text, "parse_mode": "Markdown"}
                if reply_markup:
                    payload["reply_markup"] = reply_markup
                await client.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
            except Exception as exc:
                logger.warning("visit notify failed for %s: %s", fid, exc)


@router.post("/places/{place_id}/log-visit")
async def log_visit_place(
    place_id: int,
    body: LogVisitBody,
    background_tasks: BackgroundTasks,
    user: TelegramUser = Depends(get_current_user),
):
    """Atomically mark visited, save rating/review, log activity, notify friends."""
    result = repository.log_visit(
        user_id=user.id,
        place_id=place_id,
        rating=body.rating,
        review_text=body.review_text,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Place not found")

    # Notify friends in background (non-blocking)
    background_tasks.add_task(
        _notify_friends_of_visit,
        user_id=user.id,
        place_name=result.get("place_name", "a place"),
        google_place_id=result.get("google_place_id"),
    )
    return {"success": True, **result}


# =============================================================================
# Activity Likes
# =============================================================================

@router.post("/activities/{activity_id}/like")
async def like_activity(activity_id: int, user: TelegramUser = Depends(get_current_user)):
    repository.like_activity(user.id, activity_id)
    return {"success": True}


@router.delete("/activities/{activity_id}/like")
async def unlike_activity(activity_id: int, user: TelegramUser = Depends(get_current_user)):
    repository.unlike_activity(user.id, activity_id)
    return {"success": True}
