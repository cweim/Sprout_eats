import logging
import math
from io import BytesIO
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo, KeyboardButton, ReplyKeyboardMarkup, ReplyKeyboardRemove
from telegram.ext import ContextTypes

import config
from services.downloader import download_content, is_valid_url, cleanup_files, DownloadTimeoutError
from services.transcriber import transcribe_audio
from services.places import search_place, search_places_from_text
from services.maps import generate_map_image
from database import repository
from database.models import init_db

logger = logging.getLogger(__name__)

# Language code to friendly name mapping
LANGUAGE_NAMES = {
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "th": "Thai",
    "vi": "Vietnamese",
    "id": "Indonesian",
}


def get_language_name(code: str) -> str:
    """Get friendly language name from ISO code."""
    return LANGUAGE_NAMES.get(code, code.upper())


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


def format_place_line(place, index: int) -> str:
    """Format a place for display in listings with optional metadata."""
    lines = [f"{index}. {place.name}"]
    if place.address:
        lines.append(f"   {place.address}")

    # Build metadata line (rating + types)
    meta_parts = []
    if place.place_rating:
        meta_parts.append(f"⭐ {place.place_rating}/5")
    if place.place_types:
        # Parse comma-separated types, title case, limit to 2
        types_list = [t.replace("_", " ").title() for t in place.place_types.split(",")[:2]]
        meta_parts.append(", ".join(types_list))

    if meta_parts:
        lines.append(f"   {' • '.join(meta_parts)}")

    return "\n".join(lines)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [
            InlineKeyboardButton("📍 View Places", callback_data="action_places"),
            InlineKeyboardButton("🗺 View Map", callback_data="action_map"),
        ],
        [
            InlineKeyboardButton("🗑️ Delete One", callback_data="action_delete"),
            InlineKeyboardButton("🗑 Clear All", callback_data="action_clear"),
        ],
    ]

    # Add viewer button if WEBAPP_URL is configured
    if config.WEBAPP_URL:
        keyboard.append([
            InlineKeyboardButton(
                "✨ Open Viewer",
                web_app=WebAppInfo(url=config.WEBAPP_URL)
            )
        ])

    reply_markup = InlineKeyboardMarkup(keyboard)

    await update.message.reply_text(
        "Welcome to Discovery Bot!\n\n"
        "Send me an Instagram Reel or TikTok link, and I'll help you find and save the locations mentioned.",
        reply_markup=reply_markup,
    )


async def places_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    places = repository.get_all_places()

    if not places:
        await update.message.reply_text("No places saved yet. Send me an Instagram or TikTok link!")
        return

    text = f"📍 Saved places ({len(places)}):\n\n"
    for i, place in enumerate(places, 1):
        text += format_place_line(place, i) + "\n\n"

    await update.message.reply_text(text)


async def map_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    places = repository.get_all_places()

    if not places:
        await update.message.reply_text("No places saved yet. Send me an Instagram or TikTok link!")
        return

    await update.message.reply_text("Generating map...")

    # Prepare places for map
    map_places = [(p.latitude, p.longitude, p.name) for p in places]

    try:
        image_bytes = await generate_map_image(map_places)
        if image_bytes:
            await update.message.reply_photo(
                photo=BytesIO(image_bytes),
                caption=f"Map with {len(places)} saved place(s)",
            )
        else:
            await update.message.reply_text("Failed to generate map. Please check your Google API key.")
    except Exception as e:
        logger.error(f"Error generating map: {e}")
        await update.message.reply_text(
            "I had trouble making the map. Let me know if this keeps happening! 🗺️"
        )


