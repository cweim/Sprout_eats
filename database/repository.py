from datetime import datetime
from typing import Optional, List
from sqlalchemy.orm import joinedload
from database.models import Place, Review, ReviewDish, ReviewPhoto, ReviewReminder, SessionLocal


def add_place(
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
) -> Place:
    with SessionLocal() as session:
        # Check for duplicate by google_place_id
        if google_place_id:
            existing = session.query(Place).filter_by(google_place_id=google_place_id).first()
            if existing:
                return existing

        place = Place(
            name=name,
            address=address,
            latitude=latitude,
            longitude=longitude,
            google_place_id=google_place_id,
            source_url=source_url,
            source_platform=source_platform,
            source_title=source_title,
            source_uploader=source_uploader,
            source_duration=source_duration,
            source_hashtags=source_hashtags,
            place_types=place_types,
            place_rating=place_rating,
            place_rating_count=place_rating_count,
            place_price_level=place_price_level,
            place_opening_hours=place_opening_hours,
            source_language=source_language,
            source_transcript=source_transcript,
            source_transcript_en=source_transcript_en,
        )
        session.add(place)
        session.commit()
        session.refresh(place)
        return place


def get_all_places() -> list[Place]:
    with SessionLocal() as session:
        return session.query(Place).order_by(Place.created_at.desc()).all()


def get_place_count() -> int:
    with SessionLocal() as session:
        return session.query(Place).count()


def clear_all_places() -> int:
    with SessionLocal() as session:
        count = session.query(Place).delete()
        session.commit()
        return count


def get_place_by_id(place_id: int) -> Optional[Place]:
    """Get a place by its database ID."""
    with SessionLocal() as session:
        return session.query(Place).filter_by(id=place_id).first()


def delete_place(place_id: int) -> bool:
    """
    Delete a place by its database ID.

    Returns:
        True if place was deleted, False if place not found.
    """
    with SessionLocal() as session:
        place = session.query(Place).filter_by(id=place_id).first()
        if place:
            session.delete(place)
            session.commit()
            return True
        return False


def update_place(place_id: int, **kwargs) -> Optional[Place]:
    """
    Update a place with the given fields.

    Args:
        place_id: The database ID of the place to update.
        **kwargs: Fields to update (is_visited, notes, etc.)

    Returns:
        Updated Place object, or None if place not found.
    """
    with SessionLocal() as session:
        place = session.query(Place).filter_by(id=place_id).first()
        if not place:
            return None

        # Update allowed fields
        allowed_fields = {'is_visited', 'notes'}
        for key, value in kwargs.items():
            if key in allowed_fields and hasattr(place, key):
                setattr(place, key, value)

        session.commit()
        session.refresh(place)
        return place


# =============================================================================
# Review Repository Methods
# =============================================================================


def get_review(place_id: int) -> Optional[Review]:
    """Get review for a place with dishes and photos eagerly loaded."""
    with SessionLocal() as session:
        review = (
            session.query(Review)
            .options(
                joinedload(Review.dishes).joinedload(ReviewDish.photos),
                joinedload(Review.photos)
            )
            .filter_by(place_id=place_id)
            .first()
        )
        if review:
            # Detach from session to allow access after session closes
            session.expunge_all()
        return review


def create_or_update_review(
    place_id: int,
    user_id: int,
    overall_rating: int,
    price_rating: int,
    overall_remarks: Optional[str] = None,
    dishes: Optional[List[dict]] = None
) -> Review:
    """
    Create or update review for a place.

    Args:
        place_id: ID of the place
        user_id: ID of the user
        overall_rating: 1-5 star rating
        price_rating: 1-5 price rating
        overall_remarks: Optional text remarks
        dishes: List of dish dicts with keys: id (optional), name, rating, remarks (optional)

    Returns:
        Created or updated Review object
    """
    with SessionLocal() as session:
        # Check if review exists
        review = session.query(Review).filter_by(place_id=place_id).first()

        if review:
            # Update existing review
            review.overall_rating = overall_rating
            review.price_rating = price_rating
            review.overall_remarks = overall_remarks
            review.updated_at = datetime.utcnow()
        else:
            # Create new review
            review = Review(
                place_id=place_id,
                user_id=user_id,
                overall_rating=overall_rating,
                price_rating=price_rating,
                overall_remarks=overall_remarks
            )
            session.add(review)
            session.flush()  # Get the ID

        # Handle dishes if provided
        if dishes is not None:
            existing_dish_ids = {d.id for d in review.dishes} if review.dishes else set()
            updated_dish_ids = set()

            for dish_data in dishes:
                dish_id = dish_data.get("id")
                if dish_id and dish_id in existing_dish_ids:
                    # Update existing dish
                    dish = session.query(ReviewDish).filter_by(id=dish_id).first()
                    if dish:
                        dish.dish_name = dish_data["name"]
                        dish.rating = dish_data["rating"]
                        dish.remarks = dish_data.get("remarks")
                        dish.updated_at = datetime.utcnow()
                        updated_dish_ids.add(dish_id)
                else:
                    # Add new dish
                    new_dish = ReviewDish(
                        review_id=review.id,
                        dish_name=dish_data["name"],
                        rating=dish_data["rating"],
                        remarks=dish_data.get("remarks")
                    )
                    session.add(new_dish)

            # Delete removed dishes
            for dish_id in existing_dish_ids - updated_dish_ids:
                session.query(ReviewDish).filter_by(id=dish_id).delete()

        session.commit()
        session.refresh(review)

        # Reload with relationships
        review = (
            session.query(Review)
            .options(
                joinedload(Review.dishes).joinedload(ReviewDish.photos),
                joinedload(Review.photos)
            )
            .filter_by(id=review.id)
            .first()
        )
        session.expunge_all()
        return review


