import logging
from typing import Optional, List
from uuid import UUID

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile, File, Form, Depends, Request
from pydantic import BaseModel, Field, field_validator

from api.telegram_auth import get_current_user, TelegramUser
from api.limiter import limiter
from database import supabase_repository as repository
from database.supabase_client import upload_photo as storage_upload_photo, delete_photo as storage_delete_photo
from services.geo import haversine_distance
from services.places import search_place
from services.deep_links import build_webapp_url
import config as app_config
from api.analytics import ALLOWED_CLIENT_EVENTS, ALLOWED_ENTITY_TYPES, sanitise_event_metadata

logger = logging.getLogger(__name__)

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
    source_url: Optional[str] = None
    place_types: Optional[str] = None
    place_rating: Optional[float] = None
    place_rating_count: Optional[int] = None
    place_price_level: Optional[str] = None
    place_opening_hours: Optional[str] = None
    country_code: Optional[str] = None
    city: Optional[str] = None
    neighborhood: Optional[str] = None
    primary_cuisine: Optional[str] = None


class ReminderActionResponse(BaseModel):
    """Response model for reminder preference actions."""
    success: bool
    message: str


class AnalyticsEventRequest(BaseModel):
    event_name: str
    event_id: Optional[UUID] = None
    session_id: Optional[str] = None
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    metadata: dict = Field(default_factory=dict)


@router.post("/events")
@limiter.limit("120/minute")
async def record_client_event(
    request: Request,
    event: AnalyticsEventRequest,
    user: TelegramUser = Depends(get_current_user),
):
    """Accept a small, privacy-safe allowlist of Mini App interaction events."""
    if event.event_name not in ALLOWED_CLIENT_EVENTS:
        raise HTTPException(status_code=400, detail="Unsupported analytics event")
    if event.entity_type and event.entity_type not in ALLOWED_ENTITY_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported entity type")
    stored = repository.create_app_event(
        user_id=user.id,
        event_name=event.event_name,
        event_source="mini_app",
        entity_type=event.entity_type,
        entity_id=(event.entity_id or "")[:120] or None,
        metadata=sanitise_event_metadata(event.metadata),
        event_id=str(event.event_id) if event.event_id else None,
        session_id=(event.session_id or "")[:120] or None,
    )
    return {"accepted": True, "event_id": stored.get("event_id") if stored else str(event.event_id or "")}


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
        "country_code": place.get("country_code"),
        "city": place.get("city"),
        "neighborhood": place.get("neighborhood"),
        "primary_cuisine": place.get("primary_cuisine"),
        "source_language": place.get("source_language"),
        "source_transcript": place.get("source_transcript"),
        "source_transcript_en": place.get("source_transcript_en"),
        "is_visited": place.get("is_visited") or False,
        "visited_at": place.get("visited_at"),
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
    """Reject deprecated URLs that exposed guessable Telegram chat IDs."""
    raise HTTPException(status_code=410, detail="Ask the bot for a new secure Group Map link")


@router.get("/groups/{group_id}/places/{place_id}/reviews")
@limiter.limit("120/minute")
async def get_group_place_reviews(request: Request, group_id: int, place_id: int):
    raise HTTPException(status_code=410, detail="Ask the bot for a new secure Group Map link")


@router.patch("/groups/{group_id}/places/{place_id}/visited")
@limiter.limit("60/minute")
async def toggle_group_place_visited(request: Request, group_id: int, place_id: int):
    raise HTTPException(status_code=410, detail="Ask the bot for a new secure Group Map link")


def _resolve_group_share(token: str) -> int:
    group_id = repository.get_group_map_share_id(token)
    if group_id is None:
        raise HTTPException(status_code=404, detail="Group map link not found")
    return group_id


def _require_group_place(group_id: int, place_id: int):
    place = repository.get_group_place_by_id(place_id)
    if not place or int(place.get("group_id") or 0) != group_id:
        raise HTTPException(status_code=404, detail="Place not found on this group map")
    return place


