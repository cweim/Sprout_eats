"""
Supabase repository - all CRUD operations with user isolation.
"""

from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

from database.supabase_client import get_supabase, delete_photo as delete_storage_photo


# =============================================================================
# Place Operations
# =============================================================================


def add_place(
    user_id: int,
    name: str,
    latitude: float,
    longitude: float,
    address: Optional[str] = None,
    google_place_id: Optional[str] = None,
    source_url: Optional[str] = None,
    source_platform: Optional[str] = None,
    source_title: Optional[str] = None,
    source_uploader: Optional[str] = None,
    source_duration: Optional[int] = None,
    source_hashtags: Optional[str] = None,
    place_types: Optional[str] = None,
    place_rating: Optional[float] = None,
    place_rating_count: Optional[int] = None,
    place_price_level: Optional[str] = None,
    place_opening_hours: Optional[str] = None,
    source_language: Optional[str] = None,
    source_transcript: Optional[str] = None,
    source_transcript_en: Optional[str] = None,
) -> Dict[str, Any]:
    """Add a new place for a user."""
    supabase = get_supabase()

    # Check for duplicate by google_place_id for this user
    if google_place_id:
        existing = (
            supabase.table("places")
            .select("*")
            .eq("user_id", user_id)
            .eq("google_place_id", google_place_id)
            .execute()
        )
        if existing.data:
            return existing.data[0]

    result = supabase.table("places").insert({
        "user_id": user_id,
        "name": name,
        "address": address,
        "latitude": latitude,
        "longitude": longitude,
        "google_place_id": google_place_id,
        "source_url": source_url,
        "source_platform": source_platform,
        "source_title": source_title,
        "source_uploader": source_uploader,
        "source_duration": source_duration,
        "source_hashtags": source_hashtags,
        "place_types": place_types,
        "place_rating": place_rating,
        "place_rating_count": place_rating_count,
        "place_price_level": place_price_level,
        "place_opening_hours": place_opening_hours,
        "source_language": source_language,
        "source_transcript": source_transcript,
        "source_transcript_en": source_transcript_en,
    }).execute()

    return result.data[0] if result.data else None


def get_all_places(user_id: int) -> List[Dict[str, Any]]:
    """Get all places for a user, ordered by created_at desc."""
    supabase = get_supabase()

    result = (
        supabase.table("places")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )

    return result.data or []


def get_place_count(user_id: int) -> int:
    """Get count of places for a user."""
    supabase = get_supabase()

    result = (
        supabase.table("places")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .execute()
    )

    return result.count or 0


def get_place_by_id(user_id: int, place_id: int) -> Optional[Dict[str, Any]]:
    """Get a place by ID (with user check)."""
    supabase = get_supabase()

    result = (
        supabase.table("places")
        .select("*")
        .eq("user_id", user_id)
        .eq("id", place_id)
        .execute()
    )

    return result.data[0] if result.data else None


def update_place(user_id: int, place_id: int, **kwargs) -> Optional[Dict[str, Any]]:
    """Update a place's fields."""
    supabase = get_supabase()

    # Filter allowed fields
    allowed_fields = {"is_visited", "notes", "name", "place_types"}
    update_data = {k: v for k, v in kwargs.items() if k in allowed_fields}

    if not update_data:
        return get_place_by_id(user_id, place_id)

    result = (
        supabase.table("places")
        .update(update_data)
        .eq("user_id", user_id)
        .eq("id", place_id)
        .execute()
    )

    return result.data[0] if result.data else None


def delete_place(user_id: int, place_id: int) -> bool:
    """Delete a place by ID."""
    supabase = get_supabase()

    result = (
        supabase.table("places")
        .delete()
        .eq("user_id", user_id)
        .eq("id", place_id)
        .execute()
    )

    return len(result.data) > 0 if result.data else False


def clear_all_places(user_id: int) -> int:
    """Delete all places for a user. Returns count deleted."""
    supabase = get_supabase()

    # Get count first
    count = get_place_count(user_id)

    supabase.table("places").delete().eq("user_id", user_id).execute()

    return count


# =============================================================================
# Review Operations
# =============================================================================