def delete_review(place_id: int) -> bool:
    """Delete review for a place (cascades to dishes and photos)."""
    with SessionLocal() as session:
        review = session.query(Review).filter_by(place_id=place_id).first()
        if review:
            session.delete(review)
            session.commit()
            return True
        return False


def add_dish(review_id: int, dish_name: str, rating: int, remarks: Optional[str] = None) -> ReviewDish:
    """Add a dish to a review."""
    with SessionLocal() as session:
        dish = ReviewDish(
            review_id=review_id,
            dish_name=dish_name,
            rating=rating,
            remarks=remarks
        )
        session.add(dish)
        session.commit()
        session.refresh(dish)
        return dish


def update_dish(dish_id: int, rating: Optional[int] = None, remarks: Optional[str] = None) -> Optional[ReviewDish]:
    """Update a dish's rating or remarks."""
    with SessionLocal() as session:
        dish = session.query(ReviewDish).filter_by(id=dish_id).first()
        if not dish:
            return None

        if rating is not None:
            dish.rating = rating
        if remarks is not None:
            dish.remarks = remarks
        dish.updated_at = datetime.utcnow()

        session.commit()
        session.refresh(dish)
        return dish


def delete_dish(dish_id: int) -> bool:
    """Delete a dish from a review."""
    with SessionLocal() as session:
        dish = session.query(ReviewDish).filter_by(id=dish_id).first()
        if dish:
            session.delete(dish)
            session.commit()
            return True
        return False


def add_photo(
    review_id: int,
    telegram_file_id: str,
    dish_id: Optional[int] = None,
    file_url: Optional[str] = None
) -> Optional[ReviewPhoto]:
    """
    Add a photo to a review.

    Enforces limits: max 2 per dish, max 3 overall (no dish).
    Returns None if limit exceeded.
    """
    with SessionLocal() as session:
        # Check photo limits
        count = get_photo_count(review_id, dish_id)
        max_photos = 2 if dish_id else 3
        if count >= max_photos:
            return None

        photo = ReviewPhoto(
            review_id=review_id,
            dish_id=dish_id,
            telegram_file_id=telegram_file_id,
            file_url=file_url,
            sort_order=count  # Next in order
        )
        session.add(photo)
        session.commit()
        session.refresh(photo)
        return photo


def delete_photo(photo_id: int) -> bool:
    """Delete a photo from a review."""
    with SessionLocal() as session:
        photo = session.query(ReviewPhoto).filter_by(id=photo_id).first()
        if photo:
            session.delete(photo)
            session.commit()
            return True
        return False


def get_photo_count(review_id: int, dish_id: Optional[int] = None) -> int:
    """Get count of photos for a review or specific dish."""
    with SessionLocal() as session:
        query = session.query(ReviewPhoto).filter_by(review_id=review_id)
        if dish_id is not None:
            query = query.filter_by(dish_id=dish_id)
        else:
            query = query.filter(ReviewPhoto.dish_id.is_(None))
        return query.count()


def get_all_reviews(user_id: int) -> List[Review]:
    """Get all reviews for a user, ordered by updated_at desc."""
    with SessionLocal() as session:
        reviews = (
            session.query(Review)
            .options(
                joinedload(Review.place),
                joinedload(Review.dishes).joinedload(ReviewDish.photos),
                joinedload(Review.photos)
            )
            .filter_by(user_id=user_id)
            .order_by(Review.updated_at.desc())
            .all()
        )
        session.expunge_all()
        return reviews


# =============================================================================
# Reminder Repository Methods
# =============================================================================


def create_reminder(place_id: int, user_id: int, visited_at: datetime) -> ReviewReminder:
    """Create a review reminder for a visited place."""
    with SessionLocal() as session:
        # Check if reminder already exists
        existing = session.query(ReviewReminder).filter_by(
            place_id=place_id, user_id=user_id
        ).first()
        if existing:
            existing.visited_at = visited_at
            existing.reminder_sent = False
            session.commit()
            session.refresh(existing)
            return existing

        reminder = ReviewReminder(
            place_id=place_id,
            user_id=user_id,
            visited_at=visited_at
        )
        session.add(reminder)
        session.commit()
        session.refresh(reminder)
        return reminder


def get_pending_reminders(since_hours: int = 1) -> List[ReviewReminder]:
    """Get reminders that should be sent (visited > since_hours ago, not sent, not opted out)."""
    with SessionLocal() as session:
        from datetime import timedelta
        cutoff = datetime.utcnow() - timedelta(hours=since_hours)

        reminders = (
            session.query(ReviewReminder)
            .filter(
                ReviewReminder.visited_at <= cutoff,
                ReviewReminder.reminder_sent == False,
                ReviewReminder.dont_ask_again == False
            )
            .all()
        )
        session.expunge_all()
        return reminders


def mark_reminder_sent(reminder_id: int) -> None:
    """Mark a reminder as sent."""
    with SessionLocal() as session:
        reminder = session.query(ReviewReminder).filter_by(id=reminder_id).first()
        if reminder:
            reminder.reminder_sent = True
            session.commit()


def set_dont_ask_again(place_id: int, user_id: int) -> None:
    """Set dont_ask_again flag for a place/user."""
    with SessionLocal() as session:
        reminder = session.query(ReviewReminder).filter_by(
            place_id=place_id, user_id=user_id
        ).first()
        if reminder:
            reminder.dont_ask_again = True
            session.commit()