@router.get("/group-shares/{token}/places")
@limiter.limit("120/minute")
async def get_group_share_places(
    request: Request,
    token: str,
    page: int = 1,
    per_page: int = 100,
):
    """Read a group map through an opaque, non-enumerable share token."""
    group_id = _resolve_group_share(token)
    try:
        repository.create_app_event(None, "shared_map_opened", "shared_link", "map", f"group:{group_id}", {"source": "group_share"})
    except Exception:
        logger.debug("Could not record group shared_map_opened", exc_info=True)
    total = repository.get_group_place_count(group_id)
    offset = (page - 1) * per_page
    places = repository.get_group_places(group_id, limit=per_page, offset=offset)
    return {
        "places": [group_place_to_dict(p) for p in places],
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": (offset + len(places)) < total,
    }


@router.get("/group-shares/{token}/places/{place_id}/reviews")
@limiter.limit("120/minute")
async def get_group_share_place_reviews(request: Request, token: str, place_id: int):
    group_id = _resolve_group_share(token)
    _require_group_place(group_id, place_id)
    reviews = repository.get_group_place_reviews(place_id)
    return {"reviews": reviews, "total": len(reviews)}


@router.patch("/group-shares/{token}/places/{place_id}/visited")
@limiter.limit("60/minute")
async def toggle_group_share_place_visited(
    request: Request,
    token: str,
    place_id: int,
    user: TelegramUser = Depends(get_current_user),
):
    group_id = _resolve_group_share(token)
    _require_group_place(group_id, place_id)
    return repository.toggle_group_place_visited(place_id)


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
    try:
        repository.create_app_event(None, "shared_map_opened", "shared_link", "map", str(user_id), {"source": "profile_share"})
    except Exception:
        logger.debug("Could not record shared_map_opened", exc_info=True)
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


@router.get("/places/discover-search")
@limiter.limit("60/minute")
async def discover_search_places(
    request: Request,
    q: str,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    user: TelegramUser = Depends(get_current_user),
):
    """Search places by name across all users (Discover tab). DB-first; caller falls back to Google."""
    if not q or len(q.strip()) < 2:
        raise HTTPException(status_code=400, detail="Query too short")
    raw = repository.search_places_global(q.strip(), limit=30)
    friend_ids = repository.get_friend_ids(user.id)

    seen_gp: set = set()
    out = []
    for place in raw:
        gp = place.get("google_place_id")
        key = gp or place.get("name", "").lower()
        if key in seen_gp:
            continue
        seen_gp.add(key)
        friends_count = repository.count_friends_at_place(friend_ids, gp) if gp else 0
        out.append({
            "name": place.get("name"),
            "address": place.get("address"),
            "latitude": place.get("latitude"),
            "longitude": place.get("longitude"),
            "google_place_id": gp,
            "place_types": place.get("place_types"),
            "place_rating": place.get("place_rating"),
            "place_price_level": place.get("place_price_level"),
            "country_code": place.get("country_code"),
            "city": place.get("city"),
            "neighborhood": place.get("neighborhood"),
            "primary_cuisine": place.get("primary_cuisine"),
            "friends_count": friends_count,
        })
        if len(out) >= 10:
            break

    return {"results": out, "count": len(out)}


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
        # Skip "visited" activity if a review exists — review endpoint already logged "reviewed"
        if not existing_review:
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
                    "country_code": p.country_code,
                    "city": p.city,
                    "neighborhood": p.neighborhood,
                    "primary_cuisine": p.primary_cuisine,
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
    background_tasks: BackgroundTasks,
    user: TelegramUser = Depends(get_current_user)
):
    """Add a new place manually."""
    outcome = repository.add_place_with_outcome(
        user_id=user.id,
        name=place.name,
        address=place.address,
        latitude=place.latitude,
        longitude=place.longitude,
        google_place_id=place.google_place_id,
        source_url=place.source_url,
        source_platform="social" if place.source_url else "manual",
        place_types=place.place_types,
        place_rating=place.place_rating,
        place_rating_count=place.place_rating_count,
        place_price_level=place.place_price_level,
        place_opening_hours=place.place_opening_hours,
        country_code=place.country_code,
        city=place.city,
        neighborhood=place.neighborhood,
        primary_cuisine=place.primary_cuisine,
    )

    # Only notify + log on new saves, not duplicates; cooldown-gated per recipient
    if outcome["created"]:
        saved_place = outcome["place"]
        repository.log_activity(
            user_id=user.id,
            activity_type="saved",
            place_id=saved_place.get("id"),
            metadata={
                "place_name": place.name,
                "address": place.address,
                "google_place_id": place.google_place_id,
            },
        )
        background_tasks.add_task(
            _notify_friends_of_activity,
            user_id=user.id,
            activity_type="save",
            place_name=place.name,
            google_place_id=place.google_place_id,
        )

    return {
        "place": place_to_dict(outcome["place"]),
        "created": outcome["created"],
        "message": "Place added!" if outcome["created"] else "Already in your saves",
    }


