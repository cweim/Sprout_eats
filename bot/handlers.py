import asyncio
import logging
import math
import html
import re
import uuid
import warnings
from io import BytesIO
from urllib.parse import quote
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo, KeyboardButton, ReplyKeyboardMarkup, ReplyKeyboardRemove
from telegram.error import BadRequest
from telegram.warnings import PTBUserWarning
from telegram.ext import ContextTypes, ConversationHandler, MessageHandler, CommandHandler, CallbackQueryHandler, filters

import config
from services.downloader import (
    download_content,
    is_valid_url,
    cleanup_files,
    detect_platform,
    instagram_request_will_queue,
    get_instagram_queue_status,
    DownloadTimeoutError,
    VideoTooLongError,
    InstagramAccessError,
    InstagramCooldownError,
)
from services.places import search_place
from services.place_pipeline import (
    build_runtime_metadata_record,
    extract_place_evidence_from_metadata,
    resolve_place_slots,
)
from services.maps import generate_map_image
from services.instagram_pipeline import (
    InstagramNoCookieCooldownError,
    run_instagram_place_pipeline,
)
from services.tiktok_pipeline import run_tiktok_place_pipeline
from database import supabase_repository as repository
from database.supabase_client import (
    upload_photo as storage_upload_photo,
    upload_feedback_attachment as storage_upload_feedback_attachment,
)

logger = logging.getLogger(__name__)

warnings.filterwarnings(
    "ignore",
    message=r"If 'per_message=False', 'CallbackQueryHandler' will not be tracked for every message\..*",
    category=PTBUserWarning,
)


def _is_stale_callback_error(error: BadRequest) -> bool:
    message = str(error).lower()
    return "query is too old" in message or "query id is invalid" in message


def _is_noop_edit_error(error: BadRequest) -> bool:
    return "message is not modified" in str(error).lower()


async def _safe_answer_callback(query, text: str) -> bool:
    try:
        await query.answer(text)
        return True
    except BadRequest as exc:
        if _is_stale_callback_error(exc):
            logger.info("Ignoring stale callback answer for query %s: %s", query.id, exc)
            return False
        raise


async def _safe_edit_callback_message(query, text: str, reply_markup=None) -> bool:
    try:
        await query.edit_message_text(text, reply_markup=reply_markup)
        return True
    except BadRequest as exc:
        if _is_noop_edit_error(exc):
            logger.info("Skipping no-op callback message edit for query %s", query.id)
            return False
        if _is_stale_callback_error(exc):
            logger.info("Ignoring stale callback edit for query %s: %s", query.id, exc)
            return False
        raise

FEEDBACK_CATEGORY = 200
FEEDBACK_COLLECT = 201
MAX_TELEGRAM_REVIEW_PHOTOS = 10
MAX_FEEDBACK_IMAGES = 5

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


def get_saved_place_id(saved_place) -> int | None:
    """Return a saved place id from either Supabase dicts or legacy ORM objects."""
    if not saved_place:
        return None
    if isinstance(saved_place, dict):
        return saved_place.get("id")
    return getattr(saved_place, "id", None)


def get_place_value(place, key: str, default=None):
    """Read place attributes from either dicts or PlaceResult-like objects."""
    if isinstance(place, dict):
        return place.get(key, default)
    return getattr(place, key, default)


GENERIC_PLACE_TYPES = {
    "food",
    "point_of_interest",
    "establishment",
    "store",
}


def format_place_types(types, limit: int = 2) -> str:
    """Return concise, user-facing Google place types."""
    if not types:
        return ""
    if isinstance(types, str):
        raw_types = [t.strip() for t in types.split(",")]
    else:
        raw_types = list(types)

    display_types = []
    for place_type in raw_types:
        place_type = str(place_type).strip()
        if not place_type or place_type in GENERIC_PLACE_TYPES:
            continue
        display_types.append(place_type.replace("_", " ").title())
        if len(display_types) >= limit:
            break
    return ", ".join(display_types)


def format_rating_line(rating, rating_count=None) -> str:
    """Format rating compactly without forcing noisy precision."""
    if not rating:
        return ""
    try:
        rating_float = float(rating)
        rating_text = str(int(rating_float)) if rating_float.is_integer() else f"{rating_float:.1f}"
    except (TypeError, ValueError):
        rating_text = str(rating)

    if rating_count:
        try:
            count_text = f"{int(rating_count):,}"
        except (TypeError, ValueError):
            count_text = str(rating_count)
        return f"⭐ {rating_text}/5 ({count_text} reviews)"
    return f"⭐ {rating_text}/5"


def build_google_maps_url(place) -> str:
    """Build a Google Maps link for either a Google place id or coordinates."""
    name = str(get_place_value(place, "name", ""))
    place_id = get_place_value(place, "place_id") or get_place_value(place, "google_place_id")
    latitude = get_place_value(place, "latitude")
    longitude = get_place_value(place, "longitude")

    if place_id:
        return f"https://www.google.com/maps/search/?api=1&query={quote(name)}&query_place_id={place_id}"
    if latitude is not None and longitude is not None:
        return f"https://www.google.com/maps/search/?api=1&query={latitude},{longitude}"
    return f"https://www.google.com/maps/search/?api=1&query={quote(name)}"


def _open_map_keyboard() -> InlineKeyboardMarkup | None:
    """Return a one-button keyboard to open the Mini App, or None if not configured."""
    if not config.WEBAPP_URL:
        return None
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("🗺️ View on Map", web_app=WebAppInfo(url=config.WEBAPP_URL))
    ]])


def build_saved_place_message(place, source_url: str | None = None) -> str:
    """Build a concise saved-place confirmation with labeled links."""
    name = html.escape(str(get_place_value(place, "name", "this place")))
    address = get_place_value(place, "address")
    rating = get_place_value(place, "rating") or get_place_value(place, "place_rating")
    rating_count = get_place_value(place, "rating_count") or get_place_value(place, "place_rating_count")
    types = get_place_value(place, "types") or get_place_value(place, "place_types")

    lines = [f"✅ Saved <b>{name}</b>"]
    if address:
        lines.append(f"📍 {html.escape(str(address))}")

    meta_parts = []
    rating_text = format_rating_line(rating, rating_count)
    if rating_text:
        meta_parts.append(html.escape(rating_text))
    type_text = format_place_types(types)
    if type_text:
        meta_parts.append(html.escape(type_text))
    if meta_parts:
        lines.append(" · ".join(meta_parts))

    links = [
        f'<a href="{build_google_maps_url(place)}">Google Maps</a>'
    ]
    if source_url:
        links.append(f'<a href="{source_url}">Original</a>')
    lines.append("🔗 " + " · ".join(links))

    return "\n".join(lines)


async def safe_edit_status(status_msg, text: str):
    """Best-effort status edit; avoids secondary crashes after message deletion."""
    try:
        await status_msg.edit_text(text)
    except Exception:
        logger.warning("Could not edit status message", exc_info=True)


