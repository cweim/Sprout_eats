"""
Supabase repository - all CRUD operations with user isolation.
"""

from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

from database.supabase_client import (
    get_supabase,
    delete_photo as delete_storage_photo,
    delete_feedback_attachment as delete_feedback_storage_attachment,
)


def _coerce_int(value: Any) -> Optional[int]:
    """Convert API numeric fields to ints before writing to integer columns."""
    if value is None:
        return None
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def ensure_user_exists(
    user_id: int,
    *,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    language_code: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Ensure a Telegram user exists in the users table."""
    supabase = get_supabase()

    result = supabase.table("users").upsert(
        {
            "id": user_id,
            "username": username,
            "first_name": first_name,
            "last_name": last_name,
            "language_code": language_code,
        }
    ).execute()

    return result.data[0] if result.data else None


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
    place_description: Optional[str] = None,
    source_language: Optional[str] = None,
    source_transcript: Optional[str] = None,
    source_transcript_en: Optional[str] = None,
    group_id: Optional[int] = None,
    saved_by_user_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Add a new place for a user or group."""
    supabase = get_supabase()

    # Deduplicate by google_place_id scoped to the correct map (personal or group).
    if google_place_id:
        query = (
            supabase.table("places")
            .select("*")
            .eq("google_place_id", google_place_id)
            .is_("deleted_at", "null")
        )
        if group_id is not None:
            query = query.eq("group_id", group_id)
        else:
            query = query.eq("user_id", user_id).is_("group_id", "null")
        existing = query.execute()
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
        "source_duration": _coerce_int(source_duration),
        "source_hashtags": source_hashtags,
        "place_types": place_types,
        "place_rating": place_rating,
        "place_rating_count": _coerce_int(place_rating_count),
        "place_price_level": place_price_level,
        "place_opening_hours": place_opening_hours,
        "place_description": place_description,
        "source_language": source_language,
        "source_transcript": source_transcript,
        "source_transcript_en": source_transcript_en,
        "group_id": group_id,
        "saved_by_user_id": saved_by_user_id,
    }).execute()

    return result.data[0] if result.data else None


def get_all_places(user_id: int, limit: Optional[int] = None, offset: int = 0) -> List[Dict[str, Any]]:
    """Get all places for a user, ordered by created_at desc."""
    supabase = get_supabase()

    query = (
        supabase.table("places")
        .select("*")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .order("created_at", desc=True)
    )
    if limit is not None:
        query = query.range(offset, offset + limit - 1)

    result = query.execute()
    return result.data or []


def get_place_count(user_id: int) -> int:
    """Get count of places for a user."""
    supabase = get_supabase()

    result = (
        supabase.table("places")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .execute()
    )

    return result.count or 0


def get_group_places(group_id: int, limit: Optional[int] = None, offset: int = 0) -> List[Dict[str, Any]]:
    """Get all active places for a group, ordered newest first with vote counts and attribution."""
    supabase = get_supabase()
    query = (
        supabase.table("places")
        .select("*")
        .eq("group_id", group_id)
        .is_("deleted_at", "null")
        .order("created_at", desc=True)
    )
    if limit is not None:
        query = query.range(offset, offset + limit - 1)
    result = query.execute()
    places = result.data or []

    # Batch-fetch user info for attribution
    user_ids = list({p["saved_by_user_id"] for p in places if p.get("saved_by_user_id")})
    user_map: Dict[int, Dict] = {}
    if user_ids:
        users_result = (
            supabase.table("users")
            .select("id, username, first_name")
            .in_("id", user_ids)
            .execute()
        )
        for u in (users_result.data or []):
            user_map[u["id"]] = u

    # Batch-fetch votes (user_id per vote for names + count)
    place_ids = [p["id"] for p in places]
    vote_rows: List[Dict] = []
    if place_ids:
        votes_result = (
            supabase.table("place_votes")
            .select("place_id, user_id")
            .in_("place_id", place_ids)
            .execute()
        )
        vote_rows = votes_result.data or []

    # Collect all voter user_ids for name lookup
    voter_user_ids = list({v["user_id"] for v in vote_rows} - set(user_ids))
    if voter_user_ids:
        voter_users_result = (
            supabase.table("users")
            .select("id, username, first_name")
            .in_("id", voter_user_ids)
            .execute()
        )
        for u in (voter_users_result.data or []):
            user_map[u["id"]] = u

    # Build per-place vote count + voter names
    vote_count_map: Dict[int, int] = {}
    vote_names_map: Dict[int, List[str]] = {}
    for v in vote_rows:
        pid = v["place_id"]
        vote_count_map[pid] = vote_count_map.get(pid, 0) + 1
        u = user_map.get(v["user_id"])
        if u:
            name = f"@{u['username']}" if u.get("username") else (u.get("first_name") or "")
            vote_names_map.setdefault(pid, []).append(name)

    # Batch-fetch visits (user_id per visit for names + count)
    visit_rows: List[Dict] = []
    if place_ids:
        visits_result = (
            supabase.table("group_place_visits")
            .select("place_id, user_id")
            .in_("place_id", place_ids)
            .execute()
        )
        visit_rows = visits_result.data or []

    # Collect visitor user_ids not yet in user_map
    visitor_user_ids = list({v["user_id"] for v in visit_rows} - set(user_map.keys()))
    if visitor_user_ids:
        visitor_users_result = (
            supabase.table("users")
            .select("id, username, first_name")
            .in_("id", visitor_user_ids)
            .execute()
        )
        for u in (visitor_users_result.data or []):
            user_map[u["id"]] = u

    # Build per-place visit count + visitor names
    visit_count_map: Dict[int, int] = {}
    visit_names_map: Dict[int, List[str]] = {}
    for v in visit_rows:
        pid = v["place_id"]
        visit_count_map[pid] = visit_count_map.get(pid, 0) + 1
        u = user_map.get(v["user_id"])
        if u:
            name = f"@{u['username']}" if u.get("username") else (u.get("first_name") or "")
            visit_names_map.setdefault(pid, []).append(name)

    for p in places:
        uid = p.get("saved_by_user_id")
        u = user_map.get(uid) if uid else None
        p["saved_by_user"] = u
        pid = p["id"]
        p["vote_count"] = vote_count_map.get(pid, 0)
        p["voters"] = vote_names_map.get(pid, [])
        p["visit_count"] = visit_count_map.get(pid, 0)
        p["visited_by"] = visit_names_map.get(pid, [])

    return places


def get_group_place_count(group_id: int) -> int:
    """Get count of active places for a group."""
    supabase = get_supabase()
    result = (
        supabase.table("places")
        .select("id", count="exact")
        .eq("group_id", group_id)
        .is_("deleted_at", "null")
        .execute()
    )
    return result.count or 0