def get_review(user_id: int, place_id: int) -> Optional[Dict[str, Any]]:
    """Get review for a place with dishes and photos."""
    supabase = get_supabase()

    # Get review
    result = (
        supabase.table("reviews")
        .select("*")
        .eq("user_id", user_id)
        .eq("place_id", place_id)
        .execute()
    )

    if not result.data:
        return None

    review = result.data[0]
    review_id = review["id"]

    # Get dishes
    dishes_result = (
        supabase.table("review_dishes")
        .select("*")
        .eq("review_id", review_id)
        .order("id")
        .execute()
    )
    review["dishes"] = dishes_result.data or []

    # Get photos
    photos_result = (
        supabase.table("review_photos")
        .select("*")
        .eq("review_id", review_id)
        .order("sort_order")
        .execute()
    )
    review["photos"] = photos_result.data or []

    # Attach photos to dishes
    dish_photos = {}
    for photo in review["photos"]:
        dish_id = photo.get("dish_id")
        if dish_id:
            if dish_id not in dish_photos:
                dish_photos[dish_id] = []
            dish_photos[dish_id].append(photo)

    for dish in review["dishes"]:
        dish["photos"] = dish_photos.get(dish["id"], [])

    return review


def create_or_update_review(
    user_id: int,
    place_id: int,
    overall_rating: int,
    price_rating: int,
    overall_remarks: Optional[str] = None,
    dishes: Optional[List[dict]] = None
) -> Dict[str, Any]:
    """Create or update review for a place."""
    supabase = get_supabase()

    # Check if review exists
    existing = (
        supabase.table("reviews")
        .select("*")
        .eq("user_id", user_id)
        .eq("place_id", place_id)
        .execute()
    )

    now = datetime.utcnow().isoformat()

    if existing.data:
        # Update existing
        review_id = existing.data[0]["id"]
        supabase.table("reviews").update({
            "overall_rating": overall_rating,
            "price_rating": price_rating,
            "overall_remarks": overall_remarks,
            "updated_at": now,
        }).eq("id", review_id).execute()
    else:
        # Create new
        result = supabase.table("reviews").insert({
            "place_id": place_id,
            "user_id": user_id,
            "overall_rating": overall_rating,
            "price_rating": price_rating,
            "overall_remarks": overall_remarks,
        }).execute()
        review_id = result.data[0]["id"]

    # Handle dishes
    if dishes is not None:
        # Get existing dishes
        existing_dishes = (
            supabase.table("review_dishes")
            .select("id")
            .eq("review_id", review_id)
            .execute()
        )
        existing_dish_ids = {d["id"] for d in existing_dishes.data} if existing_dishes.data else set()
        updated_dish_ids = set()

        for dish_data in dishes:
            dish_id = dish_data.get("id")
            if dish_id and dish_id in existing_dish_ids:
                # Update existing dish
                supabase.table("review_dishes").update({
                    "dish_name": dish_data["name"],
                    "rating": dish_data["rating"],
                    "remarks": dish_data.get("remarks"),
                    "updated_at": now,
                }).eq("id", dish_id).execute()
                updated_dish_ids.add(dish_id)
            else:
                # Add new dish
                supabase.table("review_dishes").insert({
                    "review_id": review_id,
                    "dish_name": dish_data["name"],
                    "rating": dish_data["rating"],
                    "remarks": dish_data.get("remarks"),
                }).execute()

        # Delete removed dishes
        for dish_id in existing_dish_ids - updated_dish_ids:
            supabase.table("review_dishes").delete().eq("id", dish_id).execute()

    return get_review(user_id, place_id)


def delete_review(user_id: int, place_id: int) -> bool:
    """Delete review for a place (cascades to dishes and photos)."""
    supabase = get_supabase()

    # Get review first to delete associated photos from storage
    review = get_review(user_id, place_id)
    if not review:
        return False

    # Delete photos from storage
    for photo in review.get("photos", []):
        if photo.get("storage_path"):
            delete_storage_photo(photo["storage_path"])

    # Delete review (cascades to dishes and photo records)
    result = (
        supabase.table("reviews")
        .delete()
        .eq("user_id", user_id)
        .eq("place_id", place_id)
        .execute()
    )

    return len(result.data) > 0 if result.data else False