@router.delete("/places/{place_id}")
async def delete_place(place_id: int, user: TelegramUser = Depends(get_current_user)):
    """Delete a place by ID."""
    deleted = repository.delete_place(user.id, place_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Place not found")
    return {"success": True, "message": "Place deleted"}


# =============================================================================
# Review Models
# =============================================================================


class DishRequest(BaseModel):
    """Request model for a dish in a review."""
    id: Optional[int] = None
    name: str = Field(..., min_length=1)
    rating: Optional[int] = Field(None, ge=1, le=10)
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
    is_public: bool = True
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
    rating: Optional[int] = None
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
        "is_public": review.get("is_public", True),
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
    background_tasks: BackgroundTasks,
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
        is_public=request.is_public,
    )

    try:
        repository.create_app_event(
            user_id=user.id,
            event_name="review_submitted",
            event_source="mini_app",
            entity_type="place",
            entity_id=str(place_id),
            metadata={"google_place_id": place.get("google_place_id"), "result": "updated" if review.get("updated_at") else "created"},
        )
    except Exception:
        logger.warning("Could not record review_submitted analytics", exc_info=True)

    # Log to activity feed — pass review_id so feed can enrich with review photos/dishes
    place = repository.get_place_by_id(user.id, place_id) or repository.get_group_place_by_id(place_id)
    repository.log_activity(
        user_id=user.id,
        activity_type="reviewed",
        place_id=place_id,
        review_id=review["id"],
        is_public=request.is_public,
        metadata={
            "place_name": place.get("name") if place else None,
            "address": place.get("address") if place else None,
            "google_place_id": place.get("google_place_id") if place else None,
            "rating": request.resolved_rating(),
            "sentiment": request.sentiment,
            "remarks": (request.resolved_remarks() or "")[:100],
        },
    )

    # Notify friends — reviews always fire (high signal), resets save cooldown
    if request.is_public:
        saved_place = repository.get_place_by_id(user.id, place_id) or repository.get_group_place_by_id(place_id)
        background_tasks.add_task(
            _notify_friends_of_activity,
            user_id=user.id,
            activity_type="review",
            place_name=(saved_place.get("name") if saved_place else None) or "a place",
            google_place_id=(saved_place.get("google_place_id") if saved_place else None),
        )

    return {"review": review_to_dict(review), "message": "Review saved!"}


@router.delete("/places/{place_id}/review")
@limiter.limit("30/minute")
async def delete_review(request: Request, place_id: int, user: TelegramUser = Depends(get_current_user)):
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
    if count >= app_config.MAX_PHOTOS_PER_PLACE:
        raise HTTPException(
            status_code=400,
            detail=f"Photo limit reached ({app_config.MAX_PHOTOS_PER_PLACE} max per review)"
        )

    # Read file content and enforce size limit
    content = await file.read()
    if len(content) > app_config.MAX_PHOTO_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Photo too large (max {app_config.MAX_PHOTO_SIZE_MB}MB)")

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
    avatar_url: Optional[str] = None
    clear_avatar: bool = False
    notify_friend_activity: Optional[bool] = None

    @field_validator("avatar_url")
    @classmethod
    def validate_avatar_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        base = (app_config.SUPABASE_URL or "").rstrip("/")
        if not base or not v.startswith(base + "/storage/"):
            raise ValueError("avatar_url must be a Supabase storage URL")
        return v


