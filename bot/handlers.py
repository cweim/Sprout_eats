import logging
from io import BytesIO
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes

from services.downloader import download_content, is_valid_url, cleanup_files, DownloadTimeoutError
from services.transcriber import transcribe_audio
from services.places import search_place
from services.maps import generate_map_image
from database import repository
from database.models import init_db

logger = logging.getLogger(__name__)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [
            InlineKeyboardButton("📍 View Places", callback_data="action_places"),
            InlineKeyboardButton("🗺 View Map", callback_data="action_map"),
        ],
        [
            InlineKeyboardButton("🗑 Clear All", callback_data="action_clear"),
        ],
    ]
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

    text = f"Saved places ({len(places)}):\n\n"
    for i, place in enumerate(places, 1):
        text += f"{i}. {place.name}\n"
        if place.address:
            text += f"   {place.address}\n"
        text += "\n"

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
            text += f"{i}. {place.name}\n"
            if place.address:
                text += f"   {place.address}\n"
            text += "\n"

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

    elif query.data == "action_menu":
        await query.edit_message_text(
            "Welcome to Discovery Bot!\n\n"
            "Send me an Instagram Reel or TikTok link, and I'll help you find and save the locations mentioned.",
            reply_markup=get_menu_keyboard(),
        )


def get_menu_keyboard():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("📍 View Places", callback_data="action_places"),
            InlineKeyboardButton("🗺 View Map", callback_data="action_map"),
        ],
        [
            InlineKeyboardButton("🗑 Clear All", callback_data="action_clear"),
        ],
    ])


async def handle_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()

    if not is_valid_url(text):
        return  # Not a valid Instagram/TikTok URL, ignore

    status_msg = await update.message.reply_text("Processing video...")

    try:
        # Step 1: Download
        await status_msg.edit_text("Downloading video...")
        result = await download_content(text)

        # Step 2: Try to find place using caption/title first
        place = None
        metadata_text = f"{result.title} {result.description}".strip()
        transcript = ""

        if metadata_text:
            await status_msg.edit_text("Searching using video caption...")
            place = await search_place(metadata_text)

        # Step 3: If not found, fallback to transcribing audio
        if not place and result.audio_path and result.audio_path.exists():
            await status_msg.edit_text("Transcribing audio to find location...")
            try:
                transcript = await transcribe_audio(result.audio_path)
            except Exception as e:
                logger.warning(f"Transcription failed: {e}")

            if transcript:
                await status_msg.edit_text("Searching using audio transcript...")
                place = await search_place(transcript)

        # Handle case where no location could be found
        if not place:
            combined_text = f"{metadata_text} {transcript}".strip()
            if not combined_text:
                await status_msg.edit_text(
                    "Could not extract any text or audio from the video. "
                    "Please reply with the place name manually."
                )
            else:
                await status_msg.edit_text(
                    f"Could not find a specific location.\n\n"
                    f"Text found: {combined_text[:200]}...\n\n"
                    "Please reply with the place name to search for."
                )
            context.user_data["pending_url"] = text
            context.user_data["pending_platform"] = result.platform
            cleanup_files(result.video_path, result.audio_path)
            return

        # Step 4: Save and respond
        saved_place = repository.add_place(
            name=place.name,
            address=place.address,
            latitude=place.latitude,
            longitude=place.longitude,
            google_place_id=place.place_id,
            source_url=text,
            source_platform=result.platform,
        )

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
