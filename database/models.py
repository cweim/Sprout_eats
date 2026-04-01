from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, DateTime, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

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

    def __repr__(self):
        return f"<Place(name='{self.name}', address='{self.address}')>"


engine = create_engine(config.DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)


def init_db():
    Base.metadata.create_all(engine)