async def viewer_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Open the interactive Mini App viewer."""
    if not config.WEBAPP_URL:
        await update.message.reply_text(
            "The viewer isn't set up yet. Check back later!"
        )
        return

    keyboard = [[
        InlineKeyboardButton(
            "✨ Open Viewer",
            web_app=WebAppInfo(url=config.WEBAPP_URL)
        )
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    await update.message.reply_text(
        "Tap below to explore your saved places!",
        reply_markup=reply_markup,
    )


async def clear_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [
            InlineKeyboardButton("Yes, clear all", callback_data="clear_confirm"),
            InlineKeyboardButton("Cancel", callback_data="clear_cancel"),
        ]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    count = repository.get_place_count()
    await update.message.reply_text(
        f"Are you sure you want to clear all {count} saved places?",
        reply_markup=reply_markup,
    )


async def clear_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    if query.data == "clear_confirm":
        count = repository.clear_all_places()
        await query.edit_message_text(f"Cleared {count} places.")
    else:
        await query.edit_message_text("Clear cancelled.")


async def action_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    if query.data == "action_places":
        places = repository.get_all_places()
        if not places:
            await query.edit_message_text(
                "No places saved yet. Send me an Instagram or TikTok link!",
                reply_markup=get_menu_keyboard(),
            )
            return

        text = f"📍 Saved places ({len(places)}):\n\n"
        for i, place in enumerate(places, 1):
            text += format_place_line(place, i) + "\n\n"

        await query.edit_message_text(text, reply_markup=get_menu_keyboard())

    elif query.data == "action_map":
        places = repository.get_all_places()
        if not places:
            await query.edit_message_text(
                "No places saved yet. Send me an Instagram or TikTok link!",
                reply_markup=get_menu_keyboard(),
            )
            return

        await query.edit_message_text("Generating map...")
        map_places = [(p.latitude, p.longitude, p.name) for p in places]

        try:
            image_bytes = await generate_map_image(map_places)
            if image_bytes:
                await query.message.reply_photo(
                    photo=BytesIO(image_bytes),
                    caption=f"🗺 Map with {len(places)} saved place(s)",
                    reply_markup=get_menu_keyboard(),
                )
                await query.delete_message()
            else:
                await query.edit_message_text(
                    "Failed to generate map. Please check your Google API key.",
                    reply_markup=get_menu_keyboard(),
                )
        except Exception as e:
            logger.error(f"Error generating map: {e}")
            await query.edit_message_text(
                "I had trouble making the map. Let me know if this keeps happening! 🗺️",
                reply_markup=get_menu_keyboard(),
            )

    elif query.data == "action_clear":
        keyboard = [
            [
                InlineKeyboardButton("Yes, clear all", callback_data="clear_confirm"),
                InlineKeyboardButton("Cancel", callback_data="action_menu"),
            ]
        ]
        count = repository.get_place_count()
        await query.edit_message_text(
            f"Are you sure you want to clear all {count} saved places?",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    elif query.data == "action_delete":
        places = repository.get_all_places()
        if not places:
            await query.edit_message_text(
                "No places to delete! Your list is empty. 📭",
                reply_markup=get_menu_keyboard(),
            )
            return

        keyboard = []
        for place in places:
            name = place.name[:25] + "..." if len(place.name) > 25 else place.name
            keyboard.append([InlineKeyboardButton(name, callback_data=f"delete_place_{place.id}")])
        keyboard.append([InlineKeyboardButton("« Back", callback_data="action_menu")])

        await query.edit_message_text(
            "Which place would you like to remove? 🗑️",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    elif query.data == "action_menu":
        await query.edit_message_text(
            "Welcome to Discovery Bot!\n\n"
            "Send me an Instagram Reel or TikTok link, and I'll help you find and save the locations mentioned.",
            reply_markup=get_menu_keyboard(),
        )


def get_menu_keyboard():
    keyboard = [
        [
            InlineKeyboardButton("📍 View Places", callback_data="action_places"),
            InlineKeyboardButton("🗺 View Map", callback_data="action_map"),
        ],
        [
            InlineKeyboardButton("🗑️ Delete One", callback_data="action_delete"),
            InlineKeyboardButton("🗑 Clear All", callback_data="action_clear"),
        ],
    ]

    # Add viewer button if WEBAPP_URL is configured
    if config.WEBAPP_URL:
        keyboard.append([
            InlineKeyboardButton(
                "✨ Open Viewer",
                web_app=WebAppInfo(url=config.WEBAPP_URL)
            )
        ])

    return InlineKeyboardMarkup(keyboard)


async def select_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle place selection from inline keyboard."""
    query = update.callback_query
    await query.answer()

    # Check if pending_places exists
    pending_places = context.user_data.get("pending_places")
    if not pending_places:
        await query.edit_message_text(
            "Hmm, that selection expired. Send the link again! 🔄"
        )
        return

    # Extract index from callback data (format: "select_place_{index}")
    try:
        index = int(query.data.replace("select_place_", ""))
        place_data = pending_places[index]
    except (ValueError, IndexError):
        await query.edit_message_text(
            "Oops, something went wrong with that selection. Try again! 🙈"
        )
        return

    # Get source info
    source_url = context.user_data.get("pending_url", "")
    source_platform = context.user_data.get("pending_platform", "unknown")
    video_meta = context.user_data.get("pending_video_meta", {})

    # Save to database with all metadata
    saved_place = repository.add_place(
        name=place_data["name"],
        address=place_data["address"],
        latitude=place_data["latitude"],
        longitude=place_data["longitude"],
        google_place_id=place_data.get("place_id"),
        source_url=source_url,
        source_platform=source_platform,
        source_title=video_meta.get("source_title"),
        source_uploader=video_meta.get("source_uploader"),
        source_duration=video_meta.get("source_duration"),
        source_hashtags=video_meta.get("source_hashtags"),
        place_types=",".join(place_data.get("types", [])) if place_data.get("types") else None,
        place_rating=place_data.get("rating"),
        place_rating_count=place_data.get("rating_count"),
        place_price_level=place_data.get("price_level"),
        place_opening_hours=place_data.get("opening_hours"),
        source_language=video_meta.get("source_language"),
        source_transcript=video_meta.get("source_transcript"),
        source_transcript_en=video_meta.get("source_transcript_en"),
    )

    # Clear pending data
    context.user_data.pop("pending_places", None)
    context.user_data.pop("pending_url", None)
    context.user_data.pop("pending_platform", None)
    context.user_data.pop("pending_video_meta", None)

    # Delete selection message
    await query.delete_message()

    # Send location pin
    await query.message.reply_location(
        latitude=place_data["latitude"],
        longitude=place_data["longitude"],
    )

    # Build rich confirmation message
    confirmation = f"Found and saved: {place_data['name']}! 🎉\n📍 {place_data['address']}"
    if place_data.get("rating"):
        rating_text = f"⭐ {place_data['rating']}/5"
        if place_data.get("rating_count"):
            rating_text += f" ({place_data['rating_count']} reviews)"
        confirmation += f"\n{rating_text}"
    if place_data.get("types"):
        types_display = ", ".join(t.replace("_", " ").title() for t in place_data["types"][:2])
        confirmation += f"\n🏷️ {types_display}"
    if video_meta.get("source_uploader"):
        confirmation += f"\n📺 From @{video_meta['source_uploader']}"
    # Show detected language if non-English
    source_lang = video_meta.get("source_language")
    if source_lang and source_lang != "en":
        confirmation += f"\n🌏 Detected: {get_language_name(source_lang)}"

    await query.message.reply_text(confirmation)