def get_all_reviews(user_id: int) -> List[Dict[str, Any]]:
    """Get all reviews for a user with place info."""
    supabase = get_supabase()

    # Get reviews with place names
    result = (
        supabase.table("reviews")
        .select("*, places(name)")
        .eq("user_id", user_id)
        .order("updated_at", desc=True)
        .execute()
    )

    reviews = result.data or []

    # Load dishes and photos for each review
    for review in reviews:
        review_id = review["id"]

        # Dishes
        dishes_result = (
            supabase.table("review_dishes")
            .select("*")
            .eq("review_id", review_id)
            .order("id")
            .execute()
        )
        review["dishes"] = dishes_result.data or []

        # Photos
        photos_result = (
            supabase.table("review_photos")
            .select("*")
            .eq("review_id", review_id)
            .order("sort_order")
            .execute()
        )
        review["photos"] = photos_result.data or []

        # Attach photos to dishes
        dish_photos = {}
        for photo in review["photos"]:
            dish_id = photo.get("dish_id")
            if dish_id:
                if dish_id not in dish_photos:
                    dish_photos[dish_id] = []
                dish_photos[dish_id].append(photo)

        for dish in review["dishes"]:
            dish["photos"] = dish_photos.get(dish["id"], [])

        # Extract place name
        if review.get("places"):
            review["place_name"] = review["places"]["name"]
            del review["places"]

    return reviews


# =============================================================================
# Dish Operations
# =============================================================================


def add_dish(review_id: int, dish_name: str, rating: int, remarks: Optional[str] = None) -> Dict[str, Any]:
    """Add a dish to a review."""
    supabase = get_supabase()

    result = supabase.table("review_dishes").insert({
        "review_id": review_id,
        "dish_name": dish_name,
        "rating": rating,
        "remarks": remarks,
    }).execute()

    return result.data[0] if result.data else None