def ensure_bot_user(update: Update):
    """Ensure the Telegram user exists in the users table before bot-side writes."""
    telegram_user = update.effective_user
    if not telegram_user:
        return None

    return repository.ensure_user_exists(
        telegram_user.id,
        username=telegram_user.username,
        first_name=telegram_user.first_name,
        last_name=telegram_user.last_name,
        language_code=telegram_user.language_code,
    )


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Handle group review deep link
    if context.args and context.args[0].startswith("grpreview_"):
        try:
            place_id = int(context.args[0].replace("grpreview_", ""))
        except ValueError:
            return
        ensure_bot_user(update)
        place = repository.get_group_place_by_id(place_id)
        if place and config.WEBAPP_URL:
            place_name = place.get("name", "")
            review_url = f"{config.WEBAPP_URL}?startapp=review_{place_id}&pn={quote(place_name)}"
            await update.message.reply_text(
                f"How was <b>{html.escape(place_name)}</b>? Leave a review 👇",
                parse_mode="HTML",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("⭐ Write Review", web_app=WebAppInfo(url=review_url))
                ]]),
            )
        else:
            await update.message.reply_text("Couldn't find that place.")
        return

    user_id = update.effective_user.id
    ensure_bot_user(update)

    count = repository.get_place_count(user_id)

    if count == 0:
        # New user — explain what the bot does
        text = (
            "Hey! 👋 I save food places from Instagram Reels and TikTok.\n\n"
            "Send me a video link and I'll extract the restaurant or cafe "
            "and pin it to your personal map. 🗺️"
        )
        keyboard = []
        if config.WEBAPP_URL:
            keyboard.append([InlineKeyboardButton("🗺️ Open My Map", web_app=WebAppInfo(url=config.WEBAPP_URL))])
        keyboard.append([InlineKeyboardButton("❓ How it works", callback_data="action_howto")])
    else:
        # Returning user — show personalised summary
        recent = repository.get_most_recent_place(user_id)
        recent_line = ""
        if recent:
            from datetime import datetime, timezone
            try:
                added_at = datetime.fromisoformat(recent['created_at'].replace('Z', '+00:00'))
                days_ago = (datetime.now(timezone.utc) - added_at).days
                if days_ago == 0:
                    when = "today"
                elif days_ago == 1:
                    when = "yesterday"
                else:
                    when = f"{days_ago} days ago"
                recent_line = f"\n📍 Last saved: {recent['name']}, {when}"
            except Exception:
                pass

        text = (
            f"Hey! 👋 You've saved {count} place{'s' if count != 1 else ''}."
            f"{recent_line}\n\n"
            "Send me a video link to save more."
        )
        keyboard = []
        if config.WEBAPP_URL:
            keyboard.append([InlineKeyboardButton("🗺️ Open My Map", web_app=WebAppInfo(url=config.WEBAPP_URL))])
        keyboard.append([InlineKeyboardButton("📍 Find places near me", callback_data="action_nearby")])

    await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard))


async def places_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [[InlineKeyboardButton("🗺️ Open My Map", web_app=WebAppInfo(url=config.WEBAPP_URL))]] if config.WEBAPP_URL else []
    await update.message.reply_text(
        "See all your saved places on the interactive map 👇",
        reply_markup=InlineKeyboardMarkup(keyboard) if keyboard else None,
    )