@router.get("/me")
async def get_my_profile(user: TelegramUser = Depends(get_current_user)):
    """Get authenticated user's own profile with stats."""
    profile = repository.get_my_profile(user.id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {"profile": profile}


@router.patch("/me")
async def update_my_profile(update: ProfileUpdate, user: TelegramUser = Depends(get_current_user)):
    """Update display name, bio, privacy setting, or avatar URL."""
    repository.update_user_profile(
        user.id,
        display_name=update.display_name,
        bio=update.bio,
        is_public=update.is_public,
        avatar_url=update.avatar_url,
        clear_avatar=update.clear_avatar,
        notify_friend_activity=update.notify_friend_activity,
    )
    profile = repository.get_my_profile(user.id)
    return {"profile": profile}


@router.post("/me/avatar")
@limiter.limit("10/minute")
async def upload_my_avatar(
    request: Request,
    file: UploadFile = File(...),
    user: TelegramUser = Depends(get_current_user)
):
    """Upload a profile avatar image to Supabase Storage."""
    content = await file.read()
    if len(content) > app_config.MAX_AVATAR_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Avatar too large (max {app_config.MAX_AVATAR_SIZE_MB}MB)")
    try:
        from database.supabase_client import upload_avatar as storage_upload_avatar
        file_url, _ = storage_upload_avatar(
            user_id=user.id,
            file_content=content,
            filename=file.filename or "avatar.jpg"
        )
        repository.update_user_profile(user.id, avatar_url=file_url)
    except Exception as e:
        logger.error(f"Avatar upload failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload avatar")
    profile = repository.get_my_profile(user.id)
    return {"profile": profile}


@router.get("/me/stats/social")
async def get_my_social_stats(user: TelegramUser = Depends(get_current_user)):
    """Get social stats: shared discoveries and trendsetter score."""
    return repository.get_social_stats(user.id)


@router.get("/users/search")
async def search_users(q: str = "", user: TelegramUser = Depends(get_current_user)):
    """Search public users by Telegram username."""
    if len(q) < 2:
        return {"users": []}
    results = repository.search_users_by_username(q)
    results = [r for r in results if r["id"] != user.id]
    # Batch-fetch friendship statuses in one query instead of one per result
    statuses = repository.get_friendship_statuses_batch(user.id, [r["id"] for r in results])
    for r in results:
        r["friendship_status"] = statuses.get(r["id"])
    return {"users": results}


@router.get("/users/suggestions")
@limiter.limit("30/minute")
async def get_friend_suggestions(request: Request, user: TelegramUser = Depends(get_current_user)):
    """Return suggested friends based on mutual connections."""
    suggestions = repository.get_suggested_friends(user.id, limit=10)
    return {"suggestions": suggestions}


@router.get("/users/{target_user_id}/profile")
async def get_user_profile(target_user_id: int, user: TelegramUser = Depends(get_current_user)):
    """Get another user's public profile. Friend view includes place/review summary."""
    friendship_status = repository.get_friendship_status(user.id, target_user_id)
    is_friend = friendship_status == "accepted"

    # Friends can always view each other's profile regardless of is_public
    profile = repository.get_public_profile(target_user_id)
    if not profile:
        if not is_friend:
            raise HTTPException(status_code=404, detail="User not found or profile is private")
        # Accepted friend with private profile — fetch basic info without is_public gate
        profile = repository.get_basic_profile(target_user_id)
        if not profile:
            raise HTTPException(status_code=404, detail="User not found")

    response: dict = {
        "profile": profile,
        "friendship_status": friendship_status,
        "friendship_id": repository.get_friendship_id(user.id, target_user_id),
    }

    if is_friend:
        from database.supabase_client import get_supabase
        all_places = repository.get_all_places(target_user_id, limit=60)
        visited = [p for p in all_places if p.get("is_visited")]
        saved_count = len([p for p in all_places if not p.get("is_visited")])

        # Fetch review scores for friend's places (lightweight — no dishes/photos)
        _supabase = get_supabase()
        _reviews_res = _supabase.table("reviews").select(
            "place_id,food_score,vibe_score,value_score,sentiment,overall_rating,caption,is_public"
        ).eq("user_id", target_user_id).execute()
        reviews_by_place: dict = {}
        for rv in (_reviews_res.data or []):
            reviews_by_place[rv["place_id"]] = rv

        def _friend_place_dict(p: dict) -> dict:
            d = place_to_dict(p)
            rv = reviews_by_place.get(p.get("id"))
            if rv:
                d["food_score"]     = rv.get("food_score")
                d["vibe_score"]     = rv.get("vibe_score")
                d["value_score"]    = rv.get("value_score")
                d["sentiment"]      = rv.get("sentiment")
                d["overall_rating"] = rv.get("overall_rating")
                if rv.get("is_public", True):
                    d["caption"] = (rv.get("caption") or "")[:120]
            return d

        response["friend_places"] = [_friend_place_dict(p) for p in all_places[:60]]
        response["stats"] = {
            "visited_count": len(visited),
            "saved_count": saved_count,
        }
    else:
        stats = profile.get("stats", {})
        response["teaser"] = {
            "places_visited": stats.get("visited_count", 0),
            "reviews_count": stats.get("review_count", 0),
        }

    return response


# =============================================================================
# Friends Endpoints
# =============================================================================

class FriendRequestBody(BaseModel):
    target_user_id: int


class LogVisitBody(BaseModel):
    rating: Optional[int] = Field(None, ge=1, le=5)
    review_text: Optional[str] = Field(None, max_length=500)


@router.get("/friends")
@limiter.limit("60/minute")
async def list_friends(request: Request, user: TelegramUser = Depends(get_current_user)):
    """List all accepted friends."""
    friends = repository.get_friends(user.id)
    return {"friends": friends}


@router.get("/friends/requests")
@limiter.limit("60/minute")
async def get_friend_requests(request: Request, user: TelegramUser = Depends(get_current_user)):
    """Get pending incoming friend requests."""
    requests = repository.get_pending_friend_requests(user.id)
    return {"requests": requests}


@router.post("/friends/request")
@limiter.limit("20/minute")
async def send_friend_request(request: Request, body: FriendRequestBody, background_tasks: BackgroundTasks, user: TelegramUser = Depends(get_current_user)):
    """Send a friend request to another user."""
    if body.target_user_id == user.id:
        raise HTTPException(status_code=400, detail="Cannot add yourself")
    friendship = repository.send_friend_request(user.id, body.target_user_id)
    if not friendship:
        raise HTTPException(status_code=409, detail="Friend request already exists")
    background_tasks.add_task(_notify_friend_request, user.id, body.target_user_id)
    try:
        repository.create_app_event(user.id, "invite_sent", "mini_app", "invite", str(friendship.get("id")), {})
    except Exception:
        logger.warning("Could not record invite_sent analytics", exc_info=True)
    return {"friendship": friendship}


@router.post("/friends/{friendship_id}/accept")
@limiter.limit("20/minute")
async def accept_friend_request(request: Request, friendship_id: str, background_tasks: BackgroundTasks, user: TelegramUser = Depends(get_current_user)):
    """Accept an incoming friend request."""
    result = repository.accept_friend_request(friendship_id, user.id)
    if not result:
        raise HTTPException(status_code=404, detail="Request not found or already handled")
    requester_id = result.get("requester_id")
    if requester_id and requester_id != user.id:
        background_tasks.add_task(_notify_friend_accepted, user.id, requester_id)
    repository.log_activity(user.id, "friend_added", metadata={"friendship_id": friendship_id})
    try:
        repository.create_app_event(user.id, "friend_added", "mini_app", "invite", friendship_id, {})
    except Exception:
        logger.warning("Could not record friend_added analytics", exc_info=True)
    return {"friendship": result}


@router.delete("/friends/{friendship_id}")
@limiter.limit("20/minute")
async def remove_or_decline_friend(request: Request, friendship_id: str, user: TelegramUser = Depends(get_current_user)):
    """Decline a pending request or remove an accepted friendship."""
    repository.decline_or_remove_friendship(friendship_id, user.id)
    return {"ok": True}


# =============================================================================
# Feed Endpoint
# =============================================================================

@router.get("/feed")
@limiter.limit("60/minute")
async def get_feed(
    request: Request,
    page: int = 1,
    per_page: int = 20,
    user: TelegramUser = Depends(get_current_user),
):
    """Get friend activity feed."""
    offset = (page - 1) * per_page
    activities = repository.get_friend_feed(user.id, limit=per_page, offset=offset)
    return {"activities": activities, "page": page, "has_more": len(activities) == per_page}


@router.get("/friends/map-activity")
@limiter.limit("30/minute")
async def get_friends_map_activity(
    request: Request,
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


@router.get("/restaurant/{google_place_id}")
async def get_restaurant_for_deep_link(
    google_place_id: str,
    user: TelegramUser = Depends(get_current_user),
):
    """Resolve a Google Place ID for a notification/deep-link restaurant card."""
    place = repository.get_public_place_by_google_id(google_place_id)
    if not place:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    return {"place": place_to_dict(place)}


# =============================================================================
# Invite Link Helper
# =============================================================================

@router.get("/invite-link")
async def get_invite_link(user: TelegramUser = Depends(get_current_user)):
    """Generate a friend invite deeplink for this user."""
    bot_username = app_config.TELEGRAM_BOT_USERNAME or "sprout_eats_bot"
    link = f"https://t.me/{bot_username}?start=addfriend_{user.id}"
    return {"link": link, "user_id": user.id}


# =============================================================================
# Log Visit (atomic: mark visited + review + activity + notify friends)
# =============================================================================

async def _notify_friend_request(requester_id: int, target_user_id: int):
    """Notify target_user_id that requester_id sent them a friend request."""
    requester = repository.get_user_by_id(requester_id)
    if not requester:
        return
    actor = requester.get("display_name") or requester.get("first_name") or "Someone"
    bot_token = app_config.TELEGRAM_BOT_TOKEN
    if not bot_token:
        return
    text = f"👤 *{actor}* sent you a friend request on Sprout!"
    payload: dict = {"chat_id": target_user_id, "text": text, "parse_mode": "Markdown"}
    if app_config.WEBAPP_URL:
        deep_url = build_webapp_url(app_config.WEBAPP_URL, "requests", "pending")
        payload["reply_markup"] = {"inline_keyboard": [[{"text": "See request 👤", "web_app": {"url": deep_url}}]]}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
    except Exception as exc:
        logger.warning("friend request notify failed for %s: %s", target_user_id, exc)


async def _notify_friend_accepted(accepter_id: int, requester_id: int):
    """Notify requester_id that accepter_id accepted their friend request."""
    accepter = repository.get_user_by_id(accepter_id)
    if not accepter:
        return
    actor = accepter.get("display_name") or accepter.get("first_name") or "Someone"
    bot_token = app_config.TELEGRAM_BOT_TOKEN
    if not bot_token:
        return
    text = f"🎉 *{actor}* accepted your friend request!"
    payload: dict = {"chat_id": requester_id, "text": text, "parse_mode": "Markdown"}
    if app_config.WEBAPP_URL:
        payload["reply_markup"] = {"inline_keyboard": [[{"text": "Open Sprout 🌱", "web_app": {"url": app_config.WEBAPP_URL}}]]}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
    except Exception as exc:
        logger.warning("friend accepted notify failed for %s: %s", requester_id, exc)


async def _notify_activity_owner(
    activity_id: str,
    actor_id: int,
    notification_type: str,  # 'like' | 'comment'
) -> None:
    """Notify the owner of an activity when someone likes or comments. Cooldown-gated."""
    owner = repository.get_activity_owner(activity_id)
    if not owner:
        return
    owner_id = owner["user_id"]
    if owner_id == actor_id:
        return  # don't notify self
    if not owner.get("notify_friend_activity", True):
        return  # owner has notifications off

    cooldown_minutes = 60 if notification_type == "like" else 5
    if repository.is_engagement_notification_on_cooldown(activity_id, notification_type, cooldown_minutes):
        return

    actor = repository.get_user_by_id(actor_id)
    actor_name = (actor.get("display_name") or actor.get("first_name") or "Someone") if actor else "Someone"

    if notification_type == "like":
        text = f"❤️ *{actor_name}* liked your post on Sprout!"
    else:
        text = f"💬 *{actor_name}* commented on your post on Sprout!"

    bot_token = app_config.TELEGRAM_BOT_TOKEN
    if not bot_token:
        return

    app_url = build_webapp_url(app_config.WEBAPP_URL, "activity", activity_id)
    reply_markup = {"inline_keyboard": [[{"text": "View post 🌱", "web_app": {"url": app_url}}]]}

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json={
                    "chat_id": owner_id,
                    "text": text,
                    "parse_mode": "Markdown",
                    "reply_markup": reply_markup,
                },
            )
        repository.record_engagement_notification_sent(activity_id, notification_type)
    except Exception as exc:
        logger.warning("engagement notify failed owner=%s type=%s: %s", owner_id, notification_type, exc)


async def _notify_friends_of_activity(
    user_id: int,
    activity_type: str,
    place_name: str,
    google_place_id: Optional[str] = None,
):
    """Fire-and-forget: notify friends of a save, review, or visit. Saves are cooldown-gated."""
    friend_ids = repository.get_friend_ids(user_id)
    friend_ids = repository.filter_friend_activity_notification_recipients(friend_ids)
    if not friend_ids:
        return
    user = repository.get_user_by_id(user_id)
    actor = (user.get("display_name") or user.get("first_name") or "Your friend") if user else "Your friend"
    bot_token = app_config.TELEGRAM_BOT_TOKEN
    if not bot_token:
        return

    if activity_type == "save":
        text = f"🌱 *{actor}* just saved *{place_name}* to their food map!"
        btn_label = "See on Discover 🗺"
    elif activity_type == "review":
        text = f"⭐ *{actor}* reviewed *{place_name}* — check it out!"
        btn_label = "See on Discover 🗺"
    else:  # visit
        text = f"🌱 *{actor}* just visited *{place_name}*!"
        btn_label = "See on Discover 🗺"

    reply_markup = None
    if app_config.WEBAPP_URL:
        app_url = build_webapp_url(app_config.WEBAPP_URL, "tab", "home")
        reply_markup = {"inline_keyboard": [[{"text": btn_label, "web_app": {"url": app_url}}]]}

    cooldown_hours = app_config.FRIEND_NOTIFICATION_COOLDOWN_HOURS
    notified: list = []
    async with httpx.AsyncClient(timeout=5) as client:
        for fid in friend_ids:
            if activity_type == "save" and repository.is_notification_on_cooldown(user_id, fid, cooldown_hours):
                continue
            try:
                payload: dict = {"chat_id": fid, "text": text, "parse_mode": "Markdown"}
                if reply_markup:
                    payload["reply_markup"] = reply_markup
                await client.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
                notified.append(fid)
            except Exception as exc:
                logger.warning("activity notify failed for %s: %s", fid, exc)

    if notified:
        repository.record_notifications_sent(user_id, notified)


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
        _notify_friends_of_activity,
        user_id=user.id,
        activity_type="visit",
        place_name=result.get("place_name", "a place"),
        google_place_id=result.get("google_place_id"),
    )
    return {"success": True, **result}