def update_dish(dish_id: int, rating: Optional[int] = None, remarks: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Update a dish's rating or remarks."""
    supabase = get_supabase()

    update_data = {"updated_at": datetime.utcnow().isoformat()}
    if rating is not None:
        update_data["rating"] = rating
    if remarks is not None:
        update_data["remarks"] = remarks

    result = (
        supabase.table("review_dishes")
        .update(update_data)
        .eq("id", dish_id)
        .execute()
    )

    return result.data[0] if result.data else None


def delete_dish(dish_id: int) -> bool:
    """Delete a dish from a review."""
    supabase = get_supabase()

    result = supabase.table("review_dishes").delete().eq("id", dish_id).execute()
    return len(result.data) > 0 if result.data else False


# =============================================================================
# Photo Operations
# =============================================================================


def get_photo_count(review_id: int, dish_id: Optional[int] = None) -> int:
    """Get count of photos for a review or specific dish."""
    supabase = get_supabase()

    query = supabase.table("review_photos").select("id", count="exact").eq("review_id", review_id)

    if dish_id is not None:
        query = query.eq("dish_id", dish_id)
    else:
        query = query.is_("dish_id", "null")

    result = query.execute()
    return result.count or 0


def add_photo(
    review_id: int,
    file_url: str,
    storage_path: str,
    dish_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    Add a photo to a review.

    Enforces limits: max 2 per dish, max 3 overall.
    Returns None if limit exceeded.
    """
    supabase = get_supabase()

    # Check photo limits
    count = get_photo_count(review_id, dish_id)
    max_photos = 2 if dish_id else 3
    if count >= max_photos:
        return None

    result = supabase.table("review_photos").insert({
        "review_id": review_id,
        "dish_id": dish_id,
        "file_url": file_url,
        "storage_path": storage_path,
        "sort_order": count,
    }).execute()

    return result.data[0] if result.data else None


def delete_photo(photo_id: int) -> bool:
    """Delete a photo from a review (and from storage)."""
    supabase = get_supabase()

    # Get photo first for storage path
    result = supabase.table("review_photos").select("storage_path").eq("id", photo_id).execute()
    if result.data and result.data[0].get("storage_path"):
        delete_storage_photo(result.data[0]["storage_path"])

    # Delete record
    result = supabase.table("review_photos").delete().eq("id", photo_id).execute()
    return len(result.data) > 0 if result.data else False


def get_photo_by_id(photo_id: int, review_id: int) -> Optional[Dict[str, Any]]:
    """Get a photo by ID, verifying it belongs to the review."""
    supabase = get_supabase()

    result = (
        supabase.table("review_photos")
        .select("*")
        .eq("id", photo_id)
        .eq("review_id", review_id)
        .execute()
    )

    return result.data[0] if result.data else None


# =============================================================================
# Reminder Operations
# =============================================================================


def create_reminder(user_id: int, place_id: int, visited_at: datetime) -> Dict[str, Any]:
    """Create or update a review reminder for a visited place."""
    supabase = get_supabase()

    # Check if exists
    existing = (
        supabase.table("review_reminders")
        .select("*")
        .eq("user_id", user_id)
        .eq("place_id", place_id)
        .execute()
    )

    if existing.data:
        # Update
        result = (
            supabase.table("review_reminders")
            .update({
                "visited_at": visited_at.isoformat(),
                "reminder_sent": False,
            })
            .eq("user_id", user_id)
            .eq("place_id", place_id)
            .execute()
        )
    else:
        # Insert
        result = supabase.table("review_reminders").insert({
            "user_id": user_id,
            "place_id": place_id,
            "visited_at": visited_at.isoformat(),
        }).execute()

    return result.data[0] if result.data else None


def get_pending_reminders(since_hours: int = 1) -> List[Dict[str, Any]]:
    """Get reminders that should be sent (visited > since_hours ago, not sent, not opted out)."""
    supabase = get_supabase()

    cutoff = (datetime.utcnow() - timedelta(hours=since_hours)).isoformat()

    result = (
        supabase.table("review_reminders")
        .select("*")
        .lte("visited_at", cutoff)
        .eq("reminder_sent", False)
        .eq("dont_ask_again", False)
        .execute()
    )

    return result.data or []


def mark_reminder_sent(reminder_id: int) -> None:
    """Mark a reminder as sent."""
    supabase = get_supabase()

    supabase.table("review_reminders").update({
        "reminder_sent": True
    }).eq("id", reminder_id).execute()


def set_dont_ask_again(user_id: int, place_id: int) -> None:
    """Set dont_ask_again flag for a place/user."""
    supabase = get_supabase()

    # Check if exists
    existing = (
        supabase.table("review_reminders")
        .select("id")
        .eq("user_id", user_id)
        .eq("place_id", place_id)
        .execute()
    )

    if existing.data:
        supabase.table("review_reminders").update({
            "dont_ask_again": True
        }).eq("user_id", user_id).eq("place_id", place_id).execute()
    else:
        # Create a "don't ask" record
        supabase.table("review_reminders").insert({
            "user_id": user_id,
            "place_id": place_id,
            "visited_at": datetime.utcnow().isoformat(),
            "reminder_sent": True,
            "dont_ask_again": True,
        }).execute()


def get_pending_reminder(user_id: int, place_id: int) -> Optional[Dict[str, Any]]:
    """Get pending reminder for place/user if exists."""
    supabase = get_supabase()

    result = (
        supabase.table("review_reminders")
        .select("*")
        .eq("user_id", user_id)
        .eq("place_id", place_id)
        .eq("reminder_sent", False)
        .eq("dont_ask_again", False)
        .execute()
    )

    return result.data[0] if result.data else None


def reschedule_reminder(reminder_id: int) -> Optional[Dict[str, Any]]:
    """Reschedule reminder to fire again in 1 hour."""
    supabase = get_supabase()

    result = (
        supabase.table("review_reminders")
        .update({
            "visited_at": datetime.utcnow().isoformat(),
            "reminder_sent": False,
        })
        .eq("id", reminder_id)
        .execute()
    )

    return result.data[0] if result.data else None


# =============================================================================
# Review by ID (for photo uploads)
# =============================================================================


def get_review_by_id(review_id: int) -> Optional[Dict[str, Any]]:
    """Get review by ID (no user check - for internal use)."""
    supabase = get_supabase()

    result = supabase.table("reviews").select("*").eq("id", review_id).execute()
    return result.data[0] if result.data else None