async def map_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [[InlineKeyboardButton("🗺️ Open My Map", web_app=WebAppInfo(url=config.WEBAPP_URL))]] if config.WEBAPP_URL else []
    await update.message.reply_text(
        "Your interactive map is in the app — tap to explore 👇",
        reply_markup=InlineKeyboardMarkup(keyboard) if keyboard else None,
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
    keyboard = [[InlineKeyboardButton("🗺️ Open My Map", web_app=WebAppInfo(url=config.WEBAPP_URL))]] if config.WEBAPP_URL else []
    await update.message.reply_text(
        "To manage or remove your saved places, open the app 👇",
        reply_markup=InlineKeyboardMarkup(keyboard) if keyboard else None,
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

    elif query.data == "action_howto":
        skip_btn = InlineKeyboardMarkup([[InlineKeyboardButton("✕ Skip", callback_data="dismiss")]])

        await query.edit_message_text(
            "🔗 *Step 1 — Send a link*\n\n"
            "Paste any Instagram Reel or TikTok video that features a restaurant or cafe.\n"
            "I'll extract the place and save it to your map automatically.",
            parse_mode="Markdown",
            reply_markup=skip_btn,
        )
        await asyncio.sleep(0.6)

        step2_keyboard = []
        if config.WEBAPP_URL:
            step2_keyboard.append([InlineKeyboardButton("🗺️ Open My Map →", web_app=WebAppInfo(url=config.WEBAPP_URL))])
        step2_keyboard.append([InlineKeyboardButton("✕ Skip", callback_data="dismiss")])
        await query.message.reply_text(
            "🗺️ *Step 2 — Explore your map*\n\n"
            "Your saved places show up in an interactive map. Tap any pin to see details or get directions.",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(step2_keyboard),
        )
        await asyncio.sleep(0.6)

        await query.message.reply_text(
            "⭐ *Step 3 — Leave reviews*\n\n"
            "After visiting a place, write a quick review — rating, dishes, photos. Find it in the Reviews tab.\n\n"
            "Ready! Just send me a video link to get started. 🎬",
            parse_mode="Markdown",
        )

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


def _clear_manual_place_pending(context: ContextTypes.DEFAULT_TYPE) -> None:
    context.user_data.pop("pending_url", None)
    context.user_data.pop("pending_platform", None)


def _clear_instagram_fallback_pending(context: ContextTypes.DEFAULT_TYPE) -> None:
    context.user_data.pop("instagram_fallback_pending", None)


def _set_tiktok_fallback_pending(context: ContextTypes.DEFAULT_TYPE, source_url: str) -> None:
    context.user_data["pending_url"] = source_url
    context.user_data["pending_platform"] = "tiktok"


async def prompt_tiktok_manual_fallback(
    status_msg,
    context: ContextTypes.DEFAULT_TYPE,
    source_url: str,
    *,
    unresolved_candidates: list[dict] | None = None,
) -> None:
    _set_tiktok_fallback_pending(context, source_url)
    if unresolved_candidates:
        context.user_data["pending_unresolved_slots"] = unresolved_candidates[:6]
        await status_msg.edit_text(
            "I found possible place matches, but couldn't verify them confidently enough to auto-save.\n"
            f"{build_reviewable_candidate_message(unresolved_candidates)}\n\n"
            "Reply with a number to pick one, or type the place name to search manually."
        )
    else:
        await status_msg.edit_text(
            "I couldn't find a place in this TikTok.\n\n"
            "Reply with the place name and I'll search for it."
        )


def _set_instagram_fallback_pending(context: ContextTypes.DEFAULT_TYPE, source_url: str) -> None:
    context.user_data["pending_url"] = source_url
    context.user_data["pending_platform"] = "instagram"
    context.user_data["instagram_fallback_pending"] = {
        "source_url": source_url,
        "platform": "instagram",
    }


async def prompt_instagram_manual_fallback(status_msg, context: ContextTypes.DEFAULT_TYPE, source_url: str, *, unresolved_candidates: list[dict] | None = None) -> None:
    context.user_data["pending_url"] = source_url
    context.user_data["pending_platform"] = "instagram"
    if unresolved_candidates:
        context.user_data["pending_unresolved_slots"] = unresolved_candidates[:6]
        await status_msg.edit_text(
            "I found possible place matches, but couldn't verify them confidently enough to auto-save.\n"
            f"{build_reviewable_candidate_message(unresolved_candidates)}\n\n"
            "Tap a suggestion to save it, or reply with the place name.",
            reply_markup=build_reviewable_candidate_keyboard(unresolved_candidates),
        )
        return

    await status_msg.edit_text(
        "I couldn't reliably extract the place from this Instagram post.\n\n"
        "Reply with the place name and I'll search for it."
    )


async def _save_single_place_result(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    user_id: int,
    place,
    source_url: str,
    source_platform: str,
    source_title: str | None = None,
    source_uploader: str | None = None,
    source_duration: int | None = None,
    source_hashtags: str | None = None,
    source_language: str | None = None,
    source_transcript: str | None = None,
    source_transcript_en: str | None = None,
    alt_candidates: list | None = None,
):
    saved_place = repository.add_place(
        user_id=user_id,
        name=place.name,
        address=place.address,
        latitude=place.latitude,
        longitude=place.longitude,
        google_place_id=place.place_id,
        source_url=source_url,
        source_platform=source_platform,
        source_title=source_title,
        source_uploader=source_uploader,
        source_duration=source_duration,
        source_hashtags=source_hashtags,
        place_types=",".join(place.types) if place.types else None,
        place_rating=place.rating,
        place_rating_count=place.rating_count,
        place_price_level=place.price_level,
        place_opening_hours=place.opening_hours,
        source_language=source_language,
        source_transcript=source_transcript,
        source_transcript_en=source_transcript_en,
    )

    await update.message.reply_location(
        latitude=place.latitude,
        longitude=place.longitude,
    )

    confirmation = build_saved_place_message(place, source_url=source_url)

    saved_place_id = get_saved_place_id(saved_place)
    correction_keyboard = None
    if saved_place_id:
        correction_keyboard = InlineKeyboardMarkup([[
            InlineKeyboardButton(
                "This is incorrect",
                callback_data=f"incorrect_place_{saved_place_id}",
            )
        ]])
        context.user_data["correction_place_context"] = {
            "place_id": saved_place_id,
            "source_url": source_url,
            "source_platform": source_platform,
            "candidates": alt_candidates or [],
        }

    await update.message.reply_text(
        confirmation,
        reply_markup=correction_keyboard,
        parse_mode="HTML",
        disable_web_page_preview=True,
    )


async def _start_multi_place_selection(
    context: ContextTypes.DEFAULT_TYPE,
    status_msg,
    *,
    places: list,
    source_url: str,
    source_platform: str,
    source_title: str | None = None,
    source_uploader: str | None = None,
    source_duration: int | None = None,
    source_hashtags: str | None = None,
    source_language: str | None = None,
    source_transcript: str | None = None,
    source_transcript_en: str | None = None,
    match_source: str | None = None,
    unresolved_message: str | None = None,
):
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
    context.user_data["pending_url"] = source_url
    context.user_data["pending_platform"] = source_platform
    context.user_data["pending_video_meta"] = {
        "source_title": source_title,
        "source_uploader": source_uploader,
        "source_duration": source_duration,
        "source_hashtags": source_hashtags,
        "source_language": source_language,
        "source_transcript": source_transcript,
        "source_transcript_en": source_transcript_en,
        "match_source": match_source,
        "unresolved_message": unresolved_message,
    }

    high_confidence_indices = {
        i for i, place in enumerate(context.user_data["pending_places"])
        if place.get("confidence_label") == "high"
    }
    context.user_data["selected_indices"] = high_confidence_indices or {0}
    _persist_place_session(context, update.effective_user.id)

    selected = context.user_data["selected_indices"]
    keyboard = build_selection_keyboard(context.user_data["pending_places"], selected)
    review_text = build_selection_message(
        context.user_data["pending_places"],
        selected,
        context.user_data["pending_video_meta"],
    )

    await status_msg.edit_text(review_text, reply_markup=keyboard)


async def _handle_instagram_no_cookie_url(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str, status_msg) -> bool:
    user_id = update.effective_user.id
    await status_msg.edit_text("Reading the caption... 📝")
    pipeline = await run_instagram_place_pipeline(text)

    if pipeline["status"] == "failed":
        logger.warning("Instagram no-cookie pipeline failed: user_id=%s url=%s error=%s", user_id, text, pipeline.get("error"))
        await prompt_instagram_manual_fallback(status_msg, context, text)
        return True

    candidate = pipeline.get("metadata_candidate")
    source_title = getattr(candidate, "title", "") if candidate else ""
    source_uploader = getattr(candidate, "uploader", None) if candidate else None
    source_duration = getattr(candidate, "duration", None) if candidate else None
    hashtags = getattr(candidate, "hashtags", []) if candidate else []
    source_hashtags = ",".join(hashtags) if hashtags else None
    slots = pipeline.get("slots") or []
    suggestions = pipeline.get("suggestions") or []
    places = pipeline.get("places") or []
    unresolved_suggestions = pipeline.get("unresolved_suggestions") or []

    if slots:
        await status_msg.edit_text("Resolving place names... 🔎")

    if not places:
        reviewable_candidates = collect_reviewable_unresolved_candidates(unresolved_suggestions)
        if not reviewable_candidates:
            caption_preview = (getattr(candidate, "description", "") or "")[:300]
            reason = "no_slots" if not slots else "no_google_match"
            try:
                repository.log_failed_extraction(user_id, text, platform="instagram", caption_preview=caption_preview, reason=reason)
            except Exception:
                pass
        await prompt_instagram_manual_fallback(
            status_msg,
            context,
            text,
            unresolved_candidates=reviewable_candidates if reviewable_candidates else None,
        )
        return True

    resolved_sources = [place.matched_source_type for place in places if place.matched_source_type]
    match_source = resolved_sources[0] if resolved_sources else (slots[0].source if slots else None)

    if len(places) == 1 and not unresolved_suggestions:
        await status_msg.delete()
        await _save_single_place_result(
            update,
            context,
            user_id=user_id,
            place=places[0],
            source_url=text,
            source_platform="instagram",
            source_title=source_title,
            source_uploader=source_uploader,
            source_duration=source_duration,
            source_hashtags=source_hashtags,
        )
        _clear_instagram_fallback_pending(context)
        return True

    await _start_multi_place_selection(
        context,
        status_msg,
        places=places,
        source_url=text,
        source_platform="instagram",
        source_title=source_title,
        source_uploader=source_uploader,
        source_duration=source_duration,
        source_hashtags=source_hashtags,
        match_source=match_source,
        unresolved_message=build_unresolved_slot_message(unresolved_suggestions),
    )
    _clear_instagram_fallback_pending(context)
    return True


async def _handle_tiktok_url(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str, status_msg) -> None:
    user_id = update.effective_user.id
    await status_msg.edit_text("Reading the caption... 📝")
    pipeline = await run_tiktok_place_pipeline(text)

    if pipeline["status"] == "failed":
        logger.warning("TikTok pipeline failed: user_id=%s url=%s error=%s", user_id, text, pipeline.get("error"))
        await prompt_tiktok_manual_fallback(status_msg, context, text)
        return

    candidate = pipeline.get("metadata_candidate")
    source_title = getattr(candidate, "title", "") if candidate else ""
    source_uploader = getattr(candidate, "uploader", None) if candidate else None
    source_duration = getattr(candidate, "duration", None) if candidate else None
    hashtags = getattr(candidate, "hashtags", []) if candidate else []
    source_hashtags = ",".join(hashtags) if hashtags else None
    slots = pipeline.get("slots") or []
    places = pipeline.get("places") or []
    unresolved_suggestions = pipeline.get("unresolved_suggestions") or []

    if slots:
        await status_msg.edit_text("Resolving place names... 🔎")

    if not places:
        reviewable_candidates = collect_reviewable_unresolved_candidates(unresolved_suggestions)
        if not reviewable_candidates:
            caption_preview = (getattr(candidate, "description", "") or "")[:300]
            reason = "no_slots" if not slots else "no_google_match"
            try:
                repository.log_failed_extraction(user_id, text, platform="tiktok", caption_preview=caption_preview, reason=reason)
            except Exception:
                pass
        await prompt_tiktok_manual_fallback(
            status_msg,
            context,
            text,
            unresolved_candidates=reviewable_candidates if reviewable_candidates else None,
        )
        return

    resolved_sources = [place.matched_source_type for place in places if place.matched_source_type]
    match_source = resolved_sources[0] if resolved_sources else (slots[0].source if slots else None)

    if len(places) == 1 and not unresolved_suggestions:
        await status_msg.delete()
        await _save_single_place_result(
            update,
            context,
            user_id=user_id,
            place=places[0],
            source_url=text,
            source_platform="tiktok",
            source_title=source_title,
            source_uploader=source_uploader,
            source_duration=source_duration,
            source_hashtags=source_hashtags,
        )
        _clear_manual_place_pending(context)
        return

    await _start_multi_place_selection(
        context,
        status_msg,
        places=places,
        source_url=text,
        source_platform="tiktok",
        source_title=source_title,
        source_uploader=source_uploader,
        source_duration=source_duration,
        source_hashtags=source_hashtags,
        match_source=match_source,
        unresolved_message=build_unresolved_slot_message(unresolved_suggestions),
    )
    _clear_manual_place_pending(context)


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
        f"Found {len(places)} likely food places from this {source_label}.",
        "High-confidence matches are preselected.",
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
        f"Selected: {selected_count}",
        "Tap places to adjust, then save.",
    ])

    return "\n".join(lines)


