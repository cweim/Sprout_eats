import logging
import math
from io import BytesIO
from urllib.parse import quote
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo, KeyboardButton, ReplyKeyboardMarkup, ReplyKeyboardRemove
from telegram.ext import ContextTypes, ConversationHandler, MessageHandler, CommandHandler, CallbackQueryHandler, filters

import config
from services.downloader import download_content, is_valid_url, cleanup_files, DownloadTimeoutError, VideoTooLongError
from services.ocr import extract_text_from_images, extract_text_from_video
from services.transcriber import transcribe_audio
from services.places import search_place
from services.place_pipeline import (
    build_runtime_metadata_record,
    extract_place_evidence_from_metadata,
    resolve_place_slots,
)
from services.maps import generate_map_image
from database import supabase_repository as repository

logger = logging.getLogger(__name__)

# Review conversation states
REVIEW_DISH_NAME = 100
REVIEW_DISH_RATING = 101
REVIEW_DISH_REMARKS = 102
REVIEW_OVERALL_RATING = 103
REVIEW_PRICE_RATING = 104
REVIEW_OVERALL_REMARKS = 105

# Review context storage in user_data:
# {
#     'review_place_id': int,
#     'review_place_name': str,
#     'review_dishes': [
#         { 'name': str, 'rating': int, 'remarks': str|None }
#     ],
#     'review_current_dish': { 'name': str, 'rating': int },
#     'review_overall': int,
#     'review_price': int,
#     'review_remarks': str|None
# }

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
    lines = [f"{index}. {place['name']}"]
    if place.get('address'):
        lines.append(f"   {place['address']}")

    # Build metadata line (rating + types)
    meta_parts = []
    if place.get('place_rating'):
        meta_parts.append(f"⭐ {place['place_rating']}/5")
    if place.get('place_types'):
        # Parse comma-separated types, title case, limit to 2
        types_list = [t.replace("_", " ").title() for t in place['place_types'].split(",")[:2]]
        meta_parts.append(", ".join(types_list))

    if meta_parts:
        lines.append(f"   {' • '.join(meta_parts)}")

    return "\n".join(lines)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    keyboard = []

    # Add viewer button if WEBAPP_URL is configured
    if config.WEBAPP_URL:
        keyboard.append([
            InlineKeyboardButton(
                "🗺️ Open My Map",
                web_app=WebAppInfo(url=config.WEBAPP_URL)
            )
        ])

    keyboard.append([
        InlineKeyboardButton("📍 Find places near me", callback_data="action_nearby"),
    ])

    reply_markup = InlineKeyboardMarkup(keyboard)

    count = repository.get_place_count(user_id)
    if count > 0:
        count_text = f"📍 You've saved {count} place{'s' if count != 1 else ''}!"
    else:
        count_text = "📍 No places saved yet — let's find some!"

    await update.message.reply_text(
        f"Hey there! 👋\n\n"
        f"Send me an Instagram Reel or TikTok link, "
        f"and I'll dig up the spots mentioned and save them to your map. 🗺️\n\n"
        f"{count_text}",
        reply_markup=reply_markup,
    )


async def places_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    places = repository.get_all_places(user_id)

    if not places:
        await update.message.reply_text(
            "No places saved yet! 📍\n\n"
            "Send me a video link and I'll find some for you."
        )
        return

    text = f"📍 Your collection ({len(places)} places):\n\n"
    for i, place in enumerate(places, 1):
        text += format_place_line(place, i) + "\n\n"

    await update.message.reply_text(text)


async def map_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    places = repository.get_all_places(user_id)

    if not places:
        await update.message.reply_text(
            "No places saved yet! 📍\n\n"
            "Send me a video link and I'll find some for you."
        )
        return

    await update.message.reply_text("Drawing your map... 🗺️")

    # Prepare places for map
    map_places = [(p['latitude'], p['longitude'], p['name']) for p in places]

    try:
        image_bytes = await generate_map_image(map_places)
        if image_bytes:
            await update.message.reply_photo(
                photo=BytesIO(image_bytes),
                caption=f"🗺️ Your map: {len(places)} place{'s' if len(places) != 1 else ''} saved!",
            )
        else:
            await update.message.reply_text("Hmm, the map didn't load. Try again in a bit!")
    except Exception as e:
        logger.error(f"Error generating map: {e}")
        await update.message.reply_text(
            "Oops! Hit a snag drawing your map. Give it another try?"
        )


