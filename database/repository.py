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