def build_selection_keyboard(places: list, selected_indices: set) -> InlineKeyboardMarkup:
    """Build keyboard for multi-place selection. Save All is the primary CTA."""
    keyboard = []

    # Primary CTA — save everything, one tap
    total = len(places)
    keyboard.append([
        InlineKeyboardButton(f"✅ Save All {total}", callback_data="save_all"),
    ])

    # Toggle rows for users who want to pick
    for i, place in enumerate(places):
        checkbox = "☑️" if i in selected_indices else "⬜"
        name = place["name"][:22] + "…" if len(place["name"]) > 22 else place["name"]
        keyboard.append([InlineKeyboardButton(f"{checkbox} {name}", callback_data=f"toggle_place_{i}")])

    selected_count = len(selected_indices)
    save_text = f"Save Selected ({selected_count})" if selected_count > 0 else "Save Selected"
    keyboard.append([
        InlineKeyboardButton(save_text, callback_data="save_selected"),
        InlineKeyboardButton("None of these", callback_data="cancel_selection"),
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

    lines = ["", "Possible places:"]
    for suggestion in unresolved_suggestions[:6]:
        evidence = suggestion.evidence
        source = evidence.source.replace("_", " ")
        lines.append(f"⬜ {evidence.name_candidate} ({source})")

    if len(unresolved_suggestions) > 6:
        lines.append(f"⬜ {len(unresolved_suggestions) - 6} more possible place names")

    return "\n".join(lines)


def build_unresolved_slot_keyboard(unresolved_suggestions: list) -> InlineKeyboardMarkup:
    """Build buttons to try unresolved candidate names one by one."""
    keyboard = []
    for index, suggestion in enumerate(unresolved_suggestions[:6]):
        name = suggestion.evidence.name_candidate
        label = name[:28] + "..." if len(name) > 28 else name
        keyboard.append([
            InlineKeyboardButton(f"Try: {label}", callback_data=f"unresolved_pick_{index}")
        ])
    return InlineKeyboardMarkup(keyboard)


def collect_reviewable_unresolved_candidates(unresolved_suggestions: list) -> list[dict]:
    """Flatten unresolved suggestions into real Google candidates worth showing."""
    candidates = []
    seen = set()

    for suggestion in unresolved_suggestions:
        for candidate in getattr(suggestion, "candidates", [])[:3]:
            place_id = getattr(candidate, "place_id", None)
            key = place_id or (
                getattr(candidate, "name", ""),
                getattr(candidate, "address", ""),
            )
            if key in seen:
                continue
            seen.add(key)
            candidates.append({
                "name": candidate.name,
                "address": candidate.address,
                "latitude": candidate.latitude,
                "longitude": candidate.longitude,
                "place_id": candidate.place_id,
                "types": candidate.types,
                "rating": candidate.rating,
                "rating_count": candidate.rating_count,
                "price_level": candidate.price_level,
                "opening_hours": candidate.opening_hours,
                "source": suggestion.evidence.source,
                "slot_name": suggestion.evidence.name_candidate,
            })

    return candidates


def build_reviewable_candidate_message(candidates: list[dict]) -> str:
    """Format unresolved-but-real Google place suggestions."""
    if not candidates:
        return ""

    lines = ["", "Possible places:"]
    for candidate in candidates[:6]:
        source = candidate.get("source", "").replace("_", " ")
        lines.append(f"⬜ {candidate['name']} ({source})")
    if len(candidates) > 6:
        lines.append(f"⬜ {len(candidates) - 6} more possible places")
    return "\n".join(lines)


def build_reviewable_candidate_keyboard(candidates: list[dict]) -> InlineKeyboardMarkup:
    """Buttons for real Google Place candidates pending user confirmation."""
    keyboard = []
    for index, candidate in enumerate(candidates[:6]):
        label = candidate["name"][:28] + "..." if len(candidate["name"]) > 28 else candidate["name"]
        keyboard.append([
            InlineKeyboardButton(f"Try: {label}", callback_data=f"unresolved_pick_{index}")
        ])
    return InlineKeyboardMarkup(keyboard)


def _restore_place_session_from_db(context, user_id: int) -> bool:
    """Try to load place_selection session from DB into user_data. Returns True if found."""
    session = repository.get_bot_session(user_id, "place_selection")
    if not session:
        return False
    context.user_data["pending_places"] = session["pending_places"]
    context.user_data["selected_indices"] = set(session.get("selected_indices", []))
    context.user_data["pending_video_meta"] = session.get("pending_video_meta", {})
    context.user_data["pending_url"] = session.get("pending_url", "")
    context.user_data["pending_platform"] = session.get("pending_platform", "unknown")
    return True


def _persist_place_session(context, user_id: int) -> None:
    """Write current place_selection user_data to DB."""
    repository.save_bot_session(user_id, "place_selection", {
        "pending_places": context.user_data.get("pending_places", []),
        "selected_indices": list(context.user_data.get("selected_indices", set())),
        "pending_video_meta": context.user_data.get("pending_video_meta", {}),
        "pending_url": context.user_data.get("pending_url", ""),
        "pending_platform": context.user_data.get("pending_platform", "unknown"),
    })


def _clear_place_session(context, user_id: int) -> None:
    """Clear place_selection from user_data and DB."""
    for key in ("pending_places", "pending_url", "pending_platform", "pending_video_meta", "selected_indices"):
        context.user_data.pop(key, None)
    try:
        repository.delete_bot_session(user_id, "place_selection")
    except Exception:
        pass


async def toggle_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Toggle place selection checkbox."""
    query = update.callback_query
    user_id = update.effective_user.id

    pending_places = context.user_data.get("pending_places")
    if not pending_places:
        if not _restore_place_session_from_db(context, user_id):
            await _safe_answer_callback(query, "Session timed out!")
            await _safe_edit_callback_message(query, "That session timed out — just resend the link and I'll try again. 🔄")
            return
        pending_places = context.user_data["pending_places"]

    # Get or initialize selected indices
    selected = context.user_data.get("selected_indices", set())

    # Extract index and toggle
    try:
        index = int(query.data.replace("toggle_place_", ""))
        if index in selected:
            selected.discard(index)
            await _safe_answer_callback(query, "Removed")
        else:
            selected.add(index)
            await _safe_answer_callback(query, "Selected!")
    except (ValueError, IndexError):
        await _safe_answer_callback(query, "Error!")
        return

    context.user_data["selected_indices"] = selected
    _persist_place_session(context, user_id)

    # Rebuild keyboard and update message
    video_meta = context.user_data.get("pending_video_meta", {})
    keyboard = build_selection_keyboard(pending_places, selected)
    message = build_selection_message(pending_places, selected, video_meta)
    await _safe_edit_callback_message(query, message, reply_markup=keyboard)


async def save_selected_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Save all selected places."""
    user_id = update.effective_user.id
    query = update.callback_query
    ensure_bot_user(update)

    pending_places = context.user_data.get("pending_places")
    if not pending_places:
        if not _restore_place_session_from_db(context, user_id):
            await _safe_answer_callback(query, "Session timed out!")
            await _safe_edit_callback_message(query, "That session timed out — just resend the link and I'll try again.")
            return
        pending_places = context.user_data["pending_places"]

    selected = context.user_data.get("selected_indices", set())

    if not selected:
        await _safe_answer_callback(query, "Pick some places first!")
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
    _clear_place_session(context, user_id)

    # Show confirmation
    await query.delete_message()

    count = len(saved_names)
    names_text = "\n".join(f"• {html.escape(name)}" for name in saved_names)
    await query.message.reply_text(
        f"✅ Saved {count} place{'s' if count != 1 else ''}\n\n{names_text}",
        parse_mode="HTML",
        reply_markup=_open_map_keyboard(),
    )


async def save_all_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Save all pending places without requiring individual selection."""
    user_id = update.effective_user.id
    query = update.callback_query
    ensure_bot_user(update)

    pending_places = context.user_data.get("pending_places")
    if not pending_places:
        if not _restore_place_session_from_db(context, user_id):
            await _safe_answer_callback(query, "Session timed out!")
            await _safe_edit_callback_message(query, "That session timed out — just resend the link and I'll try again.")
            return
        pending_places = context.user_data["pending_places"]

    await query.answer("Saving all...")
    await query.edit_message_text("Saving your places... 💾")

    source_url = context.user_data.get("pending_url", "")
    source_platform = context.user_data.get("pending_platform", "unknown")
    video_meta = context.user_data.get("pending_video_meta", {})

    saved_names = []
    for place_data in pending_places:
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

    _clear_place_session(context, user_id)

    await query.delete_message()

    count = len(saved_names)
    names_text = "\n".join(f"• {html.escape(name)}" for name in saved_names)
    open_map_btn = _open_map_keyboard()
    await query.message.reply_text(
        f"✅ Saved {count} place{'s' if count != 1 else ''}\n\n{names_text}",
        parse_mode="HTML",
        reply_markup=open_map_btn,
    )


async def unresolved_pick_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Save one unresolved-but-real Google candidate after user confirmation."""
    query = update.callback_query
    await query.answer()

    unresolved_slots = context.user_data.get("pending_unresolved_slots")
    if not unresolved_slots:
        await query.edit_message_text("That session timed out — just resend the link and I'll try again.")
        return

    try:
        index = int(query.data.replace("unresolved_pick_", ""))
        suggestion = unresolved_slots[index]
    except (ValueError, IndexError):
        await query.answer("Invalid suggestion")
        return

    place = suggestion
    await query.edit_message_text(f"Saving “{place['name']}”...")

    user_id = update.effective_user.id
    ensure_bot_user(update)
    source_url = context.user_data.get("pending_url", "")
    source_platform = context.user_data.get("pending_platform", "unknown")
    video_meta = context.user_data.get("pending_video_meta", {})

    repository.add_place(
        user_id=user_id,
        name=place["name"],
        address=place["address"],
        latitude=place["latitude"],
        longitude=place["longitude"],
        google_place_id=place.get("place_id"),
        source_url=source_url,
        source_platform=source_platform,
        source_title=video_meta.get("source_title"),
        source_uploader=video_meta.get("source_uploader"),
        source_duration=video_meta.get("source_duration"),
        source_hashtags=video_meta.get("source_hashtags"),
        place_types=",".join(place.get("types", [])) if place.get("types") else None,
        place_rating=place.get("rating"),
        place_rating_count=place.get("rating_count"),
        place_price_level=place.get("price_level"),
        place_opening_hours=place.get("opening_hours"),
        source_language=video_meta.get("source_language"),
        source_transcript=video_meta.get("source_transcript"),
        source_transcript_en=video_meta.get("source_transcript_en"),
    )

    context.user_data.pop("pending_unresolved_slots", None)

    await query.message.reply_location(latitude=place["latitude"], longitude=place["longitude"])
    await query.message.reply_text(
        build_saved_place_message(place, source_url=source_url),
        reply_markup=_open_map_keyboard(),
        parse_mode="HTML",
        disable_web_page_preview=True,
    )


async def cancel_selection_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cancel place selection."""
    query = update.callback_query
    user_id = update.effective_user.id
    await query.answer("Discarded")

    _clear_place_session(context, user_id)

    await query.edit_message_text(
        "Discarded those suggestions. Send another link whenever you're ready."
    )


async def incorrect_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show alternative candidates if available, otherwise ask for place name."""
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
    candidates = correction_context.get("candidates", [])

    if candidates and correction_context.get("place_id") == place_id:
        # Show alternatives — don't delete yet
        keyboard = []
        for i, c in enumerate(candidates[:3]):
            label = c["name"][:30] + "…" if len(c["name"]) > 30 else c["name"]
            addr = c.get("address", "")[:28] + "…" if len(c.get("address", "")) > 28 else c.get("address", "")
            btn_label = f"{label} — {addr}" if addr else label
            keyboard.append([InlineKeyboardButton(btn_label, callback_data=f"correction_pick_{place_id}_{i}")])
        keyboard.append([InlineKeyboardButton("None of these — I'll type the name", callback_data=f"correction_pick_{place_id}_manual")])
        await query.edit_message_reply_markup(reply_markup=None)
        await query.message.reply_text(
            "❌ Got it. Here are other matches I found:",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
    else:
        # No candidates — fall back to text input
        if correction_context.get("place_id") == place_id:
            context.user_data["pending_url"] = correction_context.get("source_url", "")
            context.user_data["pending_platform"] = correction_context.get("source_platform", "unknown")
            context.user_data.pop("correction_place_context", None)

        deleted = repository.delete_place(user_id, place_id)
        await query.edit_message_reply_markup(reply_markup=None)

        msg = "Removed. " if deleted else "Already removed. "
        await query.message.reply_text(msg + "Reply with the correct place name and I'll search for it.")


async def correction_pick_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle user picking a correction candidate or requesting manual input."""
    user_id = update.effective_user.id
    query = update.callback_query
    await query.answer()

    parts = query.data.split("_")
    # pattern: correction_pick_{place_id}_{index|manual}
    try:
        place_id = int(parts[2])
        pick = parts[3]
    except (IndexError, ValueError):
        await query.edit_message_reply_markup(reply_markup=None)
        return

    correction_context = context.user_data.get("correction_place_context") or {}
    candidates = correction_context.get("candidates", [])

    # Delete the wrong place
    repository.delete_place(user_id, place_id)
    await query.edit_message_reply_markup(reply_markup=None)

    if pick == "manual":
        context.user_data["pending_url"] = correction_context.get("source_url", "")
        context.user_data["pending_platform"] = correction_context.get("source_platform", "unknown")
        context.user_data.pop("correction_place_context", None)
        await query.message.reply_text("Reply with the place name and I'll search for it.")
        return

    try:
        candidate = candidates[int(pick)]
    except (IndexError, ValueError):
        await query.message.reply_text("Reply with the place name and I'll search for it.")
        return

    context.user_data.pop("correction_place_context", None)

    # Reconstruct a PlaceResult from stored candidate dict
    from services.places import PlaceResult
    place = PlaceResult(
        name=candidate["name"],
        address=candidate.get("address", ""),
        latitude=candidate.get("latitude", 0),
        longitude=candidate.get("longitude", 0),
        place_id=candidate.get("place_id"),
        types=candidate.get("types", []),
        rating=candidate.get("rating"),
        rating_count=candidate.get("rating_count"),
        price_level=candidate.get("price_level"),
        opening_hours=candidate.get("opening_hours"),
        confidence_score=candidate.get("confidence_score", 0),
        matched_source_type=candidate.get("matched_source_type"),
    )

    await _save_single_place_result(
        update,
        context,
        user_id=user_id,
        place=place,
        source_url=correction_context.get("source_url", ""),
        source_platform=correction_context.get("source_platform", "unknown"),
    )


async def handle_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Group URLs are handled by handle_group_url
    if update.effective_chat.type in ("group", "supergroup"):
        return
    user_id = update.effective_user.id
    text = update.message.text.strip()
    ensure_bot_user(update)

    if not is_valid_url(text):
        return  # Not a valid Instagram/TikTok URL, ignore

    platform = detect_platform(text)
    logger.info("URL received: user_id=%s platform=%s url=%s", user_id, platform, text)

    task_id = uuid.uuid4().hex[:8]
    cancel_markup = InlineKeyboardMarkup([[
        InlineKeyboardButton("✕ Cancel", callback_data=f"cancel_extraction_{task_id}")
    ]])
    status_msg = await update.message.reply_text(
        "Ooh, fresh content! Let me dig in... 🔍",
        reply_markup=cancel_markup,
    )

    async def _run():
        if platform == "instagram" and config.INSTAGRAM_NO_COOKIE_ENABLED:
            await _handle_instagram_no_cookie_url(update, context, text, status_msg)
            return
        if platform == "tiktok":
            await _handle_tiktok_url(update, context, text, status_msg)
            return

    task = asyncio.create_task(_run())
    context.user_data[f'extraction_task_{task_id}'] = task
    try:
        await task
    except asyncio.CancelledError:
        try:
            await status_msg.edit_text("Cancelled. Send another link anytime.", reply_markup=None)
        except Exception:
            pass
    finally:
        context.user_data.pop(f'extraction_task_{task_id}', None)


async def cancel_extraction_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cancel an in-progress extraction task."""
    query = update.callback_query
    await query.answer("Cancelling...")

    task_id = query.data.replace("cancel_extraction_", "")
    task = context.user_data.pop(f'extraction_task_{task_id}', None)
    if task and not task.done():
        task.cancel()
    else:
        # Already finished — just remove the button
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:
            pass


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle text messages that might be place name responses."""
    # Groups are handled by handle_group_url
    if update.effective_chat.type in ("group", "supergroup"):
        return
    user_id = update.effective_user.id
    text = update.message.text.strip()

    # Always treat valid URLs as new link submissions,
    # even if we were waiting for a manual place name.
    if is_valid_url(text):
        _clear_manual_place_pending(context)
        _clear_instagram_fallback_pending(context)
        await handle_url(update, context)
        return

    # Check if this is a response to a pending search
    pending_url = context.user_data.get("pending_url")
    if not pending_url:
        return

    pending_platform = context.user_data.get("pending_platform", "unknown")
    ensure_bot_user(update)

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
        _clear_manual_place_pending(context)
        _clear_instagram_fallback_pending(context)

        await status_msg.delete()

        # Send location pin
        await update.message.reply_location(
            latitude=place.latitude,
            longitude=place.longitude,
        )

        await update.message.reply_text(
            build_saved_place_message(place, source_url=pending_url),
            parse_mode="HTML",
            disable_web_page_preview=True,
        )

    except Exception as e:
        logger.error(f"Error searching place: {e}")
        await status_msg.edit_text(
            "Hmm, couldn't find that one. Try a different name?"
        )


async def delete_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [[InlineKeyboardButton("🗺️ Open My Map", web_app=WebAppInfo(url=config.WEBAPP_URL))]] if config.WEBAPP_URL else []
    await update.message.reply_text(
        "To remove a saved place, open the app and delete it from there 👇",
        reply_markup=InlineKeyboardMarkup(keyboard) if keyboard else None,
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


async def feedback_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Start feedback collection flow."""
    clear_feedback_context(context)
    await update.message.reply_text(
        "What kind of feedback is this?",
        reply_markup=build_feedback_category_keyboard(),
    )
    return FEEDBACK_CATEGORY


async def handle_feedback_category(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Create a report thread after category selection."""
    query = update.callback_query
    await query.answer()

    data = query.data or ""
    if not data.startswith("feedback_category:"):
        return FEEDBACK_CATEGORY

    category = data.split(":", 1)[1]
    user_id = update.effective_user.id
    ensure_bot_user(update)
    try:
        report = repository.create_feedback_report(
            user_id=user_id,
            category=category,
            source="telegram_bot",
        )
    except Exception as e:
        logger.error(f"Failed to create feedback report: {e}")
        await query.edit_message_text(
            "Feedback reporting isn't set up yet on the backend.\n\n"
            "Please try again after the latest database schema is applied."
        )
        return ConversationHandler.END

    if not report:
        await query.edit_message_text("I couldn't start a feedback report right now. Please try again.")
        return ConversationHandler.END

    repository.create_app_event(
        user_id=user_id,
        event_name="feedback_report_created",
        event_source="telegram_bot",
        entity_type="feedback_report",
        entity_id=str(report["id"]),
        metadata={"category": category},
    )

    context.user_data["feedback_context"] = {
        "report_id": report["id"],
        "category": category,
        "source_link": None,
    }
    await query.edit_message_text(
        "Send your feedback, screenshot, or link."
    )
    return FEEDBACK_COLLECT


async def _acknowledge_feedback_item(message, feedback_context: dict):
    """Send the loop prompt after saving a feedback item."""
    extra = ""
    if (
        feedback_context.get("category") == "places_not_found"
        and not feedback_context.get("source_link")
    ):
        extra = "\n\nIf you have the Instagram or TikTok link, send it too."

    await message.reply_text(
        f"Thanks, got it. Anything else?{extra}",
        reply_markup=build_feedback_done_keyboard(),
    )


async def handle_feedback_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Store one feedback text or link message."""
    feedback_context = context.user_data.get("feedback_context")
    if not feedback_context:
        return ConversationHandler.END

    text = (update.message.text or "").strip()
    if not text:
        await update.message.reply_text("Send text, a screenshot, or a link.", reply_markup=build_feedback_done_keyboard())
        return FEEDBACK_COLLECT

    report_id = feedback_context["report_id"]
    report = repository.get_feedback_report(report_id)
    if not report:
        clear_feedback_context(context)
        await update.message.reply_text("That feedback thread expired. Please send /feedback again.")
        return ConversationHandler.END

    urls = extract_urls(text)
    if urls:
        if not feedback_context.get("source_link"):
            repository.update_feedback_report(report_id, source_link=urls[0])
            feedback_context["source_link"] = urls[0]
        else:
            for url in urls:
                repository.append_feedback_attachment(
                    report_id=report_id,
                    attachment_type="link",
                    text_content=url,
                )

    if not (is_url_only_message(text) and urls):
        if not report.get("body"):
            repository.update_feedback_report(report_id, body=text)
        else:
            repository.append_feedback_text(report_id, text)

    repository.create_app_event(
        user_id=update.effective_user.id,
        event_name="feedback_item_added",
        event_source="telegram_bot",
        entity_type="feedback_report",
        entity_id=str(report_id),
        metadata={"has_url": bool(urls), "message_type": "text"},
    )
    context.user_data["feedback_context"] = feedback_context
    await _acknowledge_feedback_item(update.message, feedback_context)
    return FEEDBACK_COLLECT


async def handle_feedback_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Store one feedback screenshot/photo."""
    feedback_context = context.user_data.get("feedback_context")
    if not feedback_context:
        return

    report_id = feedback_context["report_id"]
    report = repository.get_feedback_report(report_id)
    if not report:
        clear_feedback_context(context)
        await update.message.reply_text("That feedback thread expired. Please send /feedback again.")
        return

    image_count = len([a for a in report.get("attachments", []) if a.get("attachment_type") == "image"])
    if image_count >= MAX_FEEDBACK_IMAGES:
        await update.message.reply_text(
            f"This feedback report already has {MAX_FEEDBACK_IMAGES} images.\nTap Done or send text/link instead.",
            reply_markup=build_feedback_done_keyboard(),
        )
        return FEEDBACK_COLLECT

    try:
        telegram_photo = update.message.photo[-1]
        telegram_file = await telegram_photo.get_file()
        photo_bytes = bytes(await telegram_file.download_as_bytearray())
        file_url, storage_path = storage_upload_feedback_attachment(
            update.effective_user.id,
            report_id,
            photo_bytes,
            f"{telegram_photo.file_unique_id}.jpg",
        )
        repository.append_feedback_attachment(
            report_id=report_id,
            attachment_type="image",
            file_url=file_url,
            storage_path=storage_path,
        )
        repository.create_app_event(
            user_id=update.effective_user.id,
            event_name="feedback_item_added",
            event_source="telegram_bot",
            entity_type="feedback_report",
            entity_id=str(report_id),
            metadata={"message_type": "image"},
        )
    except Exception as e:
        logger.error(f"Failed to upload feedback image: {e}")
        await update.message.reply_text(
            "I couldn't save that image. Try sending it again.",
            reply_markup=build_feedback_done_keyboard(),
        )
        return FEEDBACK_COLLECT

    await _acknowledge_feedback_item(update.message, feedback_context)
    return FEEDBACK_COLLECT


async def finish_feedback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Close the feedback loop when user taps Done."""
    query = update.callback_query
    await query.answer()

    feedback_context = context.user_data.get("feedback_context")
    if feedback_context:
        repository.create_app_event(
            user_id=update.effective_user.id,
            event_name="feedback_report_completed",
            event_source="telegram_bot",
            entity_type="feedback_report",
            entity_id=str(feedback_context["report_id"]),
            metadata={"category": feedback_context.get("category")},
        )
    clear_feedback_context(context)
    await query.edit_message_text("Thanks for the feedback. I've saved it.")
    return ConversationHandler.END


async def cancel_feedback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cancel feedback flow and keep any already-saved items."""
    clear_feedback_context(context)
    await update.message.reply_text("Feedback cancelled.")
    return ConversationHandler.END


async def handle_location(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle shared location and show up to 5 nearest saved places."""
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
    result_count = len(top_5)
    place_label = "place" if result_count == 1 else "places"
    if result_count < 5:
        text = f"📍 Here {'is' if result_count == 1 else 'are'} {result_count} {place_label} near you:\n\n"
    else:
        text = "📍 Here are your 5 nearest places:\n\n"

    for place, dist in top_5:
        dist_str = f"{int(dist * 1000)}m" if dist < 1 else f"{dist:.1f}km"

        # Build line with clickable links
        text += f"<b>{html.escape(place['name'])}</b> ({dist_str})\n"
        links = [
            f'<a href="{build_google_maps_url(place)}">Google Maps</a>'
        ]
        if place.get('source_url'):
            links.append(f'<a href="{place["source_url"]}">Original</a>')
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


def clear_feedback_context(context: ContextTypes.DEFAULT_TYPE):
    """Clear active Telegram feedback collection state."""
    context.user_data.pop("feedback_context", None)


def build_feedback_category_keyboard() -> InlineKeyboardMarkup:
    """Buttons for the /feedback category picker."""
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("Bug", callback_data="feedback_category:bug")],
        [InlineKeyboardButton("Feature Request", callback_data="feedback_category:feature_request")],
        [InlineKeyboardButton("Places Not Found", callback_data="feedback_category:places_not_found")],
        [InlineKeyboardButton("General Feedback", callback_data="feedback_category:general_feedback")],
    ])


def build_feedback_done_keyboard() -> InlineKeyboardMarkup:
    """Single-button keyboard for ending a feedback thread."""
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("Done", callback_data="feedback_done"),
    ]])