async def viewer_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Open the interactive Mini App viewer."""
    if not config.WEBAPP_URL:
        await update.message.reply_text(
            "The map viewer isn't available yet. Check back soon!"
        )
        return

    keyboard = [[
        InlineKeyboardButton(
            "🗺️ Open My Map",
            web_app=WebAppInfo(url=config.WEBAPP_URL)
        )
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    await update.message.reply_text(
        "Ready to explore your saved places? 🗺️",
        reply_markup=reply_markup,
    )


async def clear_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    keyboard = [
        [
            InlineKeyboardButton("Yes, clear all", callback_data="clear_confirm"),
            InlineKeyboardButton("Keep them", callback_data="clear_cancel"),
        ]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    count = repository.get_place_count(user_id)
    await update.message.reply_text(
        f"🗑️ Clear all your saved places? ({count} will be removed)",
        reply_markup=reply_markup,
    )


async def clear_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    query = update.callback_query
    await query.answer()

    if query.data == "clear_confirm":
        count = repository.clear_all_places(user_id)
        await query.edit_message_text(f"All cleared! {count} place{'s' if count != 1 else ''} removed. 🗑️")
    else:
        await query.edit_message_text("No worries, your places are safe! 📍")


async def action_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    query = update.callback_query
    await query.answer()

    if query.data == "action_places":
        places = repository.get_all_places(user_id)
        if not places:
            await query.edit_message_text(
                "No places saved yet! 📍\n\nSend me a video link to find some.",
                reply_markup=get_menu_keyboard(),
            )
            return

        text = f"📍 Your collection ({len(places)} places):\n\n"
        for i, place in enumerate(places, 1):
            text += format_place_line(place, i) + "\n\n"

        await query.edit_message_text(text, reply_markup=get_menu_keyboard())

    elif query.data == "action_map":
        places = repository.get_all_places(user_id)
        if not places:
            await query.edit_message_text(
                "No places saved yet! 📍\n\nSend me a video link to find some.",
                reply_markup=get_menu_keyboard(),
            )
            return

        await query.edit_message_text("Drawing your map... 🗺️")
        map_places = [(p['latitude'], p['longitude'], p['name']) for p in places]

        try:
            image_bytes = await generate_map_image(map_places)
            if image_bytes:
                await query.message.reply_photo(
                    photo=BytesIO(image_bytes),
                    caption=f"🗺️ Your map: {len(places)} place{'s' if len(places) != 1 else ''} saved!",
                    reply_markup=get_menu_keyboard(),
                )
                await query.delete_message()
            else:
                await query.edit_message_text(
                    "Hmm, the map didn't load. Try again in a bit!",
                    reply_markup=get_menu_keyboard(),
                )
        except Exception as e:
            logger.error(f"Error generating map: {e}")
            await query.edit_message_text(
                "Oops! Hit a snag drawing your map. Give it another try?",
                reply_markup=get_menu_keyboard(),
            )

    elif query.data == "action_clear":
        keyboard = [
            [
                InlineKeyboardButton("Yes, clear all", callback_data="clear_confirm"),
                InlineKeyboardButton("Keep them", callback_data="action_menu"),
            ]
        ]
        count = repository.get_place_count(user_id)
        await query.edit_message_text(
            f"🗑️ Clear all your saved places? ({count} will be removed)",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    elif query.data == "action_delete":
        places = repository.get_all_places(user_id)
        if not places:
            await query.edit_message_text(
                "Nothing to remove! No places saved yet. 📍",
                reply_markup=get_menu_keyboard(),
            )
            return

        keyboard = []
        for place in places:
            name = place['name'][:25] + "..." if len(place['name']) > 25 else place['name']
            keyboard.append([InlineKeyboardButton(name, callback_data=f"delete_place_{place['id']}")])
        keyboard.append([InlineKeyboardButton("« Back", callback_data="action_menu")])

        await query.edit_message_text(
            "Which place would you like to remove? 🗑️",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    elif query.data == "action_nearby":
        # Trigger location request
        keyboard = [[KeyboardButton("📍 Share My Location", request_location=True)]]
        reply_markup = ReplyKeyboardMarkup(keyboard, one_time_keyboard=True, resize_keyboard=True)

        await query.message.reply_text(
            "Let's see what's saved near you! 📍\n\n"
            "Tap below to share your location:",
            reply_markup=reply_markup
        )
        await query.delete_message()

    elif query.data == "action_menu":
        count = repository.get_place_count(user_id)
        if count > 0:
            count_text = f"📍 You've saved {count} place{'s' if count != 1 else ''}!"
        else:
            count_text = "📍 No places saved yet — let's find some!"

        await query.edit_message_text(
            f"Hey there! 👋\n\n"
            f"Send me an Instagram Reel or TikTok link, "
            f"and I'll dig up the spots mentioned and save them to your map. 🗺️\n\n"
            f"{count_text}",
            reply_markup=get_menu_keyboard(),
        )


def get_menu_keyboard():
    keyboard = []

    # Add viewer button if WEBAPP_URL is configured
    if config.WEBAPP_URL:
        keyboard.append([
            InlineKeyboardButton(
                "🗺️ Open My Map",
                web_app=WebAppInfo(url=config.WEBAPP_URL)
            )
        ])

    keyboard.append([
        InlineKeyboardButton("📍 Find places near me", callback_data="action_nearby"),
    ])

    return InlineKeyboardMarkup(keyboard)


def get_match_source_label(video_meta: dict) -> str:
    """Return a short label describing where the matches came from."""
    source = video_meta.get("match_source")
    if source in {"transcript", "chunk"}:
        return "transcript"
    if source == "video_ocr":
        return "video text"
    if source == "ocr":
        return "image text"
    if source in {"caption", "caption_pin", "caption_list"}:
        return "caption"
    if source == "mention":
        return "tagged account"
    return "reel details"


def get_confidence_badge(confidence_label: str) -> str:
    """Format a user-facing confidence badge."""
    badges = {
        "high": "High confidence",
        "likely": "Likely match",
        "possible": "Possible match",
    }
    return badges.get(confidence_label, "Possible match")


def format_selection_place_summary(
    place: dict,
    index: int,
    selected_indices: set,
    source_label: str,
) -> str:
    """Format a candidate place summary for the review message."""
    prefix = "☑️" if index in selected_indices else "⬜"
    title = f"{prefix} {index + 1}. {place['name']}"

    lines = [title]
    if place.get("address"):
        lines.append(f"   {place['address']}")

    meta_parts = []
    confidence_label = place.get("confidence_label")
    if confidence_label:
        meta_parts.append(get_confidence_badge(confidence_label))
    if place.get("types"):
        meta_parts.append(", ".join(t.replace("_", " ").title() for t in place["types"][:2]))
    if place.get("rating"):
        rating_text = f"{place['rating']}/5"
        if place.get("rating_count"):
            rating_text += f" ({place['rating_count']})"
        meta_parts.append(f"⭐ {rating_text}")
    if meta_parts:
        lines.append(f"   {' · '.join(meta_parts)}")

    reason = place.get("confidence_reason")
    if reason:
        lines.append(f"   {reason}")

    return "\n".join(lines)


def build_selection_message(places: list, selected_indices: set, video_meta: dict) -> str:
    """Build the ranked review message for multiple candidate places."""
    source_label = get_match_source_label(video_meta)
    selected_count = len(selected_indices)

    lines = [
        f"I found {len(places)} likely food places from this {source_label}.",
        "High-confidence matches are already selected for you.",
        "",
    ]

    for i, place in enumerate(places):
        lines.append(
            format_selection_place_summary(
                place,
                i,
                selected_indices,
                source_label=source_label,
            )
        )
        if i != len(places) - 1:
            lines.append("")

    unresolved_message = video_meta.get("unresolved_message")
    if unresolved_message:
        lines.append(unresolved_message)

    lines.extend([
        "",
        f"Selected now: {selected_count}",
        "Use the buttons to adjust the list, save your chosen places, or reject all of them.",
    ])

    return "\n".join(lines)


def build_selection_keyboard(places: list, selected_indices: set) -> InlineKeyboardMarkup:
    """Build keyboard for ranked multi-place review."""
    keyboard = []

    for i, place in enumerate(places):
        checkbox = "☑️" if i in selected_indices else "⬜"
        label = f"#{i + 1}"
        name = place["name"][:20] + "..." if len(place["name"]) > 20 else place["name"]
        keyboard.append([InlineKeyboardButton(f"{checkbox} {label}: {name}", callback_data=f"toggle_place_{i}")])

    selected_count = len(selected_indices)
    save_text = f"💾 Save Chosen ({selected_count})" if selected_count > 0 else "💾 Save Chosen"
    keyboard.append([
        InlineKeyboardButton(save_text, callback_data="save_selected"),
        InlineKeyboardButton("🚫 None Of These", callback_data="cancel_selection"),
    ])

    return InlineKeyboardMarkup(keyboard)


def collect_places_from_slot_suggestions(suggestions: list) -> tuple[list, list]:
    """Split slot suggestions into resolved Google places and unresolved evidence."""
    places = []
    unresolved = []

    for suggestion in suggestions:
        if suggestion.status == "resolved" and suggestion.selected:
            places.append(suggestion.selected)
        else:
            unresolved.append(suggestion)

    return places, unresolved


def build_unresolved_slot_message(unresolved_suggestions: list) -> str:
    """Explain source-backed slots that could not be safely resolved."""
    if not unresolved_suggestions:
        return ""

    lines = ["", "Needs review:"]
    for suggestion in unresolved_suggestions[:6]:
        evidence = suggestion.evidence
        source = evidence.source.replace("_", " ")
        reason = suggestion.reason or "Could not confidently match this to a food place."
        lines.append(f"- {evidence.name_candidate} ({source}): {reason}")

    if len(unresolved_suggestions) > 6:
        lines.append(f"- {len(unresolved_suggestions) - 6} more unresolved place names")

    return "\n".join(lines)


async def toggle_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Toggle place selection checkbox."""
    query = update.callback_query

    pending_places = context.user_data.get("pending_places")
    if not pending_places:
        await query.answer("Search expired!")
        await query.edit_message_text("That search expired! Send the link again. 🔄")
        return

    # Get or initialize selected indices
    selected = context.user_data.get("selected_indices", set())

    # Extract index and toggle
    try:
        index = int(query.data.replace("toggle_place_", ""))
        if index in selected:
            selected.discard(index)
            await query.answer("Removed")
        else:
            selected.add(index)
            await query.answer("Selected!")
    except (ValueError, IndexError):
        await query.answer("Error!")
        return

    context.user_data["selected_indices"] = selected

    # Rebuild keyboard and update message
    video_meta = context.user_data.get("pending_video_meta", {})
    keyboard = build_selection_keyboard(pending_places, selected)
    message = build_selection_message(pending_places, selected, video_meta)
    await query.edit_message_text(message, reply_markup=keyboard)