def toggle_place_vote(place_id: int, user_id: int) -> Dict[str, Any]:
    """Toggle a vote on a group place. Returns {voted: bool, count: int}."""
    supabase = get_supabase()
    # Check if already voted
    existing = (
        supabase.table("place_votes")
        .select("id")
        .eq("place_id", place_id)
        .eq("user_id", user_id)
        .execute()
    )
    if existing.data:
        supabase.table("place_votes").delete().eq("id", existing.data[0]["id"]).execute()
        voted = False
    else:
        supabase.table("place_votes").insert({"place_id": place_id, "user_id": user_id}).execute()
        voted = True
    count_result = (
        supabase.table("place_votes")
        .select("id", count="exact")
        .eq("place_id", place_id)
        .execute()
    )
    return {"voted": voted, "count": count_result.count or 0}


def get_place_vote_count(place_id: int) -> int:
    """Get vote count for a place."""
    supabase = get_supabase()
    result = (
        supabase.table("place_votes")
        .select("id", count="exact")
        .eq("place_id", place_id)
        .execute()
    )
    return result.count or 0


def get_group_visit_count(place_id: int) -> int:
    """Get visit count for a group place."""
    supabase = get_supabase()
    result = (
        supabase.table("group_place_visits")
        .select("id", count="exact")
        .eq("place_id", place_id)
        .execute()
    )
    return result.count or 0


def toggle_group_place_visited(place_id: int) -> Dict[str, Any]:
    """Toggle is_visited on a group place (no user auth). Returns {is_visited: bool}."""
    supabase = get_supabase()
    result = supabase.table("places").select("is_visited").eq("id", place_id).execute()
    if not result.data:
        return {"is_visited": False}
    current = result.data[0].get("is_visited") or False
    new_state = not current
    supabase.table("places").update({"is_visited": new_state}).eq("id", place_id).execute()
    return {"is_visited": new_state}


def get_group_place_by_id(place_id: int) -> Optional[Dict[str, Any]]:
    """Get a group place by ID without user ownership check."""
    supabase = get_supabase()
    result = (
        supabase.table("places")
        .select("*")
        .eq("id", place_id)
        .is_("deleted_at", "null")
        .execute()
    )
    return result.data[0] if result.data else None


def toggle_group_visit(place_id: int, user_id: int) -> Dict[str, Any]:
    """Toggle a visit on a group place. Returns {visited: bool, count: int}."""
    supabase = get_supabase()
    existing = (
        supabase.table("group_place_visits")
        .select("id")
        .eq("place_id", place_id)
        .eq("user_id", user_id)
        .execute()
    )
    if existing.data:
        supabase.table("group_place_visits").delete().eq("id", existing.data[0]["id"]).execute()
        visited = False
    else:
        supabase.table("group_place_visits").insert({"place_id": place_id, "user_id": user_id}).execute()
        visited = True
    count_result = (
        supabase.table("group_place_visits")
        .select("id", count="exact")
        .eq("place_id", place_id)
        .execute()
    )
    return {"visited": visited, "count": count_result.count or 0}


def get_group_place_reviews(place_id: int) -> List[Dict[str, Any]]:
    """Get all reviews for a group place from any user, with reviewer names."""
    supabase = get_supabase()
    result = (
        supabase.table("reviews")
        .select("*")
        .eq("place_id", place_id)
        .order("created_at", desc=True)
        .execute()
    )
    reviews = result.data or []
    if not reviews:
        return []

    review_ids = [r["id"] for r in reviews]

    # Batch-fetch dishes
    dishes_result = (
        supabase.table("review_dishes")
        .select("*")
        .in_("review_id", review_ids)
        .order("id")
        .execute()
    )
    dishes_by_review: Dict[int, List] = {}
    for d in (dishes_result.data or []):
        dishes_by_review.setdefault(d["review_id"], []).append(d)

    # Batch-fetch photos
    photos_result = (
        supabase.table("review_photos")
        .select("*")
        .in_("review_id", review_ids)
        .order("sort_order")
        .execute()
    )
    photos_by_review: Dict[int, List] = {}
    dish_photos: Dict[int, List] = {}
    for ph in (photos_result.data or []):
        photos_by_review.setdefault(ph["review_id"], []).append(ph)
        if ph.get("dish_id"):
            dish_photos.setdefault(ph["dish_id"], []).append(ph)

    # Batch-fetch reviewer names
    reviewer_ids = list({r["user_id"] for r in reviews})
    reviewer_map: Dict[int, Dict] = {}
    if reviewer_ids:
        users_result = (
            supabase.table("users")
            .select("id, username, first_name")
            .in_("id", reviewer_ids)
            .execute()
        )
        for u in (users_result.data or []):
            reviewer_map[u["id"]] = u

    for review in reviews:
        rid = review["id"]
        dishes = dishes_by_review.get(rid, [])
        for dish in dishes:
            dish["photos"] = dish_photos.get(dish["id"], [])
        review["dishes"] = dishes
        review["photos"] = photos_by_review.get(rid, [])
        u = reviewer_map.get(review["user_id"])
        if u:
            review["reviewer_name"] = f"@{u['username']}" if u.get("username") else (u.get("first_name") or "")
        else:
            review["reviewer_name"] = ""

    return reviews