def extract_urls(text: str) -> list[str]:
    """Extract URLs from freeform feedback text."""
    return re.findall(r"https?://\S+", text)


def is_url_only_message(text: str) -> bool:
    """Return whether the message is just a single URL."""
    urls = extract_urls(text)
    if len(urls) != 1:
        return False
    return text.strip() == urls[0]


def feedback_category_label(category: str) -> str:
    """Friendly label for feedback categories."""
    labels = {
        "bug": "bug",
        "feature_request": "feature request",
        "places_not_found": "places not found",
        "general_feedback": "feedback",
    }
    return labels.get(category, "feedback")


async def handle_review_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle 'Write Review' button — open Mini App to review sheet."""
    query = update.callback_query
    await query.answer()

    parts = query.data.split(':', 2)
    if len(parts) < 2:
        return

    place_id = parts[1]

    if config.WEBAPP_URL:
        keyboard = [[InlineKeyboardButton(
            "⭐ Write Review →",
            web_app=WebAppInfo(url=f"{config.WEBAPP_URL}?startapp=review_{place_id}")
        )]]
        await query.message.reply_text(
            "Tap below to write your review in the app 👇",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
    else:
        await query.message.reply_text("Open the app to write your review.")


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
        repository.create_app_event(
            user_id=update.effective_user.id,
            event_name="review_prompt_later_clicked",
            event_source="telegram_bot",
            entity_type="review_reminder",
            entity_id=str(reminder_id),
            metadata={},
        )
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

    repository.set_dont_ask_again(user_id, place_id)

    await query.edit_message_text(
        "Got it, I won't ask about this place again.\n"
        "You can always review it in the Mini App! 📱"
    )


async def handle_dismiss(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Dismiss an inline keyboard from a message."""
    query = update.callback_query
    await query.answer()
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass


feedback_conversation_handler = ConversationHandler(
    entry_points=[CommandHandler("feedback", feedback_command)],
    states={
        FEEDBACK_CATEGORY: [
            CallbackQueryHandler(handle_feedback_category, pattern=r"^feedback_category:")
        ],
        FEEDBACK_COLLECT: [
            MessageHandler(filters.TEXT & ~filters.COMMAND, handle_feedback_text),
            MessageHandler(filters.PHOTO, handle_feedback_photo),
            CallbackQueryHandler(finish_feedback, pattern=r"^feedback_done$"),
        ],
    },
    fallbacks=[CommandHandler("cancel", cancel_feedback)],
    name="feedback_conversation",
    persistent=False,
    per_chat=True,
    per_user=True,
)


# =============================================================================
# Group Map Handlers
# =============================================================================


async def handle_group_welcome(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Send welcome message when bot is added to a group."""
    member = update.my_chat_member
    if not member:
        return
    chat = member.chat
    if chat.type not in ("group", "supergroup"):
        return
    # Only fire when bot transitions to member/administrator (not on removal)
    new_status = member.new_chat_member.status
    if new_status not in ("member", "administrator"):
        return

    group_map_url = f"{config.WEBAPP_URL}?group_id={chat.id}" if config.WEBAPP_URL else None
    keyboard = []
    if group_map_url:
        keyboard.append([
            InlineKeyboardButton("🗺️ View Group Map", url=group_map_url)
        ])

    await context.bot.send_message(
        chat_id=chat.id,
        text=(
            "Hey! 👋 I'm Sprout Eats.\n\n"
            "Share an Instagram Reel or TikTok in this chat and I'll extract the place. "
            "Anyone in the group can then save it to the shared Group Map. 🗺️\n\n"
            "Personal maps are unchanged — DM me to use your private map."
        ),
        reply_markup=InlineKeyboardMarkup(keyboard) if keyboard else None,
    )


def _build_group_card_keyboard(
    place_id: int,
    place_name: str,
    source_url: str,
    google_place_id: str,
    lat,
    lng,
    vote_count: int,
    group_map_url: str,
) -> InlineKeyboardMarkup:
    """Build the 2-row inline keyboard for a group place card."""
    vote_label = f"👍 {vote_count}" if vote_count > 0 else "👍"
    row1 = [InlineKeyboardButton(vote_label, callback_data=f"grp_vote_{place_id}")]
    if group_map_url:
        row1.append(InlineKeyboardButton("🗺️ View Group Map", url=group_map_url))

    row2 = []
    maps_place = {"name": place_name, "google_place_id": google_place_id, "latitude": lat, "longitude": lng}
    maps_url = build_google_maps_url(maps_place)
    if maps_url:
        row2.append(InlineKeyboardButton("📍 Maps", url=maps_url))
    if source_url:
        row2.append(InlineKeyboardButton("▶️ Reel", url=source_url))

    rows = [row1] + ([row2] if row2 else [])
    return InlineKeyboardMarkup(rows)


async def _save_and_post_group_place(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    name: str,
    address: str,
    lat,
    lng,
    google_place_id: str,
    source_url: str,
    source_platform: str,
    source_uploader: str,
    source_title: str,
    source_duration,
    source_hashtags: str,
    types,
    rating,
    rating_count,
    price_level,
    opening_hours,
):
    """Save a place to group map and post the card. Returns True if posted."""
    chat = update.effective_chat
    sharer_id = update.effective_user.id
    sharer_name = update.effective_user.username or update.effective_user.first_name or "someone"

    saved = repository.add_place(
        user_id=sharer_id,
        name=name,
        address=address,
        latitude=lat,
        longitude=lng,
        google_place_id=google_place_id,
        source_url=source_url,
        source_platform=source_platform,
        source_uploader=source_uploader,
        source_title=source_title,
        source_duration=source_duration,
        source_hashtags=source_hashtags,
        place_types=",".join(types) if types else None,
        place_rating=rating,
        place_rating_count=rating_count,
        place_price_level=price_level,
        place_opening_hours=opening_hours,
        group_id=chat.id,
        saved_by_user_id=sharer_id,
    )
    if not saved:
        return False
    place_id = saved["id"]

    meta_parts = []
    if address:
        city = address.split(",")[0].strip()
        meta_parts.append(f"📍 {html.escape(city)}")
    if rating:
        meta_parts.append(f"⭐ {rating}")
    if price_level:
        dollar_map = {"INEXPENSIVE": "$", "MODERATE": "$$", "EXPENSIVE": "$$$", "VERY_EXPENSIVE": "$$$$"}
        symbol = dollar_map.get(price_level, "")
        if symbol:
            meta_parts.append(symbol)
    meta_line = " · ".join(meta_parts)
    card_text = (
        f"<b>{html.escape(name)}</b>\n"
        f"{meta_line}\n"
        f"Shared by @{html.escape(sharer_name)}"
    )

    group_map_url = None
    if config.WEBAPP_URL:
        group_map_url = f"{config.WEBAPP_URL}?group_id={chat.id}"
        if config.TELEGRAM_BOT_USERNAME:
            group_map_url += f"&bot={config.TELEGRAM_BOT_USERNAME}"
    keyboard = _build_group_card_keyboard(
        place_id=place_id,
        place_name=name,
        source_url=source_url,
        google_place_id=google_place_id,
        lat=lat,
        lng=lng,
        vote_count=0,
        group_map_url=group_map_url,
    )
    await update.message.reply_text(
        card_text,
        parse_mode="HTML",
        reply_markup=keyboard,
        disable_web_page_preview=True,
    )
    return True


async def handle_group_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Detect food URLs in group messages, auto-save, and post a place card with vote button."""
    if not update.message or not update.message.text:
        return

    chat = update.effective_chat
    if chat.type not in ("group", "supergroup"):
        return

    text = update.message.text.strip()

    # Check if this is a reply to a pending name request
    reply_to = update.message.reply_to_message
    if reply_to:
        pending = context.chat_data.get("pending_name_requests", {}).get(reply_to.message_id)
        if pending and pending["sharer_user_id"] == update.effective_user.id:
            # User replied with a place name — search and save
            ensure_bot_user(update)
            searching_msg = await update.message.reply_text("Searching for that place... 🔍")
            place_results = await asyncio.get_event_loop().run_in_executor(
                None, lambda: search_place(text)
            )
            if not place_results:
                await searching_msg.edit_text("Couldn't find that place. Try a more specific name.")
                return
            place = place_results[0] if isinstance(place_results, list) else place_results
            await searching_msg.delete()
            await _save_and_post_group_place(
                update=update,
                context=context,
                name=place.name if hasattr(place, "name") else place.get("name", text),
                address=place.address if hasattr(place, "address") else place.get("address", ""),
                lat=place.latitude if hasattr(place, "latitude") else place.get("latitude"),
                lng=place.longitude if hasattr(place, "longitude") else place.get("longitude"),
                google_place_id=place.place_id if hasattr(place, "place_id") else place.get("place_id") or place.get("google_place_id"),
                source_url=pending["source_url"],
                source_platform=pending["source_platform"],
                source_uploader=None,
                source_title=None,
                source_duration=None,
                source_hashtags=None,
                types=place.types if hasattr(place, "types") else place.get("types"),
                rating=place.rating if hasattr(place, "rating") else place.get("rating"),
                rating_count=place.rating_count if hasattr(place, "rating_count") else place.get("rating_count"),
                price_level=place.price_level if hasattr(place, "price_level") else place.get("price_level"),
                opening_hours=place.opening_hours if hasattr(place, "opening_hours") else place.get("opening_hours"),
            )
            context.chat_data.get("pending_name_requests", {}).pop(reply_to.message_id, None)
            return

    if not is_valid_url(text):
        return

    platform = detect_platform(text)
    ensure_bot_user(update)
    sharer_id = update.effective_user.id
    sharer_name = update.effective_user.username or update.effective_user.first_name or "someone"
    logger.info("Group URL received: chat_id=%s platform=%s url=%s", chat.id, platform, text)

    task_id = uuid.uuid4().hex[:8]
    status_msg = await update.message.reply_text(
        "Checking this out... 🔍",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✕ Cancel", callback_data=f"cancel_extraction_{task_id}")
        ]]),
    )

    async def _run():
        await status_msg.edit_text("Reading the caption... 📝")
        if platform == "instagram" and config.INSTAGRAM_NO_COOKIE_ENABLED:
            pipeline = await run_instagram_place_pipeline(text)
        elif platform == "tiktok":
            pipeline = await run_tiktok_place_pipeline(text)
        else:
            await status_msg.edit_text("I can only process Instagram and TikTok links.")
            return

        if pipeline.get("status") == "failed" or not pipeline.get("places"):
            # Ask for place name instead of silently failing
            ask_msg = await status_msg.edit_text(
                "Couldn't find a place in that link. What's it called?\n"
                "(Reply to this message with the name)",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("Cancel", callback_data=f"grp_cancel_name_{status_msg.message_id}")
                ]]),
            )
            context.chat_data.setdefault("pending_name_requests", {})[ask_msg.message_id] = {
                "sharer_user_id": sharer_id,
                "source_url": text,
                "source_platform": platform,
            }
            return

        places = pipeline.get("places", [])
        candidate = pipeline.get("metadata_candidate")
        source_uploader = getattr(candidate, "uploader", None) if candidate else None
        source_title = getattr(candidate, "title", None) if candidate else None
        source_duration = getattr(candidate, "duration", None) if candidate else None
        hashtags = getattr(candidate, "hashtags", []) if candidate else []
        source_hashtags = ",".join(hashtags) if hashtags else None

        await status_msg.delete()
        for place in places:
            await _save_and_post_group_place(
                update=update,
                context=context,
                name=place.name if hasattr(place, "name") else place.get("name", ""),
                address=place.address if hasattr(place, "address") else place.get("address", ""),
                lat=place.latitude if hasattr(place, "latitude") else place.get("latitude"),
                lng=place.longitude if hasattr(place, "longitude") else place.get("longitude"),
                google_place_id=place.place_id if hasattr(place, "place_id") else place.get("place_id") or place.get("google_place_id"),
                source_url=text,
                source_platform=platform,
                source_uploader=source_uploader,
                source_title=source_title,
                source_duration=source_duration,
                source_hashtags=source_hashtags,
                types=place.types if hasattr(place, "types") else place.get("types"),
                rating=place.rating if hasattr(place, "rating") else place.get("rating"),
                rating_count=place.rating_count if hasattr(place, "rating_count") else place.get("rating_count"),
                price_level=place.price_level if hasattr(place, "price_level") else place.get("price_level"),
                opening_hours=place.opening_hours if hasattr(place, "opening_hours") else place.get("opening_hours"),
            )

    task = asyncio.create_task(_run())
    context.user_data[f'extraction_task_{task_id}'] = task
    try:
        await task
    except asyncio.CancelledError:
        try:
            await status_msg.edit_text("Cancelled.", reply_markup=None)
        except Exception:
            pass
    finally:
        context.user_data.pop(f'extraction_task_{task_id}', None)