async def save_selected_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Save all selected places."""
    user_id = update.effective_user.id
    query = update.callback_query

    pending_places = context.user_data.get("pending_places")
    selected = context.user_data.get("selected_indices", set())

    if not pending_places:
        await query.answer("Search expired!")
        await query.edit_message_text("That search expired! Send the link again. 🔄")
        return

    if not selected:
        await query.answer("Pick some places first!")
        return

    await query.answer("Saving...")
    await query.edit_message_text("Saving your places... 💾")

    # Get metadata
    source_url = context.user_data.get("pending_url", "")
    source_platform = context.user_data.get("pending_platform", "unknown")
    video_meta = context.user_data.get("pending_video_meta", {})

    # Save all selected places
    saved_names = []
    for i in sorted(selected):
        place_data = pending_places[i]
        repository.add_place(
            user_id=user_id,
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
        saved_names.append(place_data["name"])

    # Clear pending data
    context.user_data.pop("pending_places", None)
    context.user_data.pop("pending_url", None)
    context.user_data.pop("pending_platform", None)
    context.user_data.pop("pending_video_meta", None)
    context.user_data.pop("selected_indices", None)

    # Show confirmation
    await query.delete_message()

    count = len(saved_names)
    if count == 1:
        await query.message.reply_text(
            f"✨ Saved **{saved_names[0]}** to your map!",
            parse_mode="Markdown"
        )
    else:
        names_text = "\n".join(f"• {name}" for name in saved_names)
        await query.message.reply_text(
            f"✨ Saved {count} places to your map!\n\n{names_text}",
            parse_mode="Markdown"
        )


async def cancel_selection_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cancel place selection."""
    query = update.callback_query
    await query.answer("Discarded")

    # Clear pending data
    context.user_data.pop("pending_places", None)
    context.user_data.pop("pending_url", None)
    context.user_data.pop("pending_platform", None)
    context.user_data.pop("pending_video_meta", None)
    context.user_data.pop("selected_indices", None)

    await query.edit_message_text(
        "Discarded those suggestions. Send another link whenever you're ready."
    )