# =============================================================================
# Activity Likes
# =============================================================================

def _require_activity_access(user_id: int, activity_id: str) -> None:
    """Raise 404 if activity not found, 403 if requester is not the owner or an accepted friend."""
    owner_id = repository.get_activity_owner(activity_id)
    if owner_id is None:
        raise HTTPException(status_code=404, detail="Activity not found")
    if owner_id != user_id:
        status = repository.get_friendship_status(user_id, owner_id)
        if status != "accepted":
            raise HTTPException(status_code=403, detail="Not authorized")


@router.get("/activities/{activity_id}/likers")
@limiter.limit("60/minute")
async def get_activity_likers(
    request: Request,
    activity_id: str,
    user: TelegramUser = Depends(get_current_user),
):
    _require_activity_access(user.id, activity_id)
    likers = repository.get_activity_likers(activity_id)
    return {"likers": likers}


@router.post("/activities/{activity_id}/like")
@limiter.limit("60/minute")
async def like_activity(
    request: Request,
    activity_id: str,
    background_tasks: BackgroundTasks,
    user: TelegramUser = Depends(get_current_user),
):
    _require_activity_access(user.id, activity_id)
    repository.like_activity(user.id, activity_id)
    background_tasks.add_task(_notify_activity_owner, activity_id, user.id, "like")
    return {"success": True}