async def grp_cancel_name_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle cancel button on the 'What's it called?' prompt."""
    query = update.callback_query
    msg_id = int(query.data.replace("grp_cancel_name_", ""))
    context.chat_data.get("pending_name_requests", {}).pop(msg_id, None)
    try:
        await query.edit_message_text("Cancelled.", reply_markup=None)
    except Exception:
        pass
    await query.answer()


async def vote_group_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle tap on 👍 vote button for a group place."""
    query = update.callback_query
    ensure_bot_user(update)

    place_id = int(query.data.replace("grp_vote_", ""))
    result = repository.toggle_place_vote(place_id, update.effective_user.id)
    vote_count = result["count"]

    await query.answer("👍 Nice!" if result["voted"] else "Vote removed")

    place = repository.get_group_place_by_id(place_id)
    group_id = query.message.chat.id
    group_map_url = None
    if config.WEBAPP_URL:
        group_map_url = f"{config.WEBAPP_URL}?group_id={group_id}"
        if config.TELEGRAM_BOT_USERNAME:
            group_map_url += f"&bot={config.TELEGRAM_BOT_USERNAME}"
    keyboard = _build_group_card_keyboard(
        place_id=place_id,
        place_name=place.get("name", "") if place else "",
        source_url=place.get("source_url") if place else None,
        google_place_id=place.get("google_place_id") if place else None,
        lat=place.get("latitude") if place else None,
        lng=place.get("longitude") if place else None,
        vote_count=vote_count,
        group_map_url=group_map_url,
    )
    try:
        await query.edit_message_reply_markup(reply_markup=keyboard)
    except Exception:
        pass


async def sharemap_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Generate (or retrieve) a permanent share link for the user's map."""
    if not config.WEBAPP_URL:
        await update.message.reply_text("Mini App not configured.")
        return
    ensure_bot_user(update)
    user_id = update.effective_user.id
    first_name = update.effective_user.first_name or "my"
    token = repository.get_or_create_map_share(user_id)
    share_url = f"{config.WEBAPP_URL}?share={token}"
    share_text = quote(f"🌱 Check out {first_name}'s food map on Sprout!")
    tg_share_url = f"https://t.me/share/url?url={quote(share_url)}&text={share_text}"
    await update.message.reply_text(
        f"🌱 <b>Your Sprout map is ready to share!</b>\n\n"
        f"<a href=\"{share_url}\">🗺️ View {html.escape(first_name)}'s map</a>\n\n"
        "Anyone with this link can explore your saved spots — no sign-up needed.",
        parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("📤 Share to Telegram", url=tg_share_url),
            InlineKeyboardButton("Preview →", url=share_url),
        ]]),
    )