async def handle_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()

    if not is_valid_url(text):
        return  # Not a valid Instagram/TikTok URL, ignore

    status_msg = await update.message.reply_text("Processing video...")

    try:
        # Step 1: Download
        await status_msg.edit_text("Downloading video...")
        result = await download_content(text)

        # Step 2: Try to find places using caption/title first
        places = []
        metadata_text = f"{result.title} {result.description}".strip()
        transcription_result = None

        if metadata_text:
            await status_msg.edit_text("Searching using video caption...")
            places = await search_places_from_text(metadata_text)

        # Step 3: If not found, fallback to transcribing audio
        if not places and result.audio_path and result.audio_path.exists():
            await status_msg.edit_text("Transcribing audio to find location...")
            try:
                transcription_result = await transcribe_audio(result.audio_path)
            except Exception as e:
                logger.warning(f"Transcription failed: {e}")

            if transcription_result:
                await status_msg.edit_text("Searching using audio transcript...")
                # Use English text for better Google Places API results
                search_text = transcription_result.english_text or transcription_result.text
                places = await search_places_from_text(search_text)

        # Handle case where no location could be found
        if not places:
            transcript_text = transcription_result.text if transcription_result else ""
            combined_text = f"{metadata_text} {transcript_text}".strip()
            if not combined_text:
                await status_msg.edit_text(
                    "Could not extract any text or audio from the video. "
                    "Please reply with the place name manually."
                )
            else:
                # Show detected language if transcription was used
                lang_hint = ""
                if transcription_result and transcription_result.language != "en":
                    lang_name = get_language_name(transcription_result.language)
                    lang_hint = f" (detected: {lang_name})"
                await status_msg.edit_text(
                    f"Could not find a specific location{lang_hint}.\n\n"
                    f"Text found: {combined_text[:200]}...\n\n"
                    "Please reply with the place name to search for."
                )
            context.user_data["pending_url"] = text
            context.user_data["pending_platform"] = result.platform
            cleanup_files(result.video_path, result.audio_path)
            return

        # Extract video metadata for storage
        source_title = result.title
        source_uploader = result.uploader
        source_duration = result.duration
        source_hashtags = ",".join(result.hashtags) if result.hashtags else None

        # Step 4: Handle results based on count
        if len(places) == 1:
            # Single place: auto-save (backward compatible behavior)
            place = places[0]
            saved_place = repository.add_place(
                name=place.name,
                address=place.address,
                latitude=place.latitude,
                longitude=place.longitude,
                google_place_id=place.place_id,
                source_url=text,
                source_platform=result.platform,
                source_title=source_title,
                source_uploader=source_uploader,
                source_duration=source_duration,
                source_hashtags=source_hashtags,
                place_types=",".join(place.types) if place.types else None,
                place_rating=place.rating,
                place_rating_count=place.rating_count,
                place_price_level=place.price_level,
                place_opening_hours=place.opening_hours,
                source_language=transcription_result.language if transcription_result else None,
                source_transcript=transcription_result.text if transcription_result else None,
                source_transcript_en=transcription_result.english_text if transcription_result else None,
            )

            await status_msg.delete()

            # Send location pin
            await update.message.reply_location(
                latitude=place.latitude,
                longitude=place.longitude,
            )

            # Build rich confirmation message
            confirmation = f"Found and saved: {place.name}! 🎉\n📍 {place.address}"
            if place.rating:
                rating_text = f"⭐ {place.rating}/5"
                if place.rating_count:
                    rating_text += f" ({place.rating_count} reviews)"
                confirmation += f"\n{rating_text}"
            if place.types:
                types_display = ", ".join(t.replace("_", " ").title() for t in place.types[:2])
                confirmation += f"\n🏷️ {types_display}"
            if source_uploader:
                confirmation += f"\n📺 From @{source_uploader}"

            await update.message.reply_text(confirmation)
        else:
            # Multiple places: show selection keyboard
            # Store places in user_data for callback (include metadata)
            context.user_data["pending_places"] = [
                {
                    "name": p.name,
                    "address": p.address,
                    "latitude": p.latitude,
                    "longitude": p.longitude,
                    "place_id": p.place_id,
                    "types": p.types,
                    "rating": p.rating,
                    "rating_count": p.rating_count,
                    "price_level": p.price_level,
                    "opening_hours": p.opening_hours,
                }
                for p in places
            ]
            context.user_data["pending_url"] = text
            context.user_data["pending_platform"] = result.platform
            # Store video metadata for later (including language info)
            context.user_data["pending_video_meta"] = {
                "source_title": source_title,
                "source_uploader": source_uploader,
                "source_duration": source_duration,
                "source_hashtags": source_hashtags,
                "source_language": transcription_result.language if transcription_result else None,
                "source_transcript": transcription_result.text if transcription_result else None,
                "source_transcript_en": transcription_result.english_text if transcription_result else None,
            }

            # Build keyboard with place options
            keyboard = []
            for i, place in enumerate(places):
                name = place.name[:30] + "..." if len(place.name) > 30 else place.name
                keyboard.append([InlineKeyboardButton(name, callback_data=f"select_place_{i}")])

            await status_msg.edit_text(
                f"I found {len(places)} places! Which one did you mean? 📍",
                reply_markup=InlineKeyboardMarkup(keyboard),
            )

        # Cleanup temp files
        cleanup_files(result.video_path, result.audio_path)

    except DownloadTimeoutError:
        logger.error("Download timed out")
        await status_msg.edit_text(
            "Oh no! This video is taking too long to download. Maybe try a shorter one? 🐢"
        )
    except Exception as e:
        logger.error(f"Error processing URL: {e}")
        if "connect" in str(e).lower() or "network" in str(e).lower():
            await status_msg.edit_text(
                "Hmm, I'm having trouble connecting right now. Give me a moment and try again! 🌐"
            )
        else:
            await status_msg.edit_text(
                "Oops! Something went wrong while processing that video. Mind trying again? 🙈"
            )


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle text messages that might be place name responses."""
    text = update.message.text.strip()

    # Always treat valid URLs as new link submissions, 
    # even if we were waiting for a manual place name.
    if is_valid_url(text):
        context.user_data.pop("pending_url", None)
        context.user_data.pop("pending_platform", None)
        await handle_url(update, context)
        return

    # Check if this is a response to a pending search
    pending_url = context.user_data.get("pending_url")
    if not pending_url:
        return

    pending_platform = context.user_data.get("pending_platform", "unknown")

    status_msg = await update.message.reply_text("Searching for location...")

    try:
        place = await search_place(text)

        if not place:
            await status_msg.edit_text(
                f"Could not find '{text}'. Please try a more specific name or address."
            )
            return

        # Save the place
        saved_place = repository.add_place(
            name=place.name,
            address=place.address,
            latitude=place.latitude,
            longitude=place.longitude,
            google_place_id=place.place_id,
            source_url=pending_url,
            source_platform=pending_platform,
        )

        # Clear pending state
        context.user_data.pop("pending_url", None)
        context.user_data.pop("pending_platform", None)

        await status_msg.delete()

        # Send location pin
        await update.message.reply_location(
            latitude=place.latitude,
            longitude=place.longitude,
        )

        await update.message.reply_text(
            f"Found and saved: {place.name}\n"
            f"Address: {place.address}"
        )

    except Exception as e:
        logger.error(f"Error searching place: {e}")
        await status_msg.edit_text(
            "I couldn't find that place. Could you try a different name or be more specific? 🔍"
        )


async def delete_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show list of places to delete."""
    places = repository.get_all_places()

    if not places:
        await update.message.reply_text("No places to delete! Your list is empty. 📭")
        return

    keyboard = []
    for place in places:
        name = place.name[:25] + "..." if len(place.name) > 25 else place.name
        keyboard.append([InlineKeyboardButton(name, callback_data=f"delete_place_{place.id}")])

    await update.message.reply_text(
        "Which place would you like to remove? 🗑️",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


async def delete_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle place deletion from inline keyboard."""
    query = update.callback_query
    await query.answer()

    # Extract place_id from callback data (format: "delete_place_{id}")
    try:
        place_id = int(query.data.replace("delete_place_", ""))
    except ValueError:
        await query.edit_message_text("Oops, something went wrong. Try again! 🙈")
        return

    # Delete the place
    deleted = repository.delete_place(place_id)

    if deleted:
        await query.edit_message_text("Removed! Your places are tidied up. ✨")
    else:
        await query.edit_message_text("That place was already gone! 👻")


async def nearby_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Request location to find nearby saved places."""
    # Create location request button
    keyboard = [[KeyboardButton("📍 Share My Location", request_location=True)]]
    reply_markup = ReplyKeyboardMarkup(keyboard, one_time_keyboard=True, resize_keyboard=True)

    await update.message.reply_text(
        "Let's find saved places near you! 🗺️\n\n"
        "Tap the button below to share your location:",
        reply_markup=reply_markup
    )


async def handle_location(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle shared location and show nearby places."""
    location = update.message.location
    lat, lng = location.latitude, location.longitude

    places = repository.get_all_places()
    if not places:
        await update.message.reply_text(
            "You don't have any saved places yet! 📭\n"
            "Send me an Instagram or TikTok link to get started.",
            reply_markup=ReplyKeyboardRemove()
        )
        return

    # Calculate distances
    NEARBY_RADIUS = 5  # km
    nearby = []
    for place in places:
        if place.latitude and place.longitude:
            dist = haversine_distance(lat, lng, place.latitude, place.longitude)
            if dist <= NEARBY_RADIUS:
                nearby.append((place, dist))

    # Sort by distance
    nearby.sort(key=lambda x: x[1])

    if not nearby:
        await update.message.reply_text(
            f"No saved places within {NEARBY_RADIUS}km of your location. 🔍\n\n"
            "Try the /places command to see all your saved spots!",
            reply_markup=ReplyKeyboardRemove()
        )
        return

    # Format response
    text = f"📍 Found {len(nearby)} place{'s' if len(nearby) != 1 else ''} nearby!\n\n"
    for place, dist in nearby[:5]:  # Limit to 5
        dist_str = f"{int(dist * 1000)}m" if dist < 1 else f"{dist:.1f}km"
        text += f"• {place.name} ({dist_str})\n"
        if place.address:
            text += f"  {place.address}\n"
        text += "\n"

    if len(nearby) > 5:
        text += f"...and {len(nearby) - 5} more!\n"

    text += "\nOpen the viewer to see them on a map! ✨"

    await update.message.reply_text(text, reply_markup=ReplyKeyboardRemove())