@router.delete("/activities/{activity_id}/like")
@limiter.limit("60/minute")
async def unlike_activity(request: Request, activity_id: str, user: TelegramUser = Depends(get_current_user)):
    _require_activity_access(user.id, activity_id)
    repository.unlike_activity(user.id, activity_id)
    return {"success": True}


# =============================================================================
# Activity Comments
# =============================================================================

@router.get("/activities/{activity_id}/comments")
@limiter.limit("60/minute")
async def get_comments(
    request: Request,
    activity_id: str,
    user: TelegramUser = Depends(get_current_user),
):
    _require_activity_access(user.id, activity_id)
    comments = repository.get_activity_comments(activity_id)
    return {"comments": comments}


@router.post("/activities/{activity_id}/comments")
@limiter.limit("30/minute")
async def add_comment(
    request: Request,
    activity_id: str,
    payload: dict,
    background_tasks: BackgroundTasks,
    user: TelegramUser = Depends(get_current_user),
):
    _require_activity_access(user.id, activity_id)
    body = (payload.get("body") or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="Comment cannot be empty")
    comment = repository.add_activity_comment(user.id, activity_id, body)
    background_tasks.add_task(_notify_activity_owner, activity_id, user.id, "comment")
    return {"comment": comment}


# =============================================================================
# Collections
# =============================================================================

class CollectionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    emoji: str = Field("📍", max_length=10)
    description: Optional[str] = Field(None, max_length=500)


class CollectionUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    emoji: Optional[str] = Field(None, max_length=10)
    description: Optional[str] = Field(None, max_length=500)
    is_public: Optional[bool] = None


class CollectionAddPlace(BaseModel):
    place_id: int


class CollectionInviteMember(BaseModel):
    target_user_id: int


@router.post("/collections")
async def create_collection(
    payload: CollectionCreate,
    user: TelegramUser = Depends(get_current_user),
):
    col = repository.create_collection(
        user.id,
        payload.name.strip(),
        (payload.emoji or "📍").strip() or "📍",
        payload.description.strip() if payload.description else None,
    )
    return {"collection": col}


@router.get("/collections")
async def list_collections(user: TelegramUser = Depends(get_current_user)):
    cols = repository.get_collections(user.id)
    return {"collections": cols}


@router.get("/collections/{collection_id}")
async def get_collection(
    collection_id: int,
    user: TelegramUser = Depends(get_current_user),
):
    col = repository.get_collection(collection_id, user.id)
    if col is None:
        raise HTTPException(status_code=404, detail="Collection not found or no access")
    return {"collection": col}


@router.patch("/collections/{collection_id}")
async def update_collection(
    collection_id: int,
    payload: CollectionUpdate,
    user: TelegramUser = Depends(get_current_user),
):
    updates = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None or k == "is_public"}
    col = repository.update_collection(collection_id, user.id, **updates)
    if col is None:
        raise HTTPException(status_code=404, detail="Collection not found or no access")
    return {"collection": col}