async def incorrect_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Unsave an auto-saved single result and ask for the correct place name."""
    user_id = update.effective_user.id
    query = update.callback_query
    await query.answer()

    try:
        place_id = int(query.data.replace("incorrect_place_", ""))
    except ValueError:
        await query.edit_message_reply_markup(reply_markup=None)
        await query.message.reply_text("Reply with the correct place name and I'll search for it.")
        return

    correction_context = context.user_data.get("correction_place_context") or {}
    if correction_context.get("place_id") == place_id:
        context.user_data["pending_url"] = correction_context.get("source_url", "")
        context.user_data["pending_platform"] = correction_context.get("source_platform", "unknown")
        context.user_data.pop("correction_place_context", None)

    deleted = repository.delete_place(user_id, place_id)
    await query.edit_message_reply_markup(reply_markup=None)

    if deleted:
        await query.message.reply_text(
            "Removed that saved place.\n\n"
            "Reply with the correct place name and I'll search for it instead."
        )
    else:
        await query.message.reply_text(
            "That saved place was already removed.\n\n"
            "Reply with the correct place name and I'll search for it instead."
        )


async def handle_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    text = update.message.text.strip()

    if not is_valid_url(text):
        return  # Not a valid Instagram/TikTok URL, ignore

    status_msg = await update.message.reply_text("Ooh, fresh content! Let me dig in... 🔍")

    try:
        # Step 1: Download
        await status_msg.edit_text("Downloading video... 📥")
        result = await download_content(text)

        # Step 2: Extract source-backed place slots, then resolve each slot.
        places = []
        unresolved_suggestions = []
        slots = []
        ocr_text = ""
        video_ocr_payload = {}
        match_source = None
        transcription_result = None
        metadata_text = f"{result.title} {result.description}".strip()

        def build_metadata_record():
            return build_runtime_metadata_record(
                title=result.title,
                description=result.description,
                source_url=text,
                platform=result.platform,
                content_type=result.content_type,
                uploader=result.uploader,
                duration=result.duration,
                hashtags=result.hashtags,
                ocr_text=ocr_text,
                video_ocr=video_ocr_payload,
                transcription=transcription_result,
            )

        if metadata_text:
            await status_msg.edit_text("Reading the caption... 📝")
            slots = extract_place_evidence_from_metadata(build_metadata_record())

        # Step 3: For photo posts, OCR images only if caption/title did not yield slots.
        if not slots and result.image_paths:
            await status_msg.edit_text("Scanning images for text... 🖼️")
            try:
                ocr_text = extract_text_from_images(result.image_paths)
            except Exception as e:
                logger.warning(f"OCR failed: {e}")

            if ocr_text:
                slots = extract_place_evidence_from_metadata(build_metadata_record())

        # Step 4: For videos, OCR sampled frames only if no text/image slots were found.
        if not slots and result.video_path and result.video_path.exists():
            await status_msg.edit_text("Scanning video text... 🖼️")
            try:
                video_ocr_payload = extract_text_from_video(result.video_path)
            except Exception as e:
                logger.warning(f"Video OCR failed: {e}")
                video_ocr_payload = {}

            if video_ocr_payload.get("combined_text"):
                slots = extract_place_evidence_from_metadata(build_metadata_record())

        # Step 5: If still no slots and audio exists, fallback to transcription.
        if not slots and result.audio_path and result.audio_path.exists():
            await status_msg.edit_text("Transcribing audio... 🎤")
            try:
                transcription_result = await transcribe_audio(result.audio_path)
            except Exception as e:
                logger.warning(f"Transcription failed: {e}")

            if transcription_result:
                slots = extract_place_evidence_from_metadata(build_metadata_record())

        if slots:
            await status_msg.edit_text("Resolving place names... 🔎")
            suggestions = await resolve_place_slots(slots)
            places, unresolved_suggestions = collect_places_from_slot_suggestions(suggestions)
            resolved_sources = [place.matched_source_type for place in places if place.matched_source_type]
            if resolved_sources:
                match_source = resolved_sources[0]
            elif slots:
                match_source = slots[0].source

        # Handle case where no location could be found
        if not places:
            transcript_text = transcription_result.text if transcription_result else ""
            video_ocr_text = video_ocr_payload.get("combined_text", "") if video_ocr_payload else ""
            combined_text = f"{metadata_text} {ocr_text} {video_ocr_text} {transcript_text}".strip()
            if not combined_text:
                await status_msg.edit_text(
                    "Hmm, couldn't find any text or audio to work with. 🤔\n\n"
                    "Reply with the place name and I'll search for it!"
                )
            elif unresolved_suggestions:
                await status_msg.edit_text(
                    "I found possible place names, but couldn't safely match them to a specific food place. 🔍\n"
                    f"{build_unresolved_slot_message(unresolved_suggestions)}\n\n"
                    "Reply with the exact place or branch name and I'll search for it."
                )
            else:
                # Show detected language if transcription was used
                lang_hint = ""
                if transcription_result and transcription_result.language != "en":
                    lang_name = get_language_name(transcription_result.language)
                    lang_hint = f" ({lang_name})"
                await status_msg.edit_text(
                    f"Couldn't spot a specific place{lang_hint}. 🔍\n\n"
                    f"I found: \"{combined_text[:180]}...\"\n\n"
                    "Reply with the place name and I'll dig it up!"
                )
            context.user_data["pending_url"] = text
            context.user_data["pending_platform"] = result.platform
            cleanup_files(result.video_path, result.audio_path, *result.image_paths)
            return

        # Extract video metadata for storage
        source_title = result.title
        source_uploader = result.uploader
        source_duration = result.duration
        source_hashtags = ",".join(result.hashtags) if result.hashtags else None

        # Step 4: Handle results based on count
        if len(places) == 1 and not unresolved_suggestions:
            # Single place: auto-save (backward compatible behavior)
            place = places[0]
            saved_place = repository.add_place(
                user_id=user_id,
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
                source_transcript_en=(
                    (transcription_result.preferred_text or transcription_result.english_text)
                    if transcription_result else None
                ),
            )

            await status_msg.delete()

            # Send location pin
            await update.message.reply_location(
                latitude=place.latitude,
                longitude=place.longitude,
            )

            # Build rich confirmation message
            confirmation = f"✅ Saved: {place.name}!\n📍 {place.address}"
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

            # Add links
            confirmation += "\n"
            if place.place_id:
                maps_url = f"https://www.google.com/maps/search/?api=1&query={quote(place.name)}&query_place_id={place.place_id}"
            else:
                maps_url = f"https://www.google.com/maps/search/?api=1&query={place.latitude},{place.longitude}"
            confirmation += f"\n🗺️ Google Maps: {maps_url}"
            confirmation += f"\n▶️ Original: {text}"

            correction_keyboard = InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "This is incorrect",
                    callback_data=f"incorrect_place_{saved_place.id}",
                )
            ]])
            context.user_data["correction_place_context"] = {
                "place_id": saved_place.id,
                "source_url": text,
                "source_platform": result.platform,
            }

            await update.message.reply_text(
                confirmation,
                reply_markup=correction_keyboard,
                disable_web_page_preview=True,
            )
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
                    "confidence_score": p.confidence_score,
                    "confidence_label": p.confidence_label,
                    "confidence_reason": p.confidence_reason,
                    "matched_query": p.matched_query,
                    "matched_source_type": p.matched_source_type,
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
                "source_transcript_en": (
                    (transcription_result.preferred_text or transcription_result.english_text)
                    if transcription_result else None
                ),
                "match_source": match_source,
                "unresolved_message": build_unresolved_slot_message(unresolved_suggestions),
            }

            # Preselect every high-confidence result; otherwise fall back to the top-ranked result.
            high_confidence_indices = {
                i for i, place in enumerate(context.user_data["pending_places"])
                if place.get("confidence_label") == "high"
            }
            context.user_data["selected_indices"] = high_confidence_indices or {0}

            selected = context.user_data["selected_indices"]
            keyboard = build_selection_keyboard(context.user_data["pending_places"], selected)
            review_text = build_selection_message(
                context.user_data["pending_places"],
                selected,
                context.user_data["pending_video_meta"],
            )

            await status_msg.edit_text(
                review_text,
                reply_markup=keyboard,
            )

        # Cleanup temp files
        cleanup_files(result.video_path, result.audio_path, *result.image_paths)

    except DownloadTimeoutError:
        logger.error("Download timed out")
        await status_msg.edit_text(
            "This one's taking too long! 🐌\n\nTry a shorter video?"
        )
    except VideoTooLongError as e:
        logger.warning(f"Video too long: {e}")
        await status_msg.edit_text(
            f"That video's too long! 📹\n\nMax {config.MAX_VIDEO_DURATION // 60} minutes allowed."
        )
    except Exception as e:
        logger.error(f"Error processing URL: {e}")
        if "connect" in str(e).lower() or "network" in str(e).lower():
            await status_msg.edit_text(
                "Hit a connection snag! 🌧️\n\nGive it a moment and try again."
            )
        else:
            await status_msg.edit_text(
                "Oops, something went wrong!\n\nMind trying that again?"
            )


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle text messages that might be place name responses."""
    user_id = update.effective_user.id
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

    status_msg = await update.message.reply_text("Digging for that place... 🔍")

    try:
        place = await search_place(text)

        if not place:
            await status_msg.edit_text(
                f"Couldn't find \"{text}\" 🤔\n\nTry a more specific name or add the city!"
            )
            return

        # Save the place
        saved_place = repository.add_place(
            user_id=user_id,
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
            f"✅ Saved: {place.name}!\n"
            f"📍 {place.address}"
        )

    except Exception as e:
        logger.error(f"Error searching place: {e}")
        await status_msg.edit_text(
            "Hmm, couldn't find that one. Try a different name?"
        )


