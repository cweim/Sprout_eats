#!/usr/bin/env python3
"""
Migration script: SQLite to Supabase.

This script:
1. Prompts for Telegram user ID
2. Reads all data from SQLite
3. Creates user in Supabase
4. Migrates places, reviews, dishes, reminders
5. Re-uploads photos from Telegram URLs to Supabase Storage

Usage:
    python scripts/migrate_to_supabase.py

Prerequisites:
    - Set SUPABASE_URL, SUPABASE_SERVICE_KEY in .env
    - Run schema.sql in Supabase SQL Editor first
    - Create 'review-photos' bucket in Supabase Storage (public)
"""

import sys
import os
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import httpx
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

import config
from database.models import SessionLocal, Place, Review, ReviewDish, ReviewPhoto, ReviewReminder
from database.supabase_client import get_supabase, upload_photo


def migrate():
    """Run the migration."""
    print("=" * 60)
    print("SQLite to Supabase Migration")
    print("=" * 60)
    print()

    # Check Supabase config
    if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")
        sys.exit(1)

    # Get target user ID
    print("Enter your Telegram user ID (get it from @userinfobot):")
    user_id_str = input("> ").strip()

    try:
        user_id = int(user_id_str)
    except ValueError:
        print("ERROR: Invalid user ID")
        sys.exit(1)

    print(f"\nMigrating to user_id: {user_id}")
    print()

    supabase = get_supabase()

    # Create user record
    print("[1/6] Creating user record...")
    supabase.table("users").upsert({
        "id": user_id,
        "created_at": datetime.utcnow().isoformat(),
    }).execute()
    print("  User created/updated")

    # Read SQLite data
    print("\n[2/6] Reading SQLite data...")
    with SessionLocal() as session:
        places = session.query(Place).all()
        print(f"  Found {len(places)} places")

        reviews = session.query(Review).all()
        print(f"  Found {len(reviews)} reviews")

        dishes = session.query(ReviewDish).all()
        print(f"  Found {len(dishes)} dishes")

        photos = session.query(ReviewPhoto).all()
        print(f"  Found {len(photos)} photos")

        reminders = session.query(ReviewReminder).all()
        print(f"  Found {len(reminders)} reminders")

    # Migrate places
    print("\n[3/6] Migrating places...")
    place_id_map = {}  # old_id -> new_id

    for place in places:
        result = supabase.table("places").insert({
            "user_id": user_id,
            "name": place.name,
            "address": place.address,
            "latitude": place.latitude,
            "longitude": place.longitude,
            "google_place_id": place.google_place_id,
            "source_url": place.source_url,
            "source_platform": place.source_platform,
            "source_title": place.source_title,
            "source_uploader": place.source_uploader,
            "source_duration": int(place.source_duration) if place.source_duration else None,
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
            "created_at": place.created_at.isoformat() if place.created_at else datetime.utcnow().isoformat(),
        }).execute()

        if result.data:
            place_id_map[place.id] = result.data[0]["id"]
            print(f"  Migrated place: {place.name} ({place.id} -> {result.data[0]['id']})")

    # Migrate reviews
    print("\n[4/6] Migrating reviews...")
    review_id_map = {}  # old_id -> new_id

    for review in reviews:
        new_place_id = place_id_map.get(review.place_id)
        if not new_place_id:
            print(f"  WARNING: Skipping review {review.id} - place {review.place_id} not found")
            continue

        result = supabase.table("reviews").insert({
            "place_id": new_place_id,
            "user_id": user_id,
            "overall_rating": review.overall_rating,
            "price_rating": review.price_rating,
            "overall_remarks": review.overall_remarks,
            "created_at": review.created_at.isoformat() if review.created_at else datetime.utcnow().isoformat(),
            "updated_at": review.updated_at.isoformat() if review.updated_at else datetime.utcnow().isoformat(),
        }).execute()

        if result.data:
            review_id_map[review.id] = result.data[0]["id"]
            print(f"  Migrated review {review.id} -> {result.data[0]['id']}")

    # Migrate dishes
    print("\n[5/6] Migrating dishes...")
    dish_id_map = {}  # old_id -> new_id

    for dish in dishes:
        new_review_id = review_id_map.get(dish.review_id)
        if not new_review_id:
            print(f"  WARNING: Skipping dish {dish.id} - review {dish.review_id} not found")
            continue

        result = supabase.table("review_dishes").insert({
            "review_id": new_review_id,
            "dish_name": dish.dish_name,
            "rating": dish.rating,
            "remarks": dish.remarks,
            "created_at": dish.created_at.isoformat() if dish.created_at else datetime.utcnow().isoformat(),
            "updated_at": dish.updated_at.isoformat() if dish.updated_at else datetime.utcnow().isoformat(),
        }).execute()

        if result.data:
            dish_id_map[dish.id] = result.data[0]["id"]
            print(f"  Migrated dish: {dish.dish_name} ({dish.id} -> {result.data[0]['id']})")

    # Migrate photos (re-upload to Supabase Storage)
    print("\n[6/6] Migrating photos...")
    photo_success = 0
    photo_fail = 0

    for photo in photos:
        new_review_id = review_id_map.get(photo.review_id)
        if not new_review_id:
            print(f"  WARNING: Skipping photo {photo.id} - review {photo.review_id} not found")
            photo_fail += 1
            continue

        new_dish_id = dish_id_map.get(photo.dish_id) if photo.dish_id else None

        # Download from Telegram URL
        if not photo.file_url:
            print(f"  WARNING: Photo {photo.id} has no file_url")
            photo_fail += 1
            continue

        try:
            print(f"  Downloading photo {photo.id}...")
            with httpx.Client(timeout=30.0) as client:
                response = client.get(photo.file_url)
                response.raise_for_status()
                content = response.content

            # Upload to Supabase
            print(f"  Uploading to Supabase...")
            file_url, storage_path = upload_photo(
                user_id=user_id,
                review_id=new_review_id,
                file_content=content,
                filename="photo.jpg"
            )

            # Count photos for sort_order
            count_result = (
                supabase.table("review_photos")
                .select("id", count="exact")
                .eq("review_id", new_review_id)
                .execute()
            )
            sort_order = count_result.count or 0

            # Insert photo record
            supabase.table("review_photos").insert({
                "review_id": new_review_id,
                "dish_id": new_dish_id,
                "file_url": file_url,
                "storage_path": storage_path,
                "sort_order": sort_order,
                "created_at": photo.created_at.isoformat() if photo.created_at else datetime.utcnow().isoformat(),
            }).execute()

            photo_success += 1
            print(f"  Migrated photo {photo.id}")

        except Exception as e:
            print(f"  ERROR migrating photo {photo.id}: {e}")
            photo_fail += 1

    # Migrate reminders
    print("\n[7/7] Migrating reminders...")
    for reminder in reminders:
        new_place_id = place_id_map.get(reminder.place_id)
        if not new_place_id:
            print(f"  WARNING: Skipping reminder {reminder.id} - place {reminder.place_id} not found")
            continue

        try:
            supabase.table("review_reminders").upsert({
                "place_id": new_place_id,
                "user_id": user_id,
                "visited_at": reminder.visited_at.isoformat() if reminder.visited_at else datetime.utcnow().isoformat(),
                "reminder_sent": reminder.reminder_sent or False,
                "dont_ask_again": reminder.dont_ask_again or False,
            }).execute()
            print(f"  Migrated reminder for place {reminder.place_id}")
        except Exception as e:
            print(f"  ERROR migrating reminder {reminder.id}: {e}")

    # Summary
    print()
    print("=" * 60)
    print("Migration Complete!")
    print("=" * 60)
    print(f"  Places:    {len(place_id_map)}")
    print(f"  Reviews:   {len(review_id_map)}")
    print(f"  Dishes:    {len(dish_id_map)}")
    print(f"  Photos:    {photo_success} success, {photo_fail} failed")
    print(f"  Reminders: {len(reminders)}")
    print()
    print("Next steps:")
    print("  1. Verify data in Supabase dashboard")
    print("  2. Update .env with Supabase credentials")
    print("  3. Restart the API server")


if __name__ == "__main__":
    migrate()