def get_most_recent_place(user_id: int) -> Optional[Dict[str, Any]]:
    """Get the most recently saved place for a user."""
    supabase = get_supabase()
    result = (
        supabase.table("places")
        .select("name, created_at")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def get_reviews_count(user_id: int) -> int:
    """Get count of reviews for a user."""
    supabase = get_supabase()

    result = (
        supabase.table("reviews")
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
        .is_("deleted_at", "null")
        .execute()
    )

    return result.data[0] if result.data else None


def update_place(user_id: int, place_id: int, **kwargs) -> Optional[Dict[str, Any]]:
    """Update a place's fields."""
    supabase = get_supabase()

    # Filter allowed fields
    allowed_fields = {"is_visited", "notes", "name", "place_types", "visited_at"}
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
    """Soft-delete a place by ID (sets deleted_at; row is retained in DB)."""
    supabase = get_supabase()

    result = (
        supabase.table("places")
        .update({"deleted_at": datetime.utcnow().isoformat()})
        .eq("user_id", user_id)
        .eq("id", place_id)
        .is_("deleted_at", "null")
        .execute()
    )

    return len(result.data) > 0 if result.data else False


def clear_all_places(user_id: int) -> int:
    """Soft-delete all active places for a user. Returns count soft-deleted."""
    supabase = get_supabase()

    count = get_place_count(user_id)  # already filters deleted_at IS NULL
    if count == 0:
        return 0

    supabase.table("places").update(
        {"deleted_at": datetime.utcnow().isoformat()}
    ).eq("user_id", user_id).is_("deleted_at", "null").execute()

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
    dishes: Optional[List[dict]] = None,
    sentiment: Optional[str] = None,
    food_score: Optional[int] = None,
    vibe_score: Optional[int] = None,
    value_score: Optional[int] = None,
    caption: Optional[str] = None,
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

    safe_price = price_rating if price_rating and price_rating >= 1 else None

    new_fields = {
        "sentiment": sentiment,
        "food_score": food_score,
        "vibe_score": vibe_score,
        "value_score": value_score,
        "caption": caption,
    }

    if existing.data:
        # Update existing
        review_id = existing.data[0]["id"]
        update_payload = {
            "overall_rating": overall_rating,
            "overall_remarks": overall_remarks,
            "updated_at": now,
            **new_fields,
        }
        if safe_price is not None:
            update_payload["price_rating"] = safe_price
        supabase.table("reviews").update(update_payload).eq("id", review_id).execute()
    else:
        # Create new
        insert_payload = {
            "place_id": place_id,
            "user_id": user_id,
            "overall_rating": overall_rating,
            "overall_remarks": overall_remarks,
            **new_fields,
        }
        if safe_price is not None:
            insert_payload["price_rating"] = safe_price
        result = supabase.table("reviews").insert(insert_payload).execute()
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
            dish_rating = dish_data.get("rating") or 1  # DB NOT NULL CHECK (>=1)
            if dish_id and dish_id in existing_dish_ids:
                # Update existing dish
                supabase.table("review_dishes").update({
                    "dish_name": dish_data["name"],
                    "rating": dish_rating,
                    "remarks": dish_data.get("remarks"),
                    "updated_at": now,
                }).eq("id", dish_id).execute()
                updated_dish_ids.add(dish_id)
            else:
                # Add new dish
                supabase.table("review_dishes").insert({
                    "review_id": review_id,
                    "dish_name": dish_data["name"],
                    "rating": dish_rating,
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


def get_all_reviews(user_id: int, limit: Optional[int] = None, offset: int = 0) -> List[Dict[str, Any]]:
    """Get all reviews for a user with place info."""
    supabase = get_supabase()

    # Get reviews with place names (1 query)
    query = (
        supabase.table("reviews")
        .select("*, places(name)")
        .eq("user_id", user_id)
        .order("updated_at", desc=True)
    )
    if limit is not None:
        query = query.range(offset, offset + limit - 1)
    result = query.execute()
    reviews = result.data or []
    if not reviews:
        return []

    review_ids = [r["id"] for r in reviews]

    # Batch-fetch all dishes for all review IDs (1 query)
    dishes_result = (
        supabase.table("review_dishes")
        .select("*")
        .in_("review_id", review_ids)
        .order("id")
        .execute()
    )
    dishes_by_review: Dict[int, List] = {}
    for dish in (dishes_result.data or []):
        dishes_by_review.setdefault(dish["review_id"], []).append(dish)

    # Batch-fetch all photos for all review IDs (1 query)
    photos_result = (
        supabase.table("review_photos")
        .select("*")
        .in_("review_id", review_ids)
        .order("sort_order")
        .execute()
    )
    photos_by_review: Dict[int, List] = {}
    for photo in (photos_result.data or []):
        photos_by_review.setdefault(photo["review_id"], []).append(photo)

    # Join in Python
    for review in reviews:
        review_id = review["id"]
        review["dishes"] = dishes_by_review.get(review_id, [])
        review["photos"] = photos_by_review.get(review_id, [])

        # Attach photos to dishes
        dish_photos: Dict[int, List] = {}
        for photo in review["photos"]:
            dish_id = photo.get("dish_id")
            if dish_id:
                dish_photos.setdefault(dish_id, []).append(photo)
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
    """Get photo count for a review, filtered by dish_id (None = overall photos only)."""
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

    # Check photo limits (route already checks, but guard here too)
    count = get_photo_count(review_id, dish_id)
    max_photos = 10
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


def get_review_by_id(review_id: int, user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """Get review by ID. Pass user_id to enforce ownership check."""
    supabase = get_supabase()

    query = supabase.table("reviews").select("*").eq("id", review_id)
    if user_id is not None:
        query = query.eq("user_id", user_id)
    result = query.execute()
    return result.data[0] if result.data else None


# =============================================================================
# Feedback Operations
# =============================================================================


def create_feedback_report(
    user_id: int,
    category: str,
    source: str,
    title: Optional[str] = None,
    body: Optional[str] = None,
    source_link: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Create a new feedback report."""
    supabase = get_supabase()
    now = datetime.utcnow().isoformat()
    result = supabase.table("feedback_reports").insert({
        "user_id": user_id,
        "category": category,
        "source": source,
        "title": title,
        "body": body,
        "source_link": source_link,
        "created_at": now,
        "updated_at": now,
    }).execute()
    return result.data[0] if result.data else None


def append_feedback_attachment(
    report_id: int,
    attachment_type: str,
    file_url: Optional[str] = None,
    storage_path: Optional[str] = None,
    text_content: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Append a structured attachment to a feedback report."""
    supabase = get_supabase()
    result = supabase.table("feedback_attachments").insert({
        "report_id": report_id,
        "attachment_type": attachment_type,
        "file_url": file_url,
        "storage_path": storage_path,
        "text_content": text_content,
    }).execute()
    return result.data[0] if result.data else None


def append_feedback_text(report_id: int, text: str) -> Optional[Dict[str, Any]]:
    """Append a text note attachment to a feedback report."""
    return append_feedback_attachment(
        report_id=report_id,
        attachment_type="text_note",
        text_content=text,
    )


def get_feedback_report(report_id: int, user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """Get feedback report with attachments."""
    supabase = get_supabase()
    query = supabase.table("feedback_reports").select("*").eq("id", report_id)
    if user_id is not None:
        query = query.eq("user_id", user_id)
    result = query.execute()
    if not result.data:
        return None

    report = result.data[0]
    attachments = (
        supabase.table("feedback_attachments")
        .select("*")
        .eq("report_id", report_id)
        .order("created_at")
        .execute()
    )
    report["attachments"] = attachments.data or []
    return report


def update_feedback_report(report_id: int, **fields) -> Optional[Dict[str, Any]]:
    """Update feedback report fields."""
    supabase = get_supabase()
    allowed_fields = {
        "status",
        "severity",
        "admin_notes",
        "resolved_at",
        "title",
        "body",
        "source_link",
        "updated_at",
    }
    update_data = {k: v for k, v in fields.items() if k in allowed_fields}
    if not update_data:
        return get_feedback_report(report_id)
    if "updated_at" not in update_data:
        update_data["updated_at"] = datetime.utcnow().isoformat()
    result = (
        supabase.table("feedback_reports")
        .update(update_data)
        .eq("id", report_id)
        .execute()
    )
    return result.data[0] if result.data else None


def list_feedback_reports(
    status: Optional[str] = None,
    category: Optional[str] = None,
    source: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    """List feedback reports with optional filters."""
    supabase = get_supabase()
    query = supabase.table("feedback_reports").select("*").order("created_at", desc=True)
    if status:
        query = query.eq("status", status)
    if category:
        query = query.eq("category", category)
    if source:
        query = query.eq("source", source)
    if search:
        search_term = f"%{search}%"
        query = query.or_(f"body.ilike.{search_term},title.ilike.{search_term},source_link.ilike.{search_term}")
    result = query.range(offset, max(offset + limit - 1, offset)).execute()
    reports = result.data or []
    if not reports:
        return []

    report_ids = [report["id"] for report in reports]
    attachments_result = (
        supabase.table("feedback_attachments")
        .select("*")
        .in_("report_id", report_ids)
        .order("created_at")
        .execute()
    )
    attachments_by_report: Dict[int, List[Dict[str, Any]]] = {}
    for attachment in attachments_result.data or []:
        attachments_by_report.setdefault(attachment["report_id"], []).append(attachment)

    for report in reports:
        report["attachments"] = attachments_by_report.get(report["id"], [])
    return reports


def get_feedback_report_count(
    status: Optional[str] = None,
    category: Optional[str] = None,
    source: Optional[str] = None,
) -> int:
    """Count feedback reports with optional filters."""
    supabase = get_supabase()
    query = supabase.table("feedback_reports").select("id", count="exact")
    if status:
        query = query.eq("status", status)
    if category:
        query = query.eq("category", category)
    if source:
        query = query.eq("source", source)
    result = query.execute()
    return result.count or 0


def delete_feedback_attachment(attachment_id: int) -> bool:
    """Delete a feedback attachment and its stored file if present."""
    supabase = get_supabase()
    result = supabase.table("feedback_attachments").select("storage_path").eq("id", attachment_id).execute()
    if result.data and result.data[0].get("storage_path"):
        delete_feedback_storage_attachment(result.data[0]["storage_path"])
    deleted = supabase.table("feedback_attachments").delete().eq("id", attachment_id).execute()
    return len(deleted.data) > 0 if deleted.data else False


def delete_feedback_report(report_id: int) -> bool:
    """Delete feedback report and any stored attachments."""
    report = get_feedback_report(report_id)
    if not report:
        return False
    for attachment in report.get("attachments", []):
        if attachment.get("storage_path"):
            delete_feedback_storage_attachment(attachment["storage_path"])
    supabase = get_supabase()
    result = supabase.table("feedback_reports").delete().eq("id", report_id).execute()
    return len(result.data) > 0 if result.data else False


# =============================================================================
# Admin Operations
# =============================================================================


def is_admin_email(email: str) -> bool:
    """Return whether the email belongs to an allowlisted admin."""
    supabase = get_supabase()
    result = supabase.table("admins").select("id").eq("email", email.lower()).execute()
    return bool(result.data)


def list_admins() -> List[Dict[str, Any]]:
    """List allowlisted admins."""
    supabase = get_supabase()
    result = supabase.table("admins").select("*").order("created_at").execute()
    return result.data or []


def get_dashboard_overview() -> Dict[str, Any]:
    """Return high-level dashboard counters from current Supabase tables."""
    supabase = get_supabase()
    since_7d = (datetime.utcnow() - timedelta(days=7)).isoformat()

    users_total = supabase.table("users").select("id", count="exact").execute().count or 0
    users_new_7d = (
        supabase.table("users").select("id", count="exact").gte("created_at", since_7d).execute().count or 0
    )
    places_total = (
        supabase.table("places").select("id", count="exact").is_("deleted_at", "null").execute().count or 0
    )
    places_visited_total = (
        supabase.table("places").select("id", count="exact").eq("is_visited", True).is_("deleted_at", "null").execute().count or 0
    )
    reviews_total = supabase.table("reviews").select("id", count="exact").execute().count or 0
    pending_reminders = (
        supabase.table("review_reminders")
        .select("id", count="exact")
        .eq("reminder_sent", False)
        .eq("dont_ask_again", False)
        .execute()
        .count or 0
    )
    feedback_total = supabase.table("feedback_reports").select("id", count="exact").execute().count or 0
    feedback_open = (
        supabase.table("feedback_reports")
        .select("id", count="exact")
        .in_("status", ["new", "triaged", "in_progress"])
        .execute()
        .count or 0
    )
    feedback_with_attachments = (
        supabase.table("feedback_attachments").select("id", count="exact").execute().count or 0
    )

    places_new_7d = (
        supabase.table("places").select("id", count="exact").gte("created_at", since_7d).is_("deleted_at", "null").execute().count or 0
    )
    failed_total = supabase.table("failed_extractions").select("id", count="exact").execute().count or 0
    failed_7d = (
        supabase.table("failed_extractions").select("id", count="exact").gte("created_at", since_7d).execute().count or 0
    )

    review_rate = round(reviews_total / places_visited_total, 4) if places_visited_total else 0.0
    visited_rate = round(places_visited_total / places_total, 4) if places_total else 0.0

    return {
        "users_total": users_total,
        "users_new_7d": users_new_7d,
        "places_total": places_total,
        "places_new_7d": places_new_7d,
        "places_visited_total": places_visited_total,
        "visited_rate": visited_rate,
        "reviews_total": reviews_total,
        "review_rate": review_rate,
        "pending_reminders": pending_reminders,
        "feedback_total": feedback_total,
        "feedback_open": feedback_open,
        "feedback_with_attachments": feedback_with_attachments,
        "failed_extractions_total": failed_total,
        "failed_extractions_7d": failed_7d,
    }


def create_app_event(
    user_id: Optional[int],
    event_name: str,
    event_source: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Persist an operational app event."""
    supabase = get_supabase()
    result = supabase.table("app_events").insert({
        "user_id": user_id,
        "event_name": event_name,
        "event_source": event_source,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "metadata": metadata or {},
    }).execute()
    return result.data[0] if result.data else None


# =============================================================================
# Bot Pending Sessions
# =============================================================================

def save_bot_session(user_id: int, session_type: str, payload: dict, ttl_hours: int = 24) -> None:
    """Upsert a bot session (replaces any existing session of the same type for this user)."""
    supabase = get_supabase()
    expires_at = (datetime.utcnow() + timedelta(hours=ttl_hours)).isoformat()
    supabase.table("bot_pending_sessions").upsert({
        "user_id": user_id,
        "session_type": session_type,
        "payload": payload,
        "expires_at": expires_at,
    }).execute()


def get_bot_session(user_id: int, session_type: str) -> Optional[dict]:
    """Fetch a non-expired bot session, or None if missing/expired."""
    supabase = get_supabase()
    now = datetime.utcnow().isoformat()
    result = (
        supabase.table("bot_pending_sessions")
        .select("payload")
        .eq("user_id", user_id)
        .eq("session_type", session_type)
        .gt("expires_at", now)
        .limit(1)
        .execute()
    )
    if result.data:
        return result.data[0]["payload"]
    return None


def delete_bot_session(user_id: int, session_type: str) -> None:
    """Delete a bot session after it's been consumed."""
    supabase = get_supabase()
    supabase.table("bot_pending_sessions").delete().eq("user_id", user_id).eq("session_type", session_type).execute()


def cleanup_expired_bot_sessions() -> int:
    """Delete all expired bot sessions. Returns count deleted."""
    supabase = get_supabase()
    now = datetime.utcnow().isoformat()
    result = supabase.table("bot_pending_sessions").delete().lt("expires_at", now).execute()
    return len(result.data) if result.data else 0


# =============================================================================
# Failed Extractions
# =============================================================================

def log_failed_extraction(
    user_id: int,
    url: str,
    *,
    platform: str = "other",
    caption_preview: str = "",
    reason: str = "no_slots",
) -> None:
    """Record a link where the bot found 0 resolved places."""
    supabase = get_supabase()
    supabase.table("failed_extractions").insert({
        "user_id": user_id,
        "url": url,
        "platform": platform,
        "caption_preview": (caption_preview or "")[:300],
        "reason": reason,
    }).execute()


def get_failed_extractions(
    *,
    platform: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict]:
    """Return failed extractions, newest first, optionally filtered by platform."""
    supabase = get_supabase()
    query = (
        supabase.table("failed_extractions")
        .select("id, user_id, url, platform, caption_preview, reason, created_at")
        .order("created_at", desc=True)
        .limit(limit)
        .offset(offset)
    )
    if platform:
        query = query.eq("platform", platform)
    result = query.execute()
    return result.data or []


def list_users_with_stats(*, limit: int = 100, offset: int = 0) -> list[dict]:
    """Return users with place/review counts, newest first."""
    supabase = get_supabase()
    result = (
        supabase.table("users")
        .select("id, username, first_name, last_name, created_at")
        .order("created_at", desc=True)
        .limit(limit)
        .offset(offset)
        .execute()
    )
    users = result.data or []
    if not users:
        return []
    user_ids = [u["id"] for u in users]
    # Place counts (active only)
    places_res = (
        supabase.table("places")
        .select("user_id", count="exact")
        .in_("user_id", user_ids)
        .is_("deleted_at", "null")
        .execute()
    )
    # Per-user counts via grouped approach: fetch all rows and count in Python
    place_rows = supabase.table("places").select("user_id").in_("user_id", user_ids).is_("deleted_at", "null").execute().data or []
    review_rows = supabase.table("reviews").select("user_id").in_("user_id", user_ids).execute().data or []
    place_counts = {}
    for row in place_rows:
        place_counts[row["user_id"]] = place_counts.get(row["user_id"], 0) + 1
    review_counts = {}
    for row in review_rows:
        review_counts[row["user_id"]] = review_counts.get(row["user_id"], 0) + 1
    for u in users:
        u["places_count"] = place_counts.get(u["id"], 0)
        u["reviews_count"] = review_counts.get(u["id"], 0)
        u["display_name"] = u.get("first_name") or u.get("username") or f"User {u['id']}"
    return users


def list_recent_places(*, limit: int = 100, offset: int = 0, platform: str | None = None) -> list[dict]:
    """Return recently saved places across all users, newest first."""
    supabase = get_supabase()
    query = (
        supabase.table("places")
        .select("id, user_id, name, address, source_platform, source_url, is_visited, created_at")
        .is_("deleted_at", "null")
        .order("created_at", desc=True)
        .limit(limit)
        .offset(offset)
    )
    if platform:
        query = query.eq("source_platform", platform)
    return query.execute().data or []


def get_recent_places_count(*, platform: str | None = None) -> int:
    supabase = get_supabase()
    query = supabase.table("places").select("id", count="exact").is_("deleted_at", "null")
    if platform:
        query = query.eq("source_platform", platform)
    return query.execute().count or 0


def get_failed_extraction_count(*, platform: str | None = None) -> int:
    """Return total count of failed extractions."""
    supabase = get_supabase()
    query = supabase.table("failed_extractions").select("id", count="exact")
    if platform:
        query = query.eq("platform", platform)
    result = query.execute()
    return result.count or 0


def get_user_places(user_id: int, *, limit: int = 100, offset: int = 0) -> list[dict]:
    """Return active places for a single user, newest first."""
    supabase = get_supabase()
    return (
        supabase.table("places")
        .select("id, name, address, google_place_id, source_platform, source_url, is_visited, created_at")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .order("created_at", desc=True)
        .limit(limit)
        .offset(offset)
        .execute()
        .data or []
    )


def list_places_grouped_by_restaurant(
    *, platform: str | None = None, limit: int = 50, offset: int = 0
) -> tuple[list[dict], int]:
    """Group active places by google_place_id (or name), return save/user counts."""
    supabase = get_supabase()
    query = (
        supabase.table("places")
        .select("id, user_id, name, address, google_place_id, source_platform, created_at")
        .is_("deleted_at", "null")
        .order("created_at", desc=True)
        .limit(5000)
    )
    if platform:
        query = query.eq("source_platform", platform)
    rows = query.execute().data or []

    # Fetch display names for all involved users
    user_ids = list({r["user_id"] for r in rows})
    user_map: dict[int, str] = {}
    if user_ids:
        users = (
            supabase.table("users")
            .select("id, first_name, username")
            .in_("id", user_ids)
            .execute()
            .data or []
        )
        for u in users:
            user_map[u["id"]] = u.get("first_name") or u.get("username") or f"User {u['id']}"

    # Aggregate by google_place_id or normalised name
    groups: dict[str, dict] = {}
    for row in rows:
        key = row.get("google_place_id") or f"name:{row['name'].lower().strip()}"
        if key not in groups:
            groups[key] = {
                "name": row["name"],
                "address": row.get("address") or "",
                "google_place_id": row.get("google_place_id"),
                "_saves": [],
                "_user_ids": set(),
                "last_saved_at": row["created_at"],
            }
        g = groups[key]
        g["_saves"].append(row)
        g["_user_ids"].add(row["user_id"])
        if row["created_at"] > g["last_saved_at"]:
            g["last_saved_at"] = row["created_at"]

    # Sort by save count desc
    ordered = sorted(groups.values(), key=lambda g: len(g["_saves"]), reverse=True)
    total = len(ordered)
    page = ordered[offset : offset + limit]

    for g in page:
        g["save_count"] = len(g["_saves"])
        g["user_count"] = len(g["_user_ids"])
        g["savers"] = [user_map.get(uid, f"User {uid}") for uid in g["_user_ids"]]
        del g["_saves"]
        del g["_user_ids"]


# =============================================================================
# Map Share Operations
# =============================================================================


def get_or_create_map_share(user_id: int) -> str:
    """Return existing share token for user, or create a new one."""
    import uuid
    supabase = get_supabase()
    result = supabase.table("map_shares").select("token").eq("user_id", user_id).execute()
    if result.data:
        return result.data[0]["token"]
    token = str(uuid.uuid4())
    supabase.table("map_shares").insert({"token": token, "user_id": user_id}).execute()
    return token


def get_map_share_owner(token: str) -> Optional[int]:
    """Return user_id for a share token, or None if invalid."""
    supabase = get_supabase()
    result = supabase.table("map_shares").select("user_id").eq("token", token).execute()
    return result.data[0]["user_id"] if result.data else None


def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    """Return user row (first_name, username, etc.) or None."""
    supabase = get_supabase()
    result = supabase.table("users").select("id, username, first_name, last_name").eq("id", user_id).execute()
    return result.data[0] if result.data else None


def count_user_places(user_id: int) -> int:
    """Return total non-deleted place count for a user."""
    supabase = get_supabase()
    result = (
        supabase.table("places")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .execute()
    )
    return result.count or 0


def get_place_reviews(user_id: int, place_id: int) -> List[Dict[str, Any]]:
    """Get all reviews by a user for a specific place, with dishes and photos."""
    supabase = get_supabase()

    result = (
        supabase.table("reviews")
        .select("*, places(name)")
        .eq("user_id", user_id)
        .eq("place_id", place_id)
        .order("updated_at", desc=True)
        .execute()
    )
    reviews = result.data or []
    if not reviews:
        return []

    review_ids = [r["id"] for r in reviews]

    dishes_result = (
        supabase.table("review_dishes")
        .select("*")
        .in_("review_id", review_ids)
        .order("id")
        .execute()
    )
    dishes_by_review: Dict[int, List] = {}
    for dish in (dishes_result.data or []):
        dishes_by_review.setdefault(dish["review_id"], []).append(dish)

    photos_result = (
        supabase.table("review_photos")
        .select("*")
        .in_("review_id", review_ids)
        .order("sort_order")
        .execute()
    )
    photos_by_review: Dict[int, List] = {}
    for photo in (photos_result.data or []):
        photos_by_review.setdefault(photo["review_id"], []).append(photo)

    for review in reviews:
        review_id = review["id"]
        review["dishes"] = dishes_by_review.get(review_id, [])
        review["photos"] = photos_by_review.get(review_id, [])

        dish_photos: Dict[int, List] = {}
        for photo in review["photos"]:
            dish_id = photo.get("dish_id")
            if dish_id:
                dish_photos.setdefault(dish_id, []).append(photo)
        for dish in review["dishes"]:
            dish["photos"] = dish_photos.get(dish["id"], [])

        if review.get("places"):
            review["place_name"] = review["places"]["name"]
            del review["places"]

    return reviews

    return page, total


# =============================================================================
# User Profile Operations
# =============================================================================

def update_user_profile(
    user_id: int,
    display_name: Optional[str] = None,
    bio: Optional[str] = None,
    is_public: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    """Update user profile fields."""
    supabase = get_supabase()
    update_data = {}
    if display_name is not None:
        update_data["display_name"] = display_name
    if bio is not None:
        update_data["bio"] = bio
    if is_public is not None:
        update_data["is_public"] = is_public
    if not update_data:
        return None
    result = supabase.table("users").update(update_data).eq("id", user_id).execute()
    return result.data[0] if result.data else None


def _get_user_stats(user_id: int, supabase) -> Dict[str, int]:
    """Compute profile stats for a user."""
    saved = supabase.table("places").select("id", count="exact").eq("user_id", user_id).is_("deleted_at", "null").is_("group_id", "null").execute()
    visited = supabase.table("places").select("id", count="exact").eq("user_id", user_id).eq("is_visited", True).is_("deleted_at", "null").is_("group_id", "null").execute()
    reviews = supabase.table("reviews").select("id", count="exact").eq("user_id", user_id).execute()
    return {
        "places_saved": saved.count or 0,
        "places_visited": visited.count or 0,
        "reviews_written": reviews.count or 0,
    }


def get_my_profile(user_id: int) -> Optional[Dict[str, Any]]:
    """Get full profile for the authenticated user (public or private)."""
    supabase = get_supabase()
    result = supabase.table("users").select(
        "id, username, first_name, last_name, display_name, bio, is_public, avatar_url, created_at"
    ).eq("id", user_id).execute()
    if not result.data:
        return None
    user = result.data[0]
    user["stats"] = _get_user_stats(user_id, supabase)
    return user


def get_public_profile(user_id: int) -> Optional[Dict[str, Any]]:
    """Get a public profile (returns None if private)."""
    supabase = get_supabase()
    result = supabase.table("users").select(
        "id, username, first_name, last_name, display_name, bio, is_public, avatar_url, created_at"
    ).eq("id", user_id).execute()
    if not result.data:
        return None
    user = result.data[0]
    if not user.get("is_public"):
        return None
    user["stats"] = _get_user_stats(user_id, supabase)
    return user


def update_user_avatar(user_id: int, avatar_url: str) -> None:
    """Store a Supabase Storage URL as the user's avatar."""
    supabase = get_supabase()
    supabase.table("users").update({"avatar_url": avatar_url}).eq("id", user_id).execute()


def search_users_by_username(query: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Search public users by Telegram username."""
    supabase = get_supabase()
    result = supabase.table("users").select(
        "id, username, first_name, display_name"
    ).eq("is_public", True).ilike("username", f"%{query}%").limit(limit).execute()
    return result.data or []


# =============================================================================
# Friendship Operations
# =============================================================================

def send_friend_request(requester_id: int, addressee_id: int) -> Optional[Dict[str, Any]]:
    """Send a friend request. Returns None if one already exists."""
    supabase = get_supabase()
    try:
        result = supabase.table("user_friendships").insert({
            "requester_id": requester_id,
            "addressee_id": addressee_id,
            "status": "pending",
        }).execute()
        return result.data[0] if result.data else None
    except Exception:
        return None


def accept_friend_request(friendship_id: str, addressee_id: int) -> Optional[Dict[str, Any]]:
    """Accept a pending request (only the addressee can accept)."""
    supabase = get_supabase()
    result = supabase.table("user_friendships").update({
        "status": "accepted",
        "updated_at": "now()",
    }).eq("id", friendship_id).eq("addressee_id", addressee_id).eq("status", "pending").execute()
    return result.data[0] if result.data else None


def decline_or_remove_friendship(friendship_id: str, user_id: int) -> bool:
    """Decline a request or remove an accepted friendship (either party)."""
    supabase = get_supabase()
    result = supabase.table("user_friendships").delete().eq("id", friendship_id).or_(
        f"requester_id.eq.{user_id},addressee_id.eq.{user_id}"
    ).execute()
    return bool(result.data)


def get_friends(user_id: int) -> List[Dict[str, Any]]:
    """Get all accepted friends with basic profile info."""
    supabase = get_supabase()
    as_req = supabase.table("user_friendships").select(
        "id, addressee_id, created_at"
    ).eq("requester_id", user_id).eq("status", "accepted").execute()
    as_addr = supabase.table("user_friendships").select(
        "id, requester_id, created_at"
    ).eq("addressee_id", user_id).eq("status", "accepted").execute()

    friend_entries = []
    for row in (as_req.data or []):
        friend_entries.append({"friendship_id": row["id"], "friend_user_id": row["addressee_id"]})
    for row in (as_addr.data or []):
        friend_entries.append({"friendship_id": row["id"], "friend_user_id": row["requester_id"]})

    if not friend_entries:
        return []

    friend_ids = [e["friend_user_id"] for e in friend_entries]
    users_result = supabase.table("users").select(
        "id, username, first_name, display_name"
    ).in_("id", friend_ids).execute()
    users_map = {u["id"]: u for u in (users_result.data or [])}

    out = []
    for entry in friend_entries:
        u = users_map.get(entry["friend_user_id"], {})
        out.append({
            "friendship_id": entry["friendship_id"],
            "user_id": entry["friend_user_id"],
            "username": u.get("username"),
            "first_name": u.get("first_name"),
            "display_name": u.get("display_name"),
        })
    return out


def get_pending_friend_requests(user_id: int) -> List[Dict[str, Any]]:
    """Get pending incoming friend requests."""
    supabase = get_supabase()
    result = supabase.table("user_friendships").select(
        "id, requester_id, created_at"
    ).eq("addressee_id", user_id).eq("status", "pending").execute()

    if not result.data:
        return []

    requester_ids = [r["requester_id"] for r in result.data]
    users_result = supabase.table("users").select(
        "id, username, first_name, display_name"
    ).in_("id", requester_ids).execute()
    users_map = {u["id"]: u for u in (users_result.data or [])}

    out = []
    for row in result.data:
        u = users_map.get(row["requester_id"], {})
        out.append({
            "friendship_id": row["id"],
            "user_id": row["requester_id"],
            "username": u.get("username"),
            "first_name": u.get("first_name"),
            "display_name": u.get("display_name"),
            "created_at": row["created_at"],
        })
    return out


def get_friend_ids(user_id: int) -> List[int]:
    """Get list of accepted friend user IDs."""
    supabase = get_supabase()
    as_req = supabase.table("user_friendships").select("addressee_id").eq("requester_id", user_id).eq("status", "accepted").execute()
    as_addr = supabase.table("user_friendships").select("requester_id").eq("addressee_id", user_id).eq("status", "accepted").execute()
    ids = [r["addressee_id"] for r in (as_req.data or [])]
    ids += [r["requester_id"] for r in (as_addr.data or [])]
    return ids


def are_friends(user_id: int, other_id: int) -> bool:
    """Check if two users are friends."""
    supabase = get_supabase()
    result = supabase.table("user_friendships").select("id").or_(
        f"and(requester_id.eq.{user_id},addressee_id.eq.{other_id}),and(requester_id.eq.{other_id},addressee_id.eq.{user_id})"
    ).eq("status", "accepted").execute()
    return bool(result.data)


def get_friendship_status(user_id: int, other_id: int) -> Optional[str]:
    """Return friendship status between two users, or None if none exists."""
    supabase = get_supabase()
    result = supabase.table("user_friendships").select("id, status, requester_id").or_(
        f"and(requester_id.eq.{user_id},addressee_id.eq.{other_id}),and(requester_id.eq.{other_id},addressee_id.eq.{user_id})"
    ).execute()
    if not result.data:
        return None
    row = result.data[0]
    status = row["status"]
    if status == "pending" and row["requester_id"] != user_id:
        return "incoming_request"
    return status


def get_friend_reviews_for_place(user_id: int, google_place_id: str) -> List[Dict[str, Any]]:
    """Get reviews written by friends for a given google_place_id."""
    supabase = get_supabase()
    friend_ids = get_friend_ids(user_id)
    if not friend_ids:
        return []

    places_result = supabase.table("places").select(
        "id, user_id, name, address"
    ).in_("user_id", friend_ids).eq("google_place_id", google_place_id).is_("deleted_at", "null").execute()
    if not places_result.data:
        return []

    place_ids = [p["id"] for p in places_result.data]
    place_map = {p["id"]: p for p in places_result.data}
    user_id_map = {p["id"]: p["user_id"] for p in places_result.data}

    reviews_result = supabase.table("reviews").select(
        "id, user_id, place_id, overall_rating, price_rating, overall_remarks, created_at"
    ).in_("place_id", place_ids).execute()

    if not reviews_result.data:
        return []

    reviewer_ids = list({r["user_id"] for r in reviews_result.data})
    users_result = supabase.table("users").select(
        "id, first_name, display_name, username"
    ).in_("id", reviewer_ids).execute()
    users_map = {u["id"]: u for u in (users_result.data or [])}

    out = []
    for r in reviews_result.data:
        u = users_map.get(r["user_id"], {})
        place = place_map.get(r["place_id"], {})
        dishes = supabase.table("review_dishes").select("dish_name, rating").eq("review_id", r["id"]).execute()
        photos = supabase.table("review_photos").select("file_url").eq("review_id", r["id"]).order("sort_order").limit(1).execute()
        out.append({
            **r,
            "reviewer_name": u.get("display_name") or u.get("first_name") or "Friend",
            "reviewer_username": u.get("username"),
            "dishes": dishes.data or [],
            "photo_url": photos.data[0]["file_url"] if photos.data else None,
            "place_name": place.get("name"),
            "place_address": place.get("address"),
        })
    return out


# =============================================================================
# Activity Feed Operations
# =============================================================================

def log_activity(
    user_id: int,
    activity_type: str,
    place_id: Optional[int] = None,
    review_id: Optional[int] = None,
    metadata: Optional[Dict] = None,
    is_public: bool = True,
) -> None:
    """Log a user activity (visited, reviewed, saved, friend_added). Non-critical."""
    supabase = get_supabase()
    try:
        supabase.table("user_activities").insert({
            "user_id": user_id,
            "activity_type": activity_type,
            "place_id": place_id,
            "review_id": review_id,
            "metadata": metadata or {},
            "is_public": is_public,
        }).execute()
    except Exception:
        pass


def get_friend_map_activity(user_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    """Get recent friend visited/saved activities with place coordinates for map display."""
    supabase = get_supabase()
    friend_ids = get_friend_ids(user_id)
    if not friend_ids:
        return []

    result = supabase.table("user_activities").select(
        "id, user_id, activity_type, place_id, metadata, created_at"
    ).in_("user_id", friend_ids).in_(
        "activity_type", ["visited", "saved"]
    ).eq("is_public", True).order(
        "created_at", desc=True
    ).limit(limit).execute()

    if not result.data:
        return []

    # Fetch unique places with coordinates
    place_ids = list({r["place_id"] for r in result.data if r.get("place_id")})
    places_result = supabase.table("places").select(
        "id, name, latitude, longitude, google_place_id, address"
    ).in_("id", place_ids).execute()
    places_map = {p["id"]: p for p in (places_result.data or [])}

    # Fetch actor names
    actor_ids = list({r["user_id"] for r in result.data})
    users_result = supabase.table("users").select(
        "id, first_name, display_name, username"
    ).in_("id", actor_ids).execute()
    users_map = {u["id"]: u for u in (users_result.data or [])}

    out = []
    for row in result.data:
        place = places_map.get(row.get("place_id"))
        if not place or not place.get("latitude") or not place.get("longitude"):
            continue
        u = users_map.get(row["user_id"], {})
        metadata = row.get("metadata") or {}
        out.append({
            "activity_type": row["activity_type"],
            "created_at": row["created_at"],
            "rating": metadata.get("rating"),
            "actor_id": row["user_id"],
            "users": {
                "first_name": u.get("display_name") or u.get("first_name") or "Friend",
                "username": u.get("username"),
            },
            "places": {
                "name": place.get("name"),
                "latitude": place.get("latitude"),
                "longitude": place.get("longitude"),
                "google_place_id": place.get("google_place_id"),
                "address": place.get("address"),
            },
        })
    return out


def get_friend_feed(user_id: int, limit: int = 20, offset: int = 0) -> List[Dict[str, Any]]:
    """Get activity feed from accepted friends."""
    supabase = get_supabase()
    friend_ids = get_friend_ids(user_id)
    if not friend_ids:
        return []

    result = supabase.table("user_activities").select(
        "id, user_id, activity_type, place_id, metadata, is_public, created_at"
    ).in_("user_id", friend_ids).eq("is_public", True).order(
        "created_at", desc=True
    ).limit(limit).offset(offset).execute()

    if not result.data:
        return []

    actor_ids = list({r["user_id"] for r in result.data})
    users_result = supabase.table("users").select(
        "id, first_name, display_name, username"
    ).in_("id", actor_ids).execute()
    users_map = {u["id"]: u for u in (users_result.data or [])}

    activity_ids = [r["id"] for r in result.data]
    likes_map = get_activity_likes(activity_ids, user_id)

    out = []
    for row in result.data:
        u = users_map.get(row["user_id"], {})
        likes = likes_map.get(row["id"], {"count": 0, "user_liked": False})
        out.append({
            **row,
            "actor_name": u.get("display_name") or u.get("first_name") or "Friend",
            "actor_username": u.get("username"),
            "likes_count": likes["count"],
            "user_liked": likes["user_liked"],
        })
    return out


# ── Log Visit (atomic: mark visited + review + activity) ──────────────

def log_visit(
    user_id: int,
    place_id: int,
    rating: Optional[int] = None,
    review_text: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Mark a place visited, optionally save review, log activity. Returns activity metadata."""
    from datetime import datetime
    supabase = get_supabase()
    visited_at = datetime.utcnow().isoformat()

    # Verify place belongs to user
    place_res = supabase.table("places").select(
        "id, name, address, google_place_id"
    ).eq("id", place_id).eq("user_id", user_id).maybe_single().execute()
    if not place_res.data:
        return None
    place_data = place_res.data

    # Mark visited
    supabase.table("places").update(
        {"is_visited": True, "visited_at": visited_at}
    ).eq("id", place_id).eq("user_id", user_id).execute()

    # Upsert review if rating or text provided
    review_id = None
    if rating is not None or review_text:
        rev_result = supabase.table("reviews").upsert(
            {
                "place_id": place_id,
                "user_id": user_id,
                "overall_rating": rating,
                "overall_remarks": review_text or "",
                "dishes": [],
            },
            on_conflict="place_id,user_id",
        ).execute()
        if rev_result.data:
            review_id = rev_result.data[0].get("id")

    # Log activity
    metadata = {
        "place_name": place_data.get("name"),
        "address": place_data.get("address"),
        "google_place_id": place_data.get("google_place_id"),
    }
    if rating is not None:
        metadata["rating"] = rating
    if review_text:
        metadata["remarks"] = review_text[:200]

    act_result = supabase.table("user_activities").insert({
        "user_id": user_id,
        "activity_type": "visited",
        "place_id": place_id,
        "review_id": review_id,
        "metadata": metadata,
        "is_public": True,
    }).execute()
    activity_id = act_result.data[0]["id"] if act_result.data else None

    return {
        "visited_at": visited_at,
        "review_id": review_id,
        "activity_id": activity_id,
        "place_name": place_data.get("name"),
        "google_place_id": place_data.get("google_place_id"),
    }


# ── Activity Likes ────────────────────────────────────────────────────

def like_activity(user_id: int, activity_id: int) -> bool:
    supabase = get_supabase()
    try:
        supabase.table("user_activity_likes").insert(
            {"user_id": user_id, "activity_id": activity_id}
        ).execute()
        return True
    except Exception:
        return False  # unique constraint: already liked


def unlike_activity(user_id: int, activity_id: int) -> bool:
    supabase = get_supabase()
    supabase.table("user_activity_likes").delete().eq(
        "user_id", user_id
    ).eq("activity_id", activity_id).execute()
    return True


def get_activity_likes(activity_ids: List[int], viewer_id: int) -> Dict[int, Dict]:
    """Return {activity_id: {count, user_liked}} for a batch of activity IDs."""
    if not activity_ids:
        return {}
    supabase = get_supabase()
    result = supabase.table("user_activity_likes").select(
        "activity_id, user_id"
    ).in_("activity_id", activity_ids).execute()

    out: Dict[int, Dict] = {aid: {"count": 0, "user_liked": False} for aid in activity_ids}
    for row in result.data or []:
        aid = row["activity_id"]
        if aid in out:
            out[aid]["count"] += 1
            if row["user_id"] == viewer_id:
                out[aid]["user_liked"] = True
    return out
