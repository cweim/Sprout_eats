from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Text, ForeignKey, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

import config

Base = declarative_base()


class Place(Base):
    __tablename__ = "places"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    address = Column(String)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    google_place_id = Column(String)
    source_url = Column(String)
    source_platform = Column(String)  # 'instagram' or 'tiktok'
    created_at = Column(DateTime, default=datetime.utcnow)

    # Video metadata from yt-dlp
    source_title = Column(String)  # Video title
    source_uploader = Column(String)  # Creator username
    source_duration = Column(Integer)  # Video duration in seconds
    source_hashtags = Column(String)  # Comma-separated hashtags

    # Place metadata from Google Places API
    place_types = Column(String)  # Comma-separated types like "restaurant,food"
    place_rating = Column(Float)  # 1.0-5.0
    place_rating_count = Column(Integer)  # Number of reviews
    place_price_level = Column(String)  # "FREE", "INEXPENSIVE", "MODERATE", etc.
    place_opening_hours = Column(String)  # e.g., "Monday: 9:00 AM – 10:00 PM"

    # Language/transcription metadata
    source_language = Column(String)  # ISO code like "en", "ja", "ko"
    source_transcript = Column(String)  # Original transcription text
    source_transcript_en = Column(String)  # English translation (if different)

    # User interaction fields
    is_visited = Column(Boolean, default=False)  # Has user visited this place?
    notes = Column(String, nullable=True)  # User's personal notes

    # Relationship to review (one-to-one)
    review = relationship("Review", back_populates="place", uselist=False, cascade="all, delete-orphan")

    def __repr__(self):
        return f"<Place(name='{self.name}', address='{self.address}')>"


class Review(Base):
    """User review for a place with overall rating, price rating, and dishes."""
    __tablename__ = "reviews"

    id = Column(Integer, primary_key=True)
    place_id = Column(Integer, ForeignKey("places.id", ondelete="CASCADE"), nullable=False, unique=True)
    user_id = Column(Integer, nullable=False)
    overall_rating = Column(Integer, nullable=False)  # 1-5
    price_rating = Column(Integer, nullable=False)  # 1-5
    overall_remarks = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    place = relationship("Place", back_populates="review")
    dishes = relationship("ReviewDish", back_populates="review", cascade="all, delete-orphan")
    photos = relationship("ReviewPhoto", back_populates="review", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<Review(place_id={self.place_id}, rating={self.overall_rating})>"


class ReviewDish(Base):
    """Individual dish rating within a review."""
    __tablename__ = "review_dishes"

    id = Column(Integer, primary_key=True)
    review_id = Column(Integer, ForeignKey("reviews.id", ondelete="CASCADE"), nullable=False)
    dish_name = Column(Text, nullable=False)
    rating = Column(Integer, nullable=False)  # 1-5
    remarks = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    review = relationship("Review", back_populates="dishes")
    photos = relationship("ReviewPhoto", back_populates="dish", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<ReviewDish(name='{self.dish_name}', rating={self.rating})>"


class ReviewPhoto(Base):
    """Photo attached to a review, optionally tagged to a specific dish."""
    __tablename__ = "review_photos"

    id = Column(Integer, primary_key=True)
    review_id = Column(Integer, ForeignKey("reviews.id", ondelete="CASCADE"), nullable=False)
    dish_id = Column(Integer, ForeignKey("review_dishes.id", ondelete="CASCADE"), nullable=True)  # NULL = overall photo
    telegram_file_id = Column(Text, nullable=False)
    file_url = Column(Text, nullable=True)  # Cached CDN URL
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    review = relationship("Review", back_populates="photos")
    dish = relationship("ReviewDish", back_populates="photos")

    def __repr__(self):
        return f"<ReviewPhoto(id={self.id}, dish_id={self.dish_id})>"


class ReviewReminder(Base):
    """Tracks pending review reminders for visited places."""
    __tablename__ = "review_reminders"

    id = Column(Integer, primary_key=True)
    place_id = Column(Integer, ForeignKey("places.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, nullable=False)
    visited_at = Column(DateTime, nullable=False)
    reminder_sent = Column(Boolean, default=False)
    dont_ask_again = Column(Boolean, default=False)

    def __repr__(self):
        return f"<ReviewReminder(place_id={self.place_id}, sent={self.reminder_sent})>"


engine = create_engine(config.DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)


def init_db():
    Base.metadata.create_all(engine)