async def delete_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show list of places to delete."""
    user_id = update.effective_user.id
    places = repository.get_all_places(user_id)

    if not places:
        await update.message.reply_text("Nothing to remove! No places saved yet. 📍")
        return

    keyboard = []
    for place in places:
        name = place['name'][:25] + "..." if len(place['name']) > 25 else place['name']
        keyboard.append([InlineKeyboardButton(name, callback_data=f"delete_place_{place['id']}")])

    await update.message.reply_text(
        "Which place would you like to remove? 🗑️",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


async def delete_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle place deletion from inline keyboard."""
    user_id = update.effective_user.id
    query = update.callback_query
    await query.answer()

    # Extract place_id from callback data (format: "delete_place_{id}")
    try:
        place_id = int(query.data.replace("delete_place_", ""))
    except ValueError:
        await query.edit_message_text("Oops, something went wrong. Try again!")
        return

    # Delete the place
    deleted = repository.delete_place(user_id, place_id)

    if deleted:
        await query.edit_message_text("Removed! 🗑️")
    else:
        await query.edit_message_text("That one's already gone!")


async def nearby_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Request location to find nearby saved places."""
    # Create location request button
    keyboard = [[KeyboardButton("📍 Share My Location", request_location=True)]]
    reply_markup = ReplyKeyboardMarkup(keyboard, one_time_keyboard=True, resize_keyboard=True)

    await update.message.reply_text(
        "Let's see what's saved near you! 📍\n\n"
        "Tap below to share your location:",
        reply_markup=reply_markup
    )


async def handle_location(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle shared location and show top 5 nearest saved places."""
    user_id = update.effective_user.id
    location = update.message.location
    lat, lng = location.latitude, location.longitude

    places = repository.get_all_places(user_id)
    if not places:
        await update.message.reply_text(
            "No places saved yet! 📍\n\n"
            "Send me a video link and I'll find some for you!",
            reply_markup=ReplyKeyboardRemove()
        )
        return

    # Calculate distances for ALL places (no radius limit)
    places_with_dist = []
    for place in places:
        if place['latitude'] and place['longitude']:
            dist = haversine_distance(lat, lng, place['latitude'], place['longitude'])
            places_with_dist.append((place, dist))

    # Sort by distance and take top 5
    places_with_dist.sort(key=lambda x: x[1])
    top_5 = places_with_dist[:5]

    if not top_5:
        await update.message.reply_text(
            "Hmm, your places don't have location data. 🤔\n\n"
            "Try adding some new ones!",
            reply_markup=ReplyKeyboardRemove()
        )
        return

    # Format clean response with inline links
    text = f"📍 Your 5 nearest places:\n\n"
    for place, dist in top_5:
        dist_str = f"{int(dist * 1000)}m" if dist < 1 else f"{dist:.1f}km"

        # Build Google Maps URL
        if place.get('google_place_id'):
            maps_url = f"https://www.google.com/maps/search/?api=1&query={quote(place['name'])}&query_place_id={place['google_place_id']}"
        else:
            maps_url = f"https://www.google.com/maps/search/?api=1&query={place['latitude']},{place['longitude']}"

        # Build line with clickable links
        text += f"<b>{place['name']}</b> ({dist_str})\n"
        links = [f'<a href="{maps_url}">Google Maps</a>']
        if place.get('source_url'):
            links.append(f'<a href="{place["source_url"]}">Visit Reel</a>')
        text += " · ".join(links) + "\n\n"

    total = len(places_with_dist)
    if total > 5:
        text += f"<i>+{total - 5} more saved places</i>"

    # Remove reply keyboard first
    await update.message.reply_text(
        text,
        reply_markup=ReplyKeyboardRemove(),
        parse_mode="HTML",
        disable_web_page_preview=True
    )

    # Send View My Places button
    if config.WEBAPP_URL:
        keyboard = [[
            InlineKeyboardButton(
                "🗺️ Open My Map",
                web_app=WebAppInfo(url=config.WEBAPP_URL)
            )
        ]]
        await update.message.reply_text(
            "See all your places on a map:",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )


# ========== REVIEW CONVERSATION HANDLERS ==========

PRICE_LABELS = ['', 'Budget-friendly', 'Affordable', 'Moderate', 'Pricey', 'Splurge']


def clear_review_context(context: ContextTypes.DEFAULT_TYPE):
    """Clear all review-related context."""
    keys = ['review_place_id', 'review_place_name', 'review_dishes',
            'review_current_dish', 'review_overall', 'review_price', 'review_remarks']
    for key in keys:
        context.user_data.pop(key, None)


def build_review_summary(place_name: str, review_data: dict) -> str:
    """Build formatted review summary."""
    overall_stars = '⭐' * review_data['overall_rating']
    price_money = '💰' * review_data['price_rating']

    lines = [
        f"*{place_name}*",
        f"{overall_stars} · {price_money}",
        ""
    ]

    for dish in review_data['dishes']:
        dish_stars = '⭐' * dish['rating']
        line = f"• {dish['name']} {dish_stars}"
        if dish.get('remarks'):
            line += f'\n  "{dish["remarks"]}"'
        lines.append(line)

    if review_data.get('overall_remarks'):
        lines.append("")
        lines.append(f'"{review_data["overall_remarks"]}"')

    return '\n'.join(lines)


async def review_dish_name(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle dish name input."""
    text = update.message.text.strip().lower()

    if text == 'done':
        # Move to overall ratings
        if not context.user_data.get('review_dishes'):
            await update.message.reply_text(
                "Please add at least one dish before finishing.\n"
                "What did you order?"
            )
            return REVIEW_DISH_NAME

        await update.message.reply_text(
            "Now for the overall...\n\n"
            f"How would you rate *{context.user_data['review_place_name']}* overall? (1-5)",
            parse_mode='Markdown'
        )
        return REVIEW_OVERALL_RATING

    # Store dish name and ask for rating
    context.user_data['review_current_dish'] = {'name': update.message.text.strip()}

    await update.message.reply_text(
        f"*{update.message.text.strip()}* - Rating? (1-5 stars)",
        parse_mode='Markdown'
    )
    return REVIEW_DISH_RATING


async def review_dish_rating(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle dish rating input."""
    try:
        rating = int(update.message.text.strip())
        if rating < 1 or rating > 5:
            raise ValueError()
    except ValueError:
        await update.message.reply_text("Please enter a number 1-5")
        return REVIEW_DISH_RATING

    context.user_data['review_current_dish']['rating'] = rating
    stars = '⭐' * rating + '☆' * (5 - rating)

    await update.message.reply_text(
        f"{stars} Nice! Any quick note about it? (or 'skip')"
    )
    return REVIEW_DISH_REMARKS


async def review_dish_remarks(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle dish remarks input."""
    text = update.message.text.strip()

    dish = context.user_data['review_current_dish']
    dish['remarks'] = None if text.lower() == 'skip' else text

    # Add completed dish to list
    context.user_data['review_dishes'].append(dish)
    context.user_data['review_current_dish'] = None

    await update.message.reply_text(
        "Got it! Another dish? (or 'done')"
    )
    return REVIEW_DISH_NAME


async def review_overall_rating(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle overall rating input."""
    try:
        rating = int(update.message.text.strip())
        if rating < 1 or rating > 5:
            raise ValueError()
    except ValueError:
        await update.message.reply_text("Please enter a number 1-5")
        return REVIEW_OVERALL_RATING

    context.user_data['review_overall'] = rating
    stars = '⭐' * rating

    await update.message.reply_text(
        f"{stars} And how's the pricing? (1-5, where 1=budget, 5=splurge)"
    )
    return REVIEW_PRICE_RATING


async def review_price_rating(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle price rating input."""
    try:
        rating = int(update.message.text.strip())
        if rating < 1 or rating > 5:
            raise ValueError()
    except ValueError:
        await update.message.reply_text("Please enter a number 1-5")
        return REVIEW_PRICE_RATING

    context.user_data['review_price'] = rating
    money = '💰' * rating

    await update.message.reply_text(
        f"{money} {PRICE_LABELS[rating]}. Any final thoughts? (or 'skip')"
    )
    return REVIEW_OVERALL_REMARKS


async def review_overall_remarks(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle overall remarks and save review."""
    text = update.message.text.strip()
    context.user_data['review_remarks'] = None if text.lower() == 'skip' else text

    # Save review to database
    place_id = context.user_data['review_place_id']
    place_name = context.user_data['review_place_name']

    review_data = {
        'overall_rating': context.user_data['review_overall'],
        'price_rating': context.user_data['review_price'],
        'overall_remarks': context.user_data['review_remarks'],
        'dishes': context.user_data['review_dishes']
    }

    try:
        # Get user_id from Telegram
        user_id = update.effective_user.id
        repository.create_or_update_review(
            place_id=place_id,
            user_id=user_id,
            overall_rating=review_data['overall_rating'],
            price_rating=review_data['price_rating'],
            overall_remarks=review_data['overall_remarks'],
            dishes=review_data['dishes']
        )

        # Build summary message
        summary = build_review_summary(place_name, review_data)

        await update.message.reply_text(
            f"Review saved! 🎉\n\n{summary}\n\n"
            f"View & edit anytime in the Mini App! ✨",
            parse_mode='Markdown'
        )
    except Exception as e:
        logger.error(f"Failed to save review: {e}")
        await update.message.reply_text(
            "Oops, couldn't save your review. Please try again!"
        )

    # Clear review context
    clear_review_context(context)
    return ConversationHandler.END


async def cancel_review(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cancel review conversation."""
    clear_review_context(context)
    await update.message.reply_text(
        "Review cancelled. You can start again anytime!"
    )
    return ConversationHandler.END


async def handle_review_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle 'Write Review' button callback."""
    user_id = update.effective_user.id
    query = update.callback_query
    await query.answer()

    # Callback data format: "review:place_id:place_name"
    parts = query.data.split(':', 2)
    if len(parts) != 3 or parts[0] != 'review':
        return

    place_id = int(parts[1])
    place_name = parts[2]

    # Check if place is marked as visited
    place = repository.get_place_by_id(user_id, place_id)

    if not place:
        await query.message.reply_text("❌ Place not found!")
        return ConversationHandler.END

    if not place.get('is_visited'):
        await query.message.reply_text(
            f"📍 Please mark *{place_name}* as visited first before writing a review!\n\n"
            f"You can mark it as visited in the Mini App viewer.",
            parse_mode='Markdown'
        )
        return ConversationHandler.END

    # Place is visited, proceed with review
    await query.message.reply_text(
        f"Great! Let's review *{place_name}* 📝\n\n"
        f"What did you order? (type dish name, or 'done' when finished)",
        parse_mode='Markdown'
    )

    context.user_data['review_place_id'] = place_id
    context.user_data['review_place_name'] = place_name
    context.user_data['review_dishes'] = []
    context.user_data['review_current_dish'] = None

    # Return the first state to enter the conversation
    return REVIEW_DISH_NAME


async def handle_remind_later(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle 'Ask Later' button - reschedule reminder."""
    query = update.callback_query
    await query.answer()

    # Callback data format: "remind_later:reminder_id"
    parts = query.data.split(':')
    if len(parts) != 2:
        return

    reminder_id = int(parts[1])

    # Reset the reminder to trigger again in 1 hour
    reminder = repository.reschedule_reminder(reminder_id)

    if reminder:
        await query.edit_message_text(
            "No problem! I'll ask again later 😊"
        )
    else:
        await query.edit_message_text(
            "Got it!"
        )


async def handle_remind_stop(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle 'Don't Ask' button - stop reminders for this place."""
    query = update.callback_query
    await query.answer()

    # Callback data format: "remind_stop:place_id"
    parts = query.data.split(':')
    if len(parts) != 2:
        return

    place_id = int(parts[1])
    user_id = update.effective_user.id

    repository.set_dont_ask_again(place_id, user_id)

    await query.edit_message_text(
        "Got it, I won't ask about this place again.\n"
        "You can always review it in the Mini App! 📱"
    )


async def handle_dismiss(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle 'Maybe Later' or dismiss button."""
    query = update.callback_query
    await query.answer()
    # Just acknowledge, don't delete message
    # The reminder will still fire in 1 hour


# Review conversation handler
review_conversation_handler = ConversationHandler(
    entry_points=[
        CallbackQueryHandler(handle_review_callback, pattern=r'^review:')
    ],
    states={
        REVIEW_DISH_NAME: [
            MessageHandler(filters.TEXT & ~filters.COMMAND, review_dish_name)
        ],
        REVIEW_DISH_RATING: [
            MessageHandler(filters.TEXT & ~filters.COMMAND, review_dish_rating)
        ],
        REVIEW_DISH_REMARKS: [
            MessageHandler(filters.TEXT & ~filters.COMMAND, review_dish_remarks)
        ],
        REVIEW_OVERALL_RATING: [
            MessageHandler(filters.TEXT & ~filters.COMMAND, review_overall_rating)
        ],
        REVIEW_PRICE_RATING: [
            MessageHandler(filters.TEXT & ~filters.COMMAND, review_price_rating)
        ],
        REVIEW_OVERALL_REMARKS: [
            MessageHandler(filters.TEXT & ~filters.COMMAND, review_overall_remarks)
        ],
    },
    fallbacks=[
        CommandHandler('cancel', cancel_review)
    ],
    name="review_conversation",
    persistent=False,
    per_chat=True,
    per_user=True
)
