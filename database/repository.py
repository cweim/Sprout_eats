from typing import Optional
from database.models import Place, SessionLocal


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