@router.delete("/collections/{collection_id}")
async def delete_collection(
    collection_id: int,
    user: TelegramUser = Depends(get_current_user),
):
    ok = repository.delete_collection(collection_id, user.id)
    if not ok:
        raise HTTPException(status_code=403, detail="Only the owner can delete a collection")
    return {"success": True}


@router.post("/collections/{collection_id}/places")
async def add_place_to_collection(
    collection_id: int,
    payload: CollectionAddPlace,
    user: TelegramUser = Depends(get_current_user),
):
    cp = repository.add_place_to_collection(collection_id, user.id, payload.place_id)
    if cp is None:
        raise HTTPException(status_code=404, detail="Place not found or no access to collection")
    return {"collection_place": cp}


@router.delete("/collections/{collection_id}/places/{collection_place_id}")
async def remove_place_from_collection(
    collection_id: int,
    collection_place_id: int,
    user: TelegramUser = Depends(get_current_user),
):
    ok = repository.remove_place_from_collection(collection_id, user.id, collection_place_id)
    if not ok:
        raise HTTPException(status_code=403, detail="No access to this collection")
    return {"success": True}


@router.get("/collections/{collection_id}/places")
async def list_collection_places(
    collection_id: int,
    user: TelegramUser = Depends(get_current_user),
):
    places = repository.get_collection_places(collection_id, user.id)
    return {"places": places}


@router.get("/places/{place_id}/collections")
async def get_place_collections(
    place_id: int,
    user: TelegramUser = Depends(get_current_user),
):
    cols = repository.get_place_collections(user.id, place_id)
    return {"collections": cols}


@router.post("/collections/{collection_id}/members")
async def invite_member(
    collection_id: int,
    payload: CollectionInviteMember,
    user: TelegramUser = Depends(get_current_user),
):
    result = repository.invite_to_collection(collection_id, user.id, payload.target_user_id)
    if result is None:
        raise HTTPException(status_code=403, detail="No access to this collection")
    return {"result": result}


@router.delete("/collections/{collection_id}/members/{target_user_id}")
async def remove_member(
    collection_id: int,
    target_user_id: int,
    user: TelegramUser = Depends(get_current_user),
):
    ok = repository.remove_collection_member(collection_id, user.id, target_user_id)
    if not ok:
        raise HTTPException(status_code=403, detail="Cannot remove this member")
    return {"success": True}


@router.get("/users/{target_user_id}/collections")
async def get_user_public_collections(
    target_user_id: int,
    user: TelegramUser = Depends(get_current_user),
):
    cols = repository.get_public_collections(target_user_id)
    return {"collections": cols}
