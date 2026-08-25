import asyncio
import logging
import html
import re
import uuid
import warnings
from functools import wraps
from io import BytesIO
from urllib.parse import quote
from weakref import WeakValueDictionary
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
from services.deep_links import build_webapp_url
from services.geo import haversine_distance
from bot.telemetry import record_bot_event
from database import supabase_repository as repository
from database.supabase_client import (
    upload_photo as storage_upload_photo,
    upload_feedback_attachment as storage_upload_feedback_attachment,
)
from database.supabase_client import get_supabase

logger = logging.getLogger(__name__)

_user_flow_locks: WeakValueDictionary[int, asyncio.Lock] = WeakValueDictionary()


def _get_user_flow_lock(user_id: int) -> asyncio.Lock:
    lock = _user_flow_locks.get(user_id)
    if lock is None:
        lock = asyncio.Lock()
        _user_flow_locks[user_id] = lock
    return lock


def serialized_user_flow(handler):
    """Serialize state-changing bot callbacks for one Telegram user."""
    @wraps(handler)
    async def wrapped(update: Update, context: ContextTypes.DEFAULT_TYPE):
        async with _get_user_flow_lock(update.effective_user.id):
            return await handler(update, context)

    return wrapped

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


def build_saved_place_message(place, source_url: str | None = None, *, created: bool = True) -> str:
    """Build a concise saved-place confirmation with labeled links."""
    name = html.escape(str(get_place_value(place, "name", "this place")))
    address = get_place_value(place, "address")
    rating = get_place_value(place, "rating") or get_place_value(place, "place_rating")
    rating_count = get_place_value(place, "rating_count") or get_place_value(place, "place_rating_count")
    types = get_place_value(place, "types") or get_place_value(place, "place_types")

    status = "✅ Saved" if created else "✓ Already in your saves"
    lines = [f"{status} <b>{name}</b>"]
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

    return "\n".join(lines)


def build_saved_place_keyboard(
    place,
    *,
    saved_place_id: int,
    correction_session_id: str,
    created: bool,
    source_url: str | None = None,
) -> InlineKeyboardMarkup:
    """One coherent action surface for a save confirmation."""
    rows = []
    if config.WEBAPP_URL:
        rows.append([InlineKeyboardButton(
            "🌱 Open in Sprout",
            web_app=WebAppInfo(url=build_webapp_url(config.WEBAPP_URL, "place", saved_place_id)),
        )])
    links = [InlineKeyboardButton("📍 Maps", url=build_google_maps_url(place))]
    if source_url:
        links.append(InlineKeyboardButton("▶️ Original", url=source_url))
    rows.append(links)
    edit_row = []
    if created:
        edit_row.append(InlineKeyboardButton("↩️ Undo", callback_data=f"undo:{saved_place_id}"))
    edit_row.append(InlineKeyboardButton("Change Place", callback_data=f"cp:{correction_session_id}:open"))
    rows.append(edit_row)
    return InlineKeyboardMarkup(rows)


async def safe_edit_status(status_msg, text: str):
    """Best-effort status edit; avoids secondary crashes after message deletion."""
    try:
        await status_msg.edit_text(text)
    except Exception:
        logger.warning("Could not edit status message", exc_info=True)


def build_cancel_extraction_keyboard(task_id: str | None) -> InlineKeyboardMarkup | None:
    if not task_id:
        return None
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("✕ Cancel", callback_data=f"cancel_extraction_{task_id}")
    ]])


def log_failed_link(
    *,
    user_id: int,
    url: str,
    platform: str,
    reason: str,
    failure_stage: str,
    flow: str = "private",
    caption_preview: str = "",
    error_message: str | None = None,
    request_id: str | None = None,
    details: dict | None = None,
) -> None:
    """Best-effort failure capture; diagnostics must never break the user flow."""
    try:
        repository.log_failed_extraction(
            user_id,
            url,
            platform=platform,
            caption_preview=caption_preview,
            reason=reason,
            failure_stage=failure_stage,
            flow=flow,
            error_message=error_message,
            request_id=request_id,
            details=details,
        )
    except Exception:
        logger.warning(
            "Could not record failed link: user_id=%s platform=%s reason=%s",
            user_id,
            platform,
            reason,
            exc_info=True,
        )


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


async def notify_friends_of_review(
    context: ContextTypes.DEFAULT_TYPE,
    reviewer_id: int,
    place_name: str,
    rating: int,
    google_place_id: str,
) -> None:
    """Send bot notification to all friends when someone writes a review."""
    friend_ids = repository.get_friend_ids(reviewer_id)
    friend_ids = repository.filter_friend_activity_notification_recipients(friend_ids)
    if not friend_ids:
        return
    reviewer = repository.get_user_by_id(reviewer_id)
    reviewer_name = (
        reviewer.get("display_name") or reviewer.get("first_name") or "Your friend"
        if reviewer else "Your friend"
    )
    stars = "⭐" * max(1, min(5, rating))
    text = f"🌱 *{reviewer_name}* just reviewed *{html.escape(place_name)}*\n{stars}"
    bot_username = config.TELEGRAM_BOT_USERNAME
    for friend_id in friend_ids:
        try:
            keyboard = None
            if bot_username and google_place_id:
                app_url = build_webapp_url(config.WEBAPP_URL, "gplace", google_place_id) if config.WEBAPP_URL else None
                if app_url:
                    keyboard = InlineKeyboardMarkup([[
                        InlineKeyboardButton("See Review 👀", web_app=WebAppInfo(url=app_url))
                    ]])
            await context.bot.send_message(
                chat_id=friend_id,
                text=text,
                parse_mode="Markdown",
                reply_markup=keyboard,
            )
        except Exception as e:
            logger.warning(f"Failed to notify friend {friend_id} of review: {e}")


async def _fetch_and_store_avatar(bot, user_id: int) -> None:
    """Download Telegram profile photo and store in Supabase Storage."""
    try:
        photos = await bot.get_user_profile_photos(user_id, limit=1)
        if not photos.photos:
            return
        photo_file = await photos.photos[0][-1].get_file()
        photo_bytes = await photo_file.download_as_bytearray()
        supabase = get_supabase()
        storage_path = f"avatars/{user_id}.jpg"
        supabase.storage.from_("avatars").upload(
            storage_path,
            bytes(photo_bytes),
            {"content-type": "image/jpeg", "upsert": "true"},
        )
        avatar_url = supabase.storage.from_("avatars").get_public_url(storage_path)
        repository.update_user_avatar(user_id, avatar_url)
        logger.info(f"Stored avatar for user {user_id}")
    except Exception as e:
        logger.warning(f"Could not fetch avatar for {user_id}: {e}")


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Handle friend invite deep link
    if context.args and context.args[0].startswith("addfriend_"):
        try:
            requester_id = int(context.args[0].replace("addfriend_", ""))
        except ValueError:
            return
        ensure_bot_user(update)
        addressee_id = update.effective_user.id
        if requester_id == addressee_id:
            await update.message.reply_text("That's your own invite link! Share it with friends.")
            return
        requester = repository.get_user_by_id(requester_id)
        requester_name = (
            requester.get("display_name") or requester.get("first_name") or "Someone"
            if requester else "Someone"
        )
        friendship = repository.send_friend_request(requester_id, addressee_id)
        if friendship:
            await update.message.reply_text(
                f"🌱 *{html.escape(requester_name)}* wants to be friends on Sprout!\n\n"
                f"Open the app to accept their request.",
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("Open Sprout 🌱", web_app=WebAppInfo(url=config.WEBAPP_URL))
                ]]) if config.WEBAPP_URL else None,
            )
        else:
            await update.message.reply_text("You're already connected!")
        return

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
            review_url = build_webapp_url(config.WEBAPP_URL, "review", place_id, pn=place_name)
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
        # Fetch and store avatar in background (non-blocking)
        import asyncio
        asyncio.create_task(_fetch_and_store_avatar(context.bot, user_id))

        first_name = update.effective_user.first_name or "there"
        text = (
            f"Hey {first_name}! 👋 Sprout turns food videos into places you can actually find later.\n\n"
            "Send an Instagram Reel or TikTok link. I’ll identify the restaurant or cafe, "
            "save it to your map, and let you correct the match if needed."
        )
        keyboard = [[InlineKeyboardButton("❓ See how it works", callback_data="action_howto")]]
        if config.WEBAPP_URL:
            keyboard.append([InlineKeyboardButton("🌱 Open Sprout", web_app=WebAppInfo(url=config.WEBAPP_URL))])
        # Naming is optional and must never block the first save.
        existing_user = repository.get_my_profile(user_id)
        if not (existing_user and existing_user.get("display_name")):
            keyboard.append([InlineKeyboardButton(f"Use {first_name} as my name", callback_data="set_name_tg")])
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
            keyboard.append([InlineKeyboardButton("🌱 Open in Sprout", web_app=WebAppInfo(url=config.WEBAPP_URL))])

    await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard))


async def app_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Open Sprout Mini App directly."""
    ensure_bot_user(update)
    if not config.WEBAPP_URL:
        await update.message.reply_text("Sprout app isn't configured yet.")
        return
    await update.message.reply_text(
        "Open your Sprout map 🌱",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("🌱 Open in Sprout", web_app=WebAppInfo(url=config.WEBAPP_URL))
        ]]),
    )


async def settings_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show bot-controlled social notification preferences."""
    ensure_bot_user(update)
    enabled = repository.get_friend_activity_notification_enabled(update.effective_user.id)
    await update.message.reply_text(
        f"Notifications\n\nFriend visits and reviews: {'On' if enabled else 'Off'}",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton(
                "Turn off" if enabled else "Turn on",
                callback_data=f"notify:{'off' if enabled else 'on'}",
            )
        ]]),
    )


async def notification_setting_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    enabled = query.data == "notify:on"
    repository.set_friend_activity_notification_enabled(update.effective_user.id, enabled)
    await query.answer("Updated")
    await query.edit_message_text(
        f"Notifications\n\nFriend visits and reviews: {'On' if enabled else 'Off'}",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton(
                "Turn off" if enabled else "Turn on",
                callback_data=f"notify:{'off' if enabled else 'on'}",
            )
        ]]),
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


async def set_name_tg_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Use Telegram first name as display name."""
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id
    first_name = update.effective_user.first_name or "Friend"
    repository.update_user_profile(user_id, display_name=first_name)
    context.user_data.pop("waiting_display_name", None)
    keyboard = [[InlineKeyboardButton("❓ How it works", callback_data="action_howto")]]
    if config.WEBAPP_URL:
        keyboard.append([InlineKeyboardButton("🗺️ Open My Map", web_app=WebAppInfo(url=config.WEBAPP_URL))])
    await query.edit_message_text(
        f"✅ Got it, {first_name}!\n\nJust send me a video link to get started. 🎬",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


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
            "⭐ *Step 3 — Log your visit*\n\n"
            "After visiting, open the place and tap *Been Here* to log it and leave a review.\n\n"
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
                "🌱 Open in Sprout",
                web_app=WebAppInfo(url=config.WEBAPP_URL)
            )
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
    user_id: int | None = None,
    unresolved_candidates: list[dict] | None = None,
) -> None:
    _set_tiktok_fallback_pending(context, source_url)
    if unresolved_candidates:
        session_id = uuid.uuid4().hex[:8] if user_id is not None else "legacy"
        candidates = unresolved_candidates[:6]
        if user_id is not None:
            repository.save_bot_session_v2(
                user_id,
                "unresolved_selection",
                session_id,
                {
                    "pending_unresolved_slots": candidates,
                    "pending_url": source_url,
                    "pending_platform": "tiktok",
                },
            )
        else:
            context.user_data["pending_unresolved_slots"] = candidates
        await status_msg.edit_text(
            "I found possible place matches, but couldn't verify them confidently enough to auto-save.\n"
            f"{build_reviewable_candidate_message(unresolved_candidates)}\n\n"
            "Tap a suggestion, or type the place name to search manually.",
            reply_markup=build_reviewable_candidate_keyboard(
                unresolved_candidates,
                session_id=session_id,
            ),
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


async def prompt_instagram_manual_fallback(
    status_msg,
    context: ContextTypes.DEFAULT_TYPE,
    source_url: str,
    *,
    user_id: int | None = None,
    unresolved_candidates: list[dict] | None = None,
    timed_out: bool = False,
) -> None:
    context.user_data["pending_url"] = source_url
    context.user_data["pending_platform"] = "instagram"
    if unresolved_candidates:
        session_id = uuid.uuid4().hex[:8] if user_id is not None else "legacy"
        candidates = unresolved_candidates[:6]
        if user_id is not None:
            repository.save_bot_session_v2(
                user_id,
                "unresolved_selection",
                session_id,
                {
                    "pending_unresolved_slots": candidates,
                    "pending_url": source_url,
                    "pending_platform": "instagram",
                },
            )
        else:
            context.user_data["pending_unresolved_slots"] = candidates
        await status_msg.edit_text(
            "I found possible place matches, but couldn't verify them confidently enough to auto-save.\n"
            f"{build_reviewable_candidate_message(unresolved_candidates)}\n\n"
            "Tap a suggestion to save it, or reply with the place name.",
            reply_markup=build_reviewable_candidate_keyboard(
                unresolved_candidates,
                session_id=session_id,
            ),
        )
        return

    retry_markup = None
    if user_id is not None:
        retry_session_id = uuid.uuid4().hex[:8]
        payload = {"url": source_url, "platform": "instagram"}
        context.user_data.setdefault("extraction_retry_sessions", {})[retry_session_id] = payload
        try:
            repository.save_bot_session_v2(
                user_id,
                "extraction_retry",
                retry_session_id,
                payload,
                ttl_hours=24,
            )
        except Exception:
            logger.warning("Could not persist extraction retry session", exc_info=True)
        retry_markup = InlineKeyboardMarkup([[
            InlineKeyboardButton(
                "↻ Try extraction again",
                callback_data=f"retry_extraction_{retry_session_id}",
            )
        ]])

    intro = (
        "Instagram is taking longer than usual, so I stopped this attempt."
        if timed_out
        else "I couldn't reliably extract the place from this Instagram post."
    )
    await status_msg.edit_text(
        f"{intro}\n\nReply with the place name and I'll search for it.",
        reply_markup=retry_markup,
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
    record_bot_event(
        user_id, "extraction_resolved", entity_type="extraction",
        entity_id=context.user_data.get("active_extraction_task_id"),
        metadata={"platform": source_platform, "result": "candidate_found"},
    )
    outcome = repository.add_place_with_outcome(
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
        place_description=place.description,
        country_code=getattr(place, "country_code", None),
        city=getattr(place, "city", None),
        neighborhood=getattr(place, "neighborhood", None),
        primary_cuisine=getattr(place, "primary_cuisine", None),
        source_language=source_language,
        source_transcript=source_transcript,
        source_transcript_en=source_transcript_en,
    )

    saved_place = outcome.get("place")
    created = bool(outcome.get("created"))
    saved_place_id = get_saved_place_id(saved_place)
    if not saved_place_id:
        log_failed_link(
            user_id=user_id,
            url=source_url,
            platform=source_platform,
            reason="save_failed",
            failure_stage="persistence",
            request_id=context.user_data.get("active_extraction_task_id"),
            details={"place_name": place.name},
        )
        reply_message = getattr(update, "effective_message", None) or update.message
        await reply_message.reply_text("I found the place, but couldn't save it. Please try again.")
        return None

    correction_session_id = uuid.uuid4().hex[:8]
    serialised_candidates = []
    for candidate in alt_candidates or []:
        serialised_candidates.append({
            key: get_place_value(candidate, key)
            for key in (
                "name", "address", "latitude", "longitude", "place_id", "types",
                "rating", "rating_count", "price_level", "opening_hours",
                "confidence_score", "matched_source_type", "description",
                "country_code", "city", "neighborhood", "primary_cuisine",
            )
        })
    repository.save_bot_session_v2(
        user_id,
        "place_correction",
        correction_session_id,
        {
            "place_id": saved_place_id,
            "source_url": source_url,
            "source_platform": source_platform,
            "candidates": serialised_candidates,
        },
    )

    confirmation = build_saved_place_message(saved_place or place, source_url=source_url, created=created)
    correction_keyboard = build_saved_place_keyboard(
        saved_place or place,
        saved_place_id=saved_place_id,
        correction_session_id=correction_session_id,
        created=created,
        source_url=source_url,
    )

    reply_message = getattr(update, "effective_message", None) or update.message
    await reply_message.reply_text(
        confirmation,
        reply_markup=correction_keyboard,
        parse_mode="HTML",
        disable_web_page_preview=True,
    )
    if created:
        record_bot_event(
            user_id, "extraction_succeeded", entity_type="extraction",
            entity_id=context.user_data.get("active_extraction_task_id") or saved_place_id,
            metadata={"platform": source_platform, "result": "saved"},
        )
    else:
        record_bot_event(user_id, "place_duplicate", entity_type="place", entity_id=saved_place_id, metadata={"platform": source_platform})
    return outcome


async def _start_multi_place_selection(
    context: ContextTypes.DEFAULT_TYPE,
    status_msg,
    *,
    user_id: int,
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
    session_id = uuid.uuid4().hex[:8]
    pending_places = [
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
            "country_code": getattr(p, "country_code", None),
            "city": getattr(p, "city", None),
            "neighborhood": getattr(p, "neighborhood", None),
            "primary_cuisine": getattr(p, "primary_cuisine", None),
        }
        for p in places
    ]
    video_meta = {
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
        i for i, place in enumerate(pending_places)
        if place.get("confidence_label") == "high"
    }
    selected = high_confidence_indices or {0}
    session = {
        "pending_places": pending_places,
        "selected_indices": list(selected),
        "pending_video_meta": video_meta,
        "pending_url": source_url,
        "pending_platform": source_platform,
        "request_id": context.user_data.get("active_extraction_task_id"),
    }
    _persist_place_session(context, user_id, session_id, session)
    record_bot_event(
        user_id, "extraction_resolved", entity_type="extraction",
        entity_id=session.get("request_id") or session_id,
        metadata={"platform": source_platform, "result": "candidates_presented"},
    )

    keyboard = build_selection_keyboard(pending_places, selected, session_id=session_id)
    review_text = build_selection_message(
        pending_places,
        selected,
        video_meta,
    )

    await status_msg.edit_text(review_text, reply_markup=keyboard)


async def _handle_instagram_no_cookie_url(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    text: str,
    status_msg,
    *,
    request_id: str | None = None,
) -> bool:
    user_id = update.effective_user.id
    cancel_markup = build_cancel_extraction_keyboard(request_id)
    await status_msg.edit_text("Reading the caption... 📝", reply_markup=cancel_markup)

    async def show_stage(stage: str) -> None:
        if stage == "resolving":
            await status_msg.edit_text("Resolving place names... 🔎", reply_markup=cancel_markup)
        elif stage == "metadata_waiting":
            await status_msg.edit_text(
                "Instagram is a little slow today — still reading the post... ⏳",
                reply_markup=cancel_markup,
            )
        elif stage == "metadata_still_waiting":
            await status_msg.edit_text(
                "Still working on it. You can cancel, or give me another moment... 🌱",
                reply_markup=cancel_markup,
            )

    pipeline = await run_instagram_place_pipeline(text, on_stage=show_stage)

    if pipeline["status"] == "failed" or pipeline.get("timed_out_stage") == "metadata":
        logger.warning("Instagram no-cookie pipeline failed: user_id=%s error=%s", user_id, pipeline.get("error"))
        timed_out = (
            pipeline.get("timed_out_stage") == "metadata"
            or "timed out" in (pipeline.get("error") or "").lower()
        )
        log_failed_link(
            user_id=user_id,
            url=text,
            platform="instagram",
            reason="metadata_timeout" if timed_out else "metadata_failed",
            failure_stage="metadata",
            error_message=pipeline.get("error"),
            request_id=request_id,
            details={"pipeline_status": pipeline.get("status")},
        )
        await prompt_instagram_manual_fallback(
            status_msg,
            context,
            text,
            user_id=user_id,
            timed_out=timed_out,
        )
        return True

    candidate = pipeline.get("metadata_candidate")
    source_title = getattr(candidate, "title", "") if candidate else ""
    source_uploader = getattr(candidate, "uploader", None) if candidate else None
    source_duration = getattr(candidate, "duration", None) if candidate else None
    hashtags = getattr(candidate, "hashtags", []) if candidate else []
    source_hashtags = ",".join(hashtags) if hashtags else None
    slots = pipeline.get("slots") or []
    places = pipeline.get("places") or []
    unresolved_suggestions = pipeline.get("unresolved_suggestions") or []

    if not places:
        reviewable_candidates = collect_reviewable_unresolved_candidates(unresolved_suggestions)
        resolution_timed_out = pipeline.get("timed_out_stage") == "resolution"
        reason = (
            "resolution_timeout" if resolution_timed_out
            else "needs_confirmation" if reviewable_candidates
            else "no_slots" if not slots
            else "no_google_match"
        )
        log_failed_link(
            user_id=user_id,
            url=text,
            platform="instagram",
            reason=reason,
            failure_stage="resolution" if reason != "no_slots" else "extraction",
            caption_preview=(getattr(candidate, "description", "") or "")[:300],
            request_id=request_id,
            details={
                "metadata_source": pipeline.get("metadata_source"),
                "metadata_cache_hit": bool(pipeline.get("metadata_cache_hit")),
                "slot_count": len(slots),
                "reviewable_candidate_count": len(reviewable_candidates),
                "unresolved_count": len(unresolved_suggestions),
            },
        )
        await prompt_instagram_manual_fallback(
            status_msg,
            context,
            text,
            user_id=user_id,
            unresolved_candidates=reviewable_candidates if reviewable_candidates else None,
        )
        return True

    resolved_sources = [place.matched_source_type for place in places if place.matched_source_type]
    match_source = resolved_sources[0] if resolved_sources else (slots[0].source if slots else None)

    if len(places) == 1 and not unresolved_suggestions:
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
        await status_msg.delete()
        _clear_instagram_fallback_pending(context)
        return True

    await _start_multi_place_selection(
        context,
        status_msg,
        user_id=user_id,
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


async def _handle_tiktok_url(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    text: str,
    status_msg,
    *,
    request_id: str | None = None,
) -> None:
    user_id = update.effective_user.id
    await status_msg.edit_text("Reading the caption... 📝")

    async def show_stage(stage: str) -> None:
        if stage == "resolving":
            await status_msg.edit_text("Resolving place names... 🔎")

    pipeline = await run_tiktok_place_pipeline(text, on_stage=show_stage)

    if pipeline["status"] == "failed" or pipeline.get("timed_out_stage") == "metadata":
        logger.warning("TikTok pipeline failed: user_id=%s error=%s", user_id, pipeline.get("error"))
        timed_out = pipeline.get("timed_out_stage") == "metadata"
        log_failed_link(
            user_id=user_id,
            url=text,
            platform="tiktok",
            reason="metadata_timeout" if timed_out else "metadata_failed",
            failure_stage="metadata",
            error_message=pipeline.get("error"),
            request_id=request_id,
            details={"pipeline_status": pipeline.get("status")},
        )
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

    if not places:
        reviewable_candidates = collect_reviewable_unresolved_candidates(unresolved_suggestions)
        resolution_timed_out = pipeline.get("timed_out_stage") == "resolution"
        reason = (
            "resolution_timeout" if resolution_timed_out
            else "needs_confirmation" if reviewable_candidates
            else "no_slots" if not slots
            else "no_google_match"
        )
        log_failed_link(
            user_id=user_id,
            url=text,
            platform="tiktok",
            reason=reason,
            failure_stage="resolution" if reason != "no_slots" else "extraction",
            caption_preview=(getattr(candidate, "description", "") or "")[:300],
            request_id=request_id,
            details={
                "metadata_source": pipeline.get("metadata_source"),
                "slot_count": len(slots),
                "reviewable_candidate_count": len(reviewable_candidates),
                "unresolved_count": len(unresolved_suggestions),
            },
        )
        await prompt_tiktok_manual_fallback(
            status_msg,
            context,
            text,
            user_id=user_id,
            unresolved_candidates=reviewable_candidates if reviewable_candidates else None,
        )
        return

    resolved_sources = [place.matched_source_type for place in places if place.matched_source_type]
    match_source = resolved_sources[0] if resolved_sources else (slots[0].source if slots else None)

    if len(places) == 1 and not unresolved_suggestions:
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
        await status_msg.delete()
        _clear_manual_place_pending(context)
        return

    await _start_multi_place_selection(
        context,
        status_msg,
        user_id=user_id,
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


def build_selection_keyboard(
    places: list,
    selected_indices: set,
    *,
    session_id: str = "legacy",
) -> InlineKeyboardMarkup:
    """Build keyboard for multi-place selection. Save All is the primary CTA."""
    keyboard = []

    # Primary CTA — save everything, one tap
    total = len(places)
    save_all_data = "save_all" if session_id == "legacy" else f"ps:{session_id}:all"
    keyboard.append([
        InlineKeyboardButton(f"✅ Save All {total}", callback_data=save_all_data),
    ])

    # Toggle rows for users who want to pick
    for i, place in enumerate(places):
        checkbox = "☑️" if i in selected_indices else "⬜"
        name = place["name"][:22] + "…" if len(place["name"]) > 22 else place["name"]
        toggle_data = f"toggle_place_{i}" if session_id == "legacy" else f"ps:{session_id}:t:{i}"
        keyboard.append([
            InlineKeyboardButton(f"{checkbox} {name}", callback_data=toggle_data)
        ])

    selected_count = len(selected_indices)
    save_text = f"Save Selected ({selected_count})" if selected_count > 0 else "Save Selected"
    save_selected_data = "save_selected" if session_id == "legacy" else f"ps:{session_id}:sel"
    cancel_data = "cancel_selection" if session_id == "legacy" else f"ps:{session_id}:cancel"
    keyboard.append([
        InlineKeyboardButton(save_text, callback_data=save_selected_data),
        InlineKeyboardButton("None of these", callback_data=cancel_data),
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


def build_reviewable_candidate_keyboard(
    candidates: list[dict],
    *,
    session_id: str = "legacy",
) -> InlineKeyboardMarkup:
    """Buttons for real Google Place candidates pending user confirmation."""
    keyboard = []
    for index, candidate in enumerate(candidates[:6]):
        label = candidate["name"][:28] + "..." if len(candidate["name"]) > 28 else candidate["name"]
        callback_data = (
            f"unresolved_pick_{index}"
            if session_id == "legacy"
            else f"ur:{session_id}:{index}"
        )
        keyboard.append([
            InlineKeyboardButton(f"Try: {label}", callback_data=callback_data)
        ])
    return InlineKeyboardMarkup(keyboard)


def _parse_place_selection_callback(data: str) -> tuple[str, str, int | None]:
    """Return session ID, action, and optional place index for V2 or legacy buttons."""
    if data.startswith("ps:"):
        parts = data.split(":")
        if len(parts) == 4 and parts[2] == "t":
            return parts[1], "toggle", int(parts[3])
        if len(parts) == 3 and parts[2] in {"sel", "all", "cancel"}:
            return parts[1], parts[2], None
        raise ValueError("Invalid place-selection callback")
    if data.startswith("toggle_place_"):
        return "legacy", "toggle", int(data.replace("toggle_place_", ""))
    legacy_actions = {
        "save_selected": "sel",
        "save_all": "all",
        "cancel_selection": "cancel",
    }
    if data in legacy_actions:
        return "legacy", legacy_actions[data], None
    raise ValueError("Invalid place-selection callback")


def _load_place_session(context, user_id: int, session_id: str) -> dict | None:
    """Load one V2 session, with in-memory fallback for pre-deployment buttons."""
    if session_id == "legacy" and context.user_data.get("pending_places"):
        return {
            "pending_places": context.user_data["pending_places"],
            "selected_indices": list(context.user_data.get("selected_indices", set())),
            "pending_video_meta": context.user_data.get("pending_video_meta", {}),
            "pending_url": context.user_data.get("pending_url", ""),
            "pending_platform": context.user_data.get("pending_platform", "unknown"),
        }
    if session_id == "legacy":
        return repository.get_bot_session(user_id, "place_selection")
    return repository.get_bot_session_v2(user_id, "place_selection", session_id)


def _persist_place_session(
    context,
    user_id: int,
    session_id: str,
    session: dict,
) -> None:
    """Persist one place-selection session without replacing sibling cards."""
    if session_id == "legacy":
        repository.save_bot_session(user_id, "place_selection", session)
        context.user_data["pending_places"] = session.get("pending_places", [])
        context.user_data["selected_indices"] = set(session.get("selected_indices", []))
        context.user_data["pending_video_meta"] = session.get("pending_video_meta", {})
        context.user_data["pending_url"] = session.get("pending_url", "")
        context.user_data["pending_platform"] = session.get("pending_platform", "unknown")
        return
    repository.save_bot_session_v2(
        user_id,
        "place_selection",
        session_id,
        session,
    )


def _clear_place_session(context, user_id: int, session_id: str) -> None:
    """Clear exactly one place-selection session."""
    if session_id == "legacy":
        for key in ("pending_places", "pending_url", "pending_platform", "pending_video_meta", "selected_indices"):
            context.user_data.pop(key, None)
    try:
        if session_id == "legacy":
            repository.delete_bot_session(user_id, "place_selection")
        else:
            repository.delete_bot_session_v2(user_id, "place_selection", session_id)
    except Exception:
        pass


@serialized_user_flow
async def toggle_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Toggle place selection checkbox."""
    query = update.callback_query
    user_id = update.effective_user.id

    try:
        session_id, action, index = _parse_place_selection_callback(query.data)
    except ValueError:
        await _safe_answer_callback(query, "Error!")
        return
    if action != "toggle" or index is None:
        await _safe_answer_callback(query, "Error!")
        return

    session = _load_place_session(context, user_id, session_id)
    if not session:
        await _safe_answer_callback(query, "Session timed out!")
        await _safe_edit_callback_message(query, "That session timed out — just resend the link and I'll try again. 🔄")
        return

    pending_places = session.get("pending_places", [])
    if not 0 <= index < len(pending_places):
        await _safe_answer_callback(query, "Error!")
        return

    selected = set(session.get("selected_indices", []))
    if index in selected:
        selected.discard(index)
        await _safe_answer_callback(query, "Removed")
    else:
        selected.add(index)
        await _safe_answer_callback(query, "Selected!")

    session["selected_indices"] = list(selected)
    _persist_place_session(context, user_id, session_id, session)

    # Rebuild keyboard and update message
    video_meta = session.get("pending_video_meta", {})
    keyboard = build_selection_keyboard(pending_places, selected, session_id=session_id)
    message = build_selection_message(pending_places, selected, video_meta)
    await _safe_edit_callback_message(query, message, reply_markup=keyboard)


@serialized_user_flow
async def save_selected_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Save all selected places."""
    user_id = update.effective_user.id
    query = update.callback_query
    ensure_bot_user(update)

    try:
        session_id, action, _ = _parse_place_selection_callback(query.data)
    except ValueError:
        await _safe_answer_callback(query, "Error!")
        return
    if action != "sel":
        await _safe_answer_callback(query, "Error!")
        return

    session = _load_place_session(context, user_id, session_id)
    if not session:
        await _safe_answer_callback(query, "Session timed out!")
        await _safe_edit_callback_message(query, "That session timed out — just resend the link and I'll try again.")
        return

    pending_places = session.get("pending_places", [])
    selected = {
        index for index in session.get("selected_indices", [])
        if isinstance(index, int) and 0 <= index < len(pending_places)
    }

    if not selected:
        await _safe_answer_callback(query, "Pick some places first!")
        return

    await query.answer("Saving...")
    await query.edit_message_text("Saving your places... 💾")

    # Get metadata
    source_url = session.get("pending_url", "")
    source_platform = session.get("pending_platform", "unknown")
    video_meta = session.get("pending_video_meta", {})

    # Save all selected places
    saved_names = []
    existing_names = []
    failed_names = []
    for i in sorted(selected):
        place_data = pending_places[i]
        outcome = repository.add_place_with_outcome(
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
            country_code=place_data.get("country_code"),
            city=place_data.get("city"),
            neighborhood=place_data.get("neighborhood"),
            primary_cuisine=place_data.get("primary_cuisine"),
            source_language=video_meta.get("source_language"),
            source_transcript=video_meta.get("source_transcript"),
            source_transcript_en=video_meta.get("source_transcript_en"),
        )
        if not outcome.get("place"):
            failed_names.append(place_data["name"])
            log_failed_link(
                user_id=user_id,
                url=source_url,
                platform=source_platform,
                reason="save_failed",
                failure_stage="persistence",
                request_id=session_id,
                details={"place_name": place_data["name"], "selection_mode": "selected"},
            )
        else:
            (saved_names if outcome.get("created") else existing_names).append(place_data["name"])

    # Clear pending data
    _clear_place_session(context, user_id, session_id)

    # Show confirmation
    await query.delete_message()

    count = len(saved_names)
    names_text = "\n".join(f"• {html.escape(name)}" for name in saved_names)
    existing_text = f"\n\n✓ {len(existing_names)} already in your saves" if existing_names else ""
    failed_text = f"\n\n⚠️ {len(failed_names)} could not be saved" if failed_names else ""
    new_places_text = f"\n\n{names_text}" if names_text else ""
    await query.message.reply_text(
        f"✅ Saved {count} new place{'s' if count != 1 else ''}"
        f"{new_places_text}{existing_text}{failed_text}",
        parse_mode="HTML",
    )
    if saved_names:
        record_bot_event(user_id, "extraction_succeeded", entity_type="extraction", entity_id=session.get("request_id") or session_id, metadata={"platform": source_platform, "result": "saved"})


@serialized_user_flow
async def save_all_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Save all pending places without requiring individual selection."""
    user_id = update.effective_user.id
    query = update.callback_query
    ensure_bot_user(update)

    try:
        session_id, action, _ = _parse_place_selection_callback(query.data)
    except ValueError:
        await _safe_answer_callback(query, "Error!")
        return
    if action != "all":
        await _safe_answer_callback(query, "Error!")
        return

    session = _load_place_session(context, user_id, session_id)
    if not session:
        await _safe_answer_callback(query, "Session timed out!")
        await _safe_edit_callback_message(query, "That session timed out — just resend the link and I'll try again.")
        return

    pending_places = session.get("pending_places", [])

    await query.answer("Saving all...")
    await query.edit_message_text("Saving your places... 💾")

    source_url = session.get("pending_url", "")
    source_platform = session.get("pending_platform", "unknown")
    video_meta = session.get("pending_video_meta", {})

    saved_names = []
    existing_names = []
    failed_names = []
    for place_data in pending_places:
        outcome = repository.add_place_with_outcome(
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
            country_code=place_data.get("country_code"),
            city=place_data.get("city"),
            neighborhood=place_data.get("neighborhood"),
            primary_cuisine=place_data.get("primary_cuisine"),
            source_language=video_meta.get("source_language"),
            source_transcript=video_meta.get("source_transcript"),
            source_transcript_en=video_meta.get("source_transcript_en"),
        )
        if not outcome.get("place"):
            failed_names.append(place_data["name"])
            log_failed_link(
                user_id=user_id,
                url=source_url,
                platform=source_platform,
                reason="save_failed",
                failure_stage="persistence",
                request_id=session_id,
                details={"place_name": place_data["name"], "selection_mode": "all"},
            )
        else:
            (saved_names if outcome.get("created") else existing_names).append(place_data["name"])

    _clear_place_session(context, user_id, session_id)

    await query.delete_message()

    count = len(saved_names)
    names_text = "\n".join(f"• {html.escape(name)}" for name in saved_names)
    existing_text = f"\n\n✓ {len(existing_names)} already in your saves" if existing_names else ""
    failed_text = f"\n\n⚠️ {len(failed_names)} could not be saved" if failed_names else ""
    new_places_text = f"\n\n{names_text}" if names_text else ""
    await query.message.reply_text(
        f"✅ Saved {count} new place{'s' if count != 1 else ''}"
        f"{new_places_text}{existing_text}{failed_text}",
        parse_mode="HTML",
    )
    if saved_names:
        record_bot_event(user_id, "extraction_succeeded", entity_type="extraction", entity_id=session.get("request_id") or session_id, metadata={"platform": source_platform, "result": "saved"})


@serialized_user_flow
async def unresolved_pick_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Save one unresolved-but-real Google candidate after user confirmation."""
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    try:
        if query.data.startswith("ur:"):
            _, session_id, raw_index = query.data.split(":")
            index = int(raw_index)
        else:
            session_id = "legacy"
            index = int(query.data.replace("unresolved_pick_", ""))
    except (ValueError, IndexError):
        await query.answer("Invalid suggestion")
        return

    if session_id == "legacy":
        session = {
            "pending_unresolved_slots": context.user_data.get("pending_unresolved_slots"),
            "pending_url": context.user_data.get("pending_url", ""),
            "pending_platform": context.user_data.get("pending_platform", "unknown"),
            "pending_video_meta": context.user_data.get("pending_video_meta", {}),
        }
    else:
        session = repository.get_bot_session_v2(
            user_id,
            "unresolved_selection",
            session_id,
        ) or {}

    unresolved_slots = session.get("pending_unresolved_slots")
    if not unresolved_slots:
        await query.edit_message_text("That session timed out — just resend the link and I'll try again.")
        return

    try:
        suggestion = unresolved_slots[index]
    except IndexError:
        await query.answer("Invalid suggestion")
        return

    place = suggestion
    await query.edit_message_text(f"Saving “{place['name']}”...")

    ensure_bot_user(update)
    source_url = session.get("pending_url", "")
    source_platform = session.get("pending_platform", "unknown")
    video_meta = session.get("pending_video_meta", {})

    outcome = repository.add_place_with_outcome(
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

    if session_id == "legacy":
        context.user_data.pop("pending_unresolved_slots", None)
    else:
        repository.delete_bot_session_v2(
            user_id,
            "unresolved_selection",
            session_id,
        )

    saved = outcome.get("place")
    saved_place_id = get_saved_place_id(saved)
    if not saved_place_id:
        log_failed_link(
            user_id=user_id,
            url=source_url,
            platform=source_platform,
            reason="save_failed",
            failure_stage="persistence",
            request_id=session_id,
            details={"place_name": place["name"], "selection_mode": "unresolved_candidate"},
        )
        await query.message.reply_text("I found the place, but couldn't save it. Please try again.")
        return
    correction_session_id = uuid.uuid4().hex[:8]
    if saved_place_id:
        repository.save_bot_session_v2(user_id, "place_correction", correction_session_id, {
            "place_id": saved_place_id,
            "source_url": source_url,
            "source_platform": source_platform,
            "candidates": [],
        })
    await query.message.reply_text(
        build_saved_place_message(saved or place, source_url=source_url, created=bool(outcome.get("created"))),
        parse_mode="HTML",
        disable_web_page_preview=True,
        reply_markup=build_saved_place_keyboard(
            saved or place,
            saved_place_id=saved_place_id,
            correction_session_id=correction_session_id,
            created=bool(outcome.get("created")),
            source_url=source_url,
        ) if saved_place_id else None,
    )


@serialized_user_flow
async def cancel_selection_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cancel place selection."""
    query = update.callback_query
    user_id = update.effective_user.id
    try:
        session_id, action, _ = _parse_place_selection_callback(query.data)
    except ValueError:
        await _safe_answer_callback(query, "Error!")
        return
    if action != "cancel":
        await _safe_answer_callback(query, "Error!")
        return
    await query.answer("Discarded")

    _clear_place_session(context, user_id, session_id)

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
        session_id = uuid.uuid4().hex[:8]
        session = {
            "place_id": place_id,
            "source_url": correction_context.get("source_url", ""),
            "source_platform": correction_context.get("source_platform", "unknown"),
            "candidates": [],
        }
        repository.save_bot_session_v2(user_id, "place_correction", session_id, session)
        context.user_data["pending_correction_session_id"] = session_id
        context.user_data.pop("correction_place_context", None)
        await query.edit_message_reply_markup(reply_markup=None)
        await query.message.reply_text(
            "Reply with the correct place name. I’ll keep the current save until the replacement succeeds."
        )


def _place_result_from_payload(candidate: dict):
    """Rehydrate the serialisable subset stored in correction sessions."""
    from services.places import PlaceResult
    return PlaceResult(
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
        description=candidate.get("description"),
        country_code=candidate.get("country_code"),
        city=candidate.get("city"),
        neighborhood=candidate.get("neighborhood"),
        primary_cuisine=candidate.get("primary_cuisine"),
    )


async def _complete_safe_correction(message, user_id: int, session_id: str, session: dict, place):
    """Save the replacement first; only then remove the old row."""
    outcome = repository.add_place_with_outcome(
        user_id=user_id,
        name=place.name,
        address=place.address,
        latitude=place.latitude,
        longitude=place.longitude,
        google_place_id=place.place_id,
        source_url=session.get("source_url", ""),
        source_platform=session.get("source_platform", "unknown"),
        place_types=",".join(place.types) if place.types else None,
        country_code=getattr(place, "country_code", None),
        city=getattr(place, "city", None),
        neighborhood=getattr(place, "neighborhood", None),
        primary_cuisine=getattr(place, "primary_cuisine", None),
        place_rating=place.rating,
        place_rating_count=place.rating_count,
        place_price_level=place.price_level,
        place_opening_hours=place.opening_hours,
        place_description=place.description,
    )
    saved = outcome.get("place")
    new_id = get_saved_place_id(saved)
    old_id = int(session["place_id"])
    if not new_id:
        raise RuntimeError("Replacement place was not saved")
    if new_id != old_id:
        repository.delete_place(user_id, old_id)
    repository.delete_bot_session_v2(user_id, "place_correction", session_id)

    next_session_id = uuid.uuid4().hex[:8]
    repository.save_bot_session_v2(user_id, "place_correction", next_session_id, {
        "place_id": new_id,
        "source_url": session.get("source_url", ""),
        "source_platform": session.get("source_platform", "unknown"),
        "candidates": [],
    })
    changed_message = build_saved_place_message(saved, created=True)
    changed_lines = changed_message.splitlines()
    changed_lines[0] = f"✅ Changed to <b>{html.escape(str(saved.get('name') or place.name))}</b>"
    await message.reply_text(
        "\n".join(changed_lines),
        parse_mode="HTML",
        disable_web_page_preview=True,
        reply_markup=build_saved_place_keyboard(
            saved,
            saved_place_id=new_id,
            correction_session_id=next_session_id,
            created=bool(outcome.get("created")),
            source_url=session.get("source_url"),
        ),
    )
    record_bot_event(user_id, "place_correction_completed", entity_type="place", entity_id=new_id)


@serialized_user_flow
async def change_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Start a session-scoped correction without deleting the current save."""
    query = update.callback_query
    user_id = update.effective_user.id
    parts = query.data.split(":")
    if len(parts) != 3:
        await _safe_answer_callback(query, "This action expired")
        return
    session_id = parts[1]
    session = repository.get_bot_session_v2(user_id, "place_correction", session_id)
    if not session:
        await _safe_answer_callback(query, "This action expired")
        return
    await query.answer()
    await query.edit_message_reply_markup(reply_markup=None)
    candidates = session.get("candidates") or []
    if candidates:
        rows = []
        for index, candidate in enumerate(candidates[:5]):
            label = str(candidate.get("name") or "Place")[:35]
            rows.append([InlineKeyboardButton(label, callback_data=f"cp:{session_id}:pick:{index}")])
        rows.append([InlineKeyboardButton("Type the place name", callback_data=f"cp:{session_id}:manual")])
        await query.message.reply_text("Which place did you mean?", reply_markup=InlineKeyboardMarkup(rows))
    else:
        context.user_data["pending_correction_session_id"] = session_id
        await query.message.reply_text("Reply with the correct restaurant or cafe name. I’ll keep the current save until the replacement succeeds.")
    record_bot_event(user_id, "place_correction_started", entity_type="place", entity_id=session.get("place_id"))


@serialized_user_flow
async def correction_session_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle a V2 correction candidate or switch the session to manual search."""
    query = update.callback_query
    user_id = update.effective_user.id
    parts = query.data.split(":")
    if len(parts) < 3:
        await _safe_answer_callback(query, "This action expired")
        return
    session_id, action = parts[1], parts[2]
    session = repository.get_bot_session_v2(user_id, "place_correction", session_id)
    if not session:
        await _safe_answer_callback(query, "This action expired")
        return
    await query.answer()
    await query.edit_message_reply_markup(reply_markup=None)
    if action == "manual":
        context.user_data["pending_correction_session_id"] = session_id
        await query.message.reply_text("Reply with the correct restaurant or cafe name.")
        return
    try:
        candidate = session.get("candidates", [])[int(parts[3])]
        await _complete_safe_correction(query.message, user_id, session_id, session, _place_result_from_payload(candidate))
    except (IndexError, ValueError, KeyError):
        await query.message.reply_text("That option expired. Tap Change Place on the original card and try again.")
    except Exception:
        logger.exception("Could not complete correction for user_id=%s", user_id)
        await query.message.reply_text("I couldn't change it, so I kept the original save. Please try again.")


@serialized_user_flow
async def undo_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Undo a newly-created save and offer a recoverable restore action."""
    query = update.callback_query
    user_id = update.effective_user.id
    try:
        place_id = int(query.data.split(":", 1)[1])
    except (IndexError, ValueError):
        await _safe_answer_callback(query, "This action expired")
        return
    deleted = repository.delete_place(user_id, place_id)
    await query.answer("Removed" if deleted else "Already removed")
    await query.edit_message_text(
        "Removed from your saves.",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("Restore", callback_data=f"restore:{place_id}")
        ]]) if deleted else None,
    )
    if deleted:
        record_bot_event(user_id, "place_save_undone", entity_type="place", entity_id=place_id)


@serialized_user_flow
async def restore_place_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    user_id = update.effective_user.id
    try:
        place_id = int(query.data.split(":", 1)[1])
    except (IndexError, ValueError):
        await _safe_answer_callback(query, "This action expired")
        return
    restored = repository.restore_place(user_id, place_id)
    await query.answer("Restored" if restored else "Could not restore")
    await query.edit_message_text("✅ Restored to your saves." if restored else "This place could not be restored.")


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

    await query.edit_message_reply_markup(reply_markup=None)

    if pick == "manual":
        session_id = uuid.uuid4().hex[:8]
        session = {
            "place_id": place_id,
            "source_url": correction_context.get("source_url", ""),
            "source_platform": correction_context.get("source_platform", "unknown"),
            "candidates": [],
        }
        repository.save_bot_session_v2(user_id, "place_correction", session_id, session)
        context.user_data["pending_correction_session_id"] = session_id
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

    session_id = uuid.uuid4().hex[:8]
    session = {
        "place_id": place_id,
        "source_url": correction_context.get("source_url", ""),
        "source_platform": correction_context.get("source_platform", "unknown"),
        "candidates": [],
    }
    repository.save_bot_session_v2(user_id, "place_correction", session_id, session)
    try:
        await _complete_safe_correction(query.message, user_id, session_id, session, place)
    except Exception:
        logger.exception("Could not complete legacy correction for user_id=%s", user_id)
        await query.message.reply_text("I couldn't change it, so I kept the original save. Please try again.")


async def _start_private_url_extraction(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    text: str,
    *,
    status_msg=None,
) -> None:
    user_id = update.effective_user.id
    ensure_bot_user(update)

    if not is_valid_url(text):
        return

    platform = detect_platform(text)
    logger.info("URL received: user_id=%s platform=%s", user_id, platform)

    task_id = uuid.uuid4().hex[:8]
    started_at = asyncio.get_running_loop().time()
    record_bot_event(user_id, "link_received", entity_type="extraction", entity_id=task_id, metadata={"platform": platform})
    cancel_markup = build_cancel_extraction_keyboard(task_id)
    if status_msg is None:
        reply_message = getattr(update, "effective_message", None) or update.message
        status_msg = await reply_message.reply_text(
            "Ooh, fresh content! Let me dig in... 🔍",
            reply_markup=cancel_markup,
        )
    else:
        await status_msg.edit_text(
            "Ooh, fresh content! Let me dig in... 🔍",
            reply_markup=cancel_markup,
        )

    async def _run():
        if platform == "instagram" and config.INSTAGRAM_NO_COOKIE_ENABLED:
            await _handle_instagram_no_cookie_url(
                update, context, text, status_msg, request_id=task_id
            )
            return
        if platform == "tiktok":
            await _handle_tiktok_url(update, context, text, status_msg, request_id=task_id)
            return
        log_failed_link(
            user_id=user_id,
            url=text,
            platform=platform or "other",
            reason="unsupported_platform",
            failure_stage="validation",
            request_id=task_id,
        )
        await status_msg.edit_text(
            "I can only extract places from Instagram and TikTok links right now.",
            reply_markup=None,
        )

    async with _get_user_flow_lock(user_id):
        previous_task = context.user_data.get("active_extraction_task")
        if previous_task and not previous_task.done():
            previous_task.cancel()
        task = asyncio.create_task(_run())
        context.user_data[f'extraction_task_{task_id}'] = task
        context.user_data["active_extraction_task"] = task
        context.user_data["active_extraction_task_id"] = task_id
    try:
        await asyncio.wait_for(task, timeout=config.BOT_EXTRACTION_TIMEOUT_SECONDS)
        record_bot_event(
            user_id,
            "extraction_finished",
            entity_type="extraction",
            entity_id=task_id,
            metadata={"platform": platform, "duration_ms": int((asyncio.get_running_loop().time() - started_at) * 1000)},
        )
    except asyncio.TimeoutError:
        logger.warning(
            "Bot extraction deadline reached: user_id=%s platform=%s",
            user_id,
            platform,
        )
        record_bot_event(
            user_id,
            "extraction_timed_out",
            entity_type="extraction",
            entity_id=task_id,
            metadata={"platform": platform, "timeout_seconds": config.BOT_EXTRACTION_TIMEOUT_SECONDS},
        )
        log_failed_link(
            user_id=user_id,
            url=text,
            platform=platform or "other",
            reason="extraction_timeout",
            failure_stage="pipeline",
            error_message=f"Exceeded {config.BOT_EXTRACTION_TIMEOUT_SECONDS:g}s outer deadline",
            request_id=task_id,
            details={"timeout_seconds": config.BOT_EXTRACTION_TIMEOUT_SECONDS},
        )
        if platform == "instagram":
            await prompt_instagram_manual_fallback(
                status_msg,
                context,
                text,
                user_id=user_id,
                timed_out=True,
            )
        elif platform == "tiktok":
            await prompt_tiktok_manual_fallback(status_msg, context, text)
        else:
            await safe_edit_status(status_msg, "I couldn't finish processing that link. Please try again.")
    except asyncio.CancelledError:
        record_bot_event(user_id, "extraction_cancelled", entity_type="extraction", entity_id=task_id, metadata={"platform": platform})
        try:
            await status_msg.edit_text("Cancelled. Send another link anytime.", reply_markup=None)
        except Exception:
            pass
    except Exception as exc:
        logger.exception(
            "Extraction failed unexpectedly: user_id=%s platform=%s",
            user_id,
            platform,
        )
        record_bot_event(user_id, "extraction_failed", entity_type="extraction", entity_id=task_id, metadata={"platform": platform})
        log_failed_link(
            user_id=user_id,
            url=text,
            platform=platform or "other",
            reason="extraction_exception",
            failure_stage="pipeline",
            error_message=str(exc),
            request_id=task_id,
        )
        if platform == "instagram":
            _set_instagram_fallback_pending(context, text)
        elif platform == "tiktok":
            _set_tiktok_fallback_pending(context, text)
        await safe_edit_status(
            status_msg,
            "Something went wrong while checking that link. Please try again or reply with the place name.",
        )
    finally:
        async with _get_user_flow_lock(user_id):
            context.user_data.pop(f'extraction_task_{task_id}', None)
            if context.user_data.get("active_extraction_task") is task:
                context.user_data.pop("active_extraction_task", None)
                context.user_data.pop("active_extraction_task_id", None)


async def handle_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Group URLs are handled by handle_group_url
    if update.effective_chat.type in ("group", "supergroup"):
        return
    text = update.message.text.strip()
    await _start_private_url_extraction(update, context, text)


async def cancel_extraction_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cancel an in-progress extraction task."""
    query = update.callback_query
    await query.answer("Cancelling...")

    task_id = query.data.replace("cancel_extraction_", "")
    user_id = update.effective_user.id
    async with _get_user_flow_lock(user_id):
        task = context.user_data.pop(f'extraction_task_{task_id}', None)
        if context.user_data.get("active_extraction_task") is task:
            context.user_data.pop("active_extraction_task", None)
            context.user_data.pop("active_extraction_task_id", None)
    if task and not task.done():
        task.cancel()
    else:
        # Already finished — just remove the button
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:
            pass


async def retry_extraction_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Retry a failed Instagram extraction without asking the user to resend the URL."""
    query = update.callback_query
    await query.answer("Retrying...")
    session_id = query.data.replace("retry_extraction_", "")
    user_id = update.effective_user.id
    sessions = context.user_data.get("extraction_retry_sessions", {})
    payload = sessions.pop(session_id, None)
    if payload is None:
        try:
            payload = repository.get_bot_session_v2(
                user_id,
                "extraction_retry",
                session_id,
            )
        except Exception:
            logger.warning("Could not restore extraction retry session", exc_info=True)
    if not payload or not payload.get("url"):
        await query.edit_message_text(
            "That retry expired. Send the Instagram link again and I'll take another look."
        )
        return

    try:
        repository.delete_bot_session_v2(user_id, "extraction_retry", session_id)
    except Exception:
        logger.warning("Could not delete extraction retry session", exc_info=True)
    await _start_private_url_extraction(
        update,
        context,
        payload["url"],
        status_msg=query.message,
    )


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
        context.user_data.pop("waiting_display_name", None)
        context.user_data.pop("pending_correction_session_id", None)
        _clear_manual_place_pending(context)
        _clear_instagram_fallback_pending(context)
        await handle_url(update, context)
        return

    correction_session_id = context.user_data.get("pending_correction_session_id")
    if correction_session_id:
        session = repository.get_bot_session_v2(user_id, "place_correction", correction_session_id)
        if not session:
            context.user_data.pop("pending_correction_session_id", None)
            await update.message.reply_text("That correction expired. Tap Change Place on the saved card to try again.")
            return
        status_msg = await update.message.reply_text("Searching for that place... 🔍")
        try:
            place = await search_place(text)
            if not place:
                await status_msg.edit_text(f"I couldn't find “{text}”. Try adding the neighbourhood or city.")
                return
            await status_msg.delete()
            await _complete_safe_correction(update.message, user_id, correction_session_id, session, place)
            context.user_data.pop("pending_correction_session_id", None)
        except Exception:
            logger.exception("Manual correction failed for user_id=%s", user_id)
            await status_msg.edit_text("I couldn't change it, so I kept the original save. Try a more specific name.")
        return

    # Check if waiting for display name input
    if context.user_data.get("waiting_display_name"):
        display_name = text[:50]  # cap at 50 chars
        user_id2 = update.effective_user.id
        repository.update_user_profile(user_id2, display_name=display_name)
        context.user_data.pop("waiting_display_name", None)
        keyboard = [[InlineKeyboardButton("❓ How it works", callback_data="action_howto")]]
        if config.WEBAPP_URL:
            keyboard.append([InlineKeyboardButton("🗺️ Open My Map", web_app=WebAppInfo(url=config.WEBAPP_URL))])
        await update.message.reply_text(
            f"✅ Got it, {display_name}!\n\nJust send me a video link to get started. 🎬",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
        return

    # Check if this is a response to a pending search
    pending_url = context.user_data.get("pending_url")
    if not pending_url:
        await update.message.reply_text(
            "Send an Instagram Reel or TikTok link and I’ll save the food place.\n\n"
            "You can also use /feedback to report a problem."
        )
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

        # Clear pending state
        _clear_manual_place_pending(context)
        _clear_instagram_fallback_pending(context)

        await status_msg.delete()

        await _save_single_place_result(
            update,
            context,
            user_id=user_id,
            place=place,
            source_url=pending_url,
            source_platform=pending_platform,
        )

    except Exception as e:
        logger.error(f"Error searching place: {e}")
        await status_msg.edit_text(
            "Hmm, couldn't find that one. Try a different name?"
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
    had_saved_report = bool(context.user_data.get("feedback_context", {}).get("report_id"))
    clear_feedback_context(context)
    await update.message.reply_text(
        "Stopped collecting more details. Your feedback was already received."
        if had_saved_report else "Feedback cancelled."
    )
    return ConversationHandler.END


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
            web_app=WebAppInfo(url=build_webapp_url(config.WEBAPP_URL, "review", place_id))
        )]]
        await query.message.reply_text(
            "Tap below to write your review in the app 👇",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
    else:
        await query.message.reply_text("Open the app to write your review.")


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


def _group_map_url(group_id: int) -> str | None:
    """Build an opaque group-map URL; never expose the Telegram chat id."""
    if not config.WEBAPP_URL:
        return None
    try:
        token = repository.get_or_create_group_map_share(group_id)
        return build_webapp_url(config.WEBAPP_URL, "group", token, bot=config.TELEGRAM_BOT_USERNAME or None)
    except Exception:
        logger.error("Group share-token table unavailable", exc_info=True)
        return None


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

    group_map_url = _group_map_url(chat.id)
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

    outcome = repository.add_place_with_outcome(
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
    saved = outcome.get("place")
    if not saved:
        return None
    if not outcome.get("created"):
        record_bot_event(sharer_id, "group_place_duplicate", entity_type="place", entity_id=saved.get("id"))
        return "existing"
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

    group_map_url = _group_map_url(chat.id)
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
    record_bot_event(sharer_id, "group_place_saved", entity_type="place", entity_id=place_id)
    return "created"


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
            save_status = await _save_and_post_group_place(
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
            if save_status == "existing":
                await update.message.reply_text("That place is already on the Group Map.")
            elif save_status is None:
                log_failed_link(
                    user_id=update.effective_user.id,
                    url=pending["source_url"],
                    platform=pending["source_platform"],
                    reason="save_failed",
                    failure_stage="persistence",
                    flow="group",
                    details={"place_name": get_place_value(place, "name", text)},
                )
                await update.message.reply_text("I found the place but couldn't add it. Please try again.")
            context.chat_data.get("pending_name_requests", {}).pop(reply_to.message_id, None)
            return

    if not is_valid_url(text):
        return

    platform = detect_platform(text)
    ensure_bot_user(update)
    sharer_id = update.effective_user.id
    logger.info("Group URL received: chat_id=%s platform=%s", chat.id, platform)

    task_id = uuid.uuid4().hex[:8]
    status_msg = await update.message.reply_text(
        "Checking this out... 🔍",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✕ Cancel", callback_data=f"grp_cancel:{task_id}:{sharer_id}")
        ]]),
    )

    async def _run():
        await status_msg.edit_text("Reading the caption... 📝")
        if platform == "instagram" and config.INSTAGRAM_NO_COOKIE_ENABLED:
            pipeline = await run_instagram_place_pipeline(text)
        elif platform == "tiktok":
            pipeline = await run_tiktok_place_pipeline(text)
        else:
            log_failed_link(
                user_id=sharer_id,
                url=text,
                platform=platform or "other",
                reason="unsupported_platform",
                failure_stage="validation",
                flow="group",
                request_id=task_id,
            )
            await status_msg.edit_text("I can only process Instagram and TikTok links.")
            return

        if pipeline.get("status") == "failed" or not pipeline.get("places"):
            candidate = pipeline.get("metadata_candidate")
            slots = pipeline.get("slots") or []
            unresolved = pipeline.get("unresolved_suggestions") or []
            reviewable_candidates = collect_reviewable_unresolved_candidates(unresolved)
            timed_out_stage = pipeline.get("timed_out_stage")
            reason = (
                "metadata_timeout" if timed_out_stage == "metadata"
                else "metadata_failed" if pipeline.get("status") == "failed"
                else "resolution_timeout" if timed_out_stage == "resolution"
                else "needs_confirmation" if reviewable_candidates
                else "no_slots" if not slots
                else "no_google_match"
            )
            log_failed_link(
                user_id=sharer_id,
                url=text,
                platform=platform,
                reason=reason,
                failure_stage=(
                    "metadata" if reason.startswith("metadata_")
                    else "extraction" if reason == "no_slots"
                    else "resolution"
                ),
                flow="group",
                caption_preview=(getattr(candidate, "description", "") or "")[:300],
                error_message=pipeline.get("error"),
                request_id=task_id,
                details={
                    "metadata_source": pipeline.get("metadata_source"),
                    "slot_count": len(slots),
                    "reviewable_candidate_count": len(reviewable_candidates),
                    "unresolved_count": len(unresolved),
                },
            )
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
        created_count = 0
        existing_count = 0
        for place in places:
            save_status = await _save_and_post_group_place(
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
            created_count += save_status == "created"
            existing_count += save_status == "existing"
            if save_status is None:
                place_name = place.name if hasattr(place, "name") else place.get("name", "")
                log_failed_link(
                    user_id=sharer_id,
                    url=text,
                    platform=platform,
                    reason="save_failed",
                    failure_stage="persistence",
                    flow="group",
                    request_id=task_id,
                    details={"place_name": place_name},
                )
        if existing_count:
            await update.message.reply_text(
                f"{existing_count} place{' was' if existing_count == 1 else 's were'} already on the Group Map."
            )

    task = asyncio.create_task(_run())
    context.chat_data.setdefault("group_extraction_tasks", {})[task_id] = {
        "task": task,
        "owner_id": sharer_id,
    }
    try:
        await asyncio.wait_for(task, timeout=config.BOT_EXTRACTION_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        record_bot_event(
            sharer_id,
            "group_extraction_timed_out",
            entity_type="extraction",
            entity_id=task_id,
            metadata={"platform": platform, "timeout_seconds": config.BOT_EXTRACTION_TIMEOUT_SECONDS},
        )
        log_failed_link(
            user_id=sharer_id,
            url=text,
            platform=platform or "other",
            reason="extraction_timeout",
            failure_stage="pipeline",
            flow="group",
            error_message=f"Exceeded {config.BOT_EXTRACTION_TIMEOUT_SECONDS:g}s outer deadline",
            request_id=task_id,
            details={"timeout_seconds": config.BOT_EXTRACTION_TIMEOUT_SECONDS},
        )
        await safe_edit_status(
            status_msg,
            "I couldn't identify the place reliably before the timeout. Send the link again or share the place name.",
        )
    except asyncio.CancelledError:
        try:
            await status_msg.edit_text("Cancelled.", reply_markup=None)
        except Exception:
            pass
    except Exception as exc:
        logger.exception(
            "Group extraction failed unexpectedly: chat_id=%s user_id=%s platform=%s",
            chat.id,
            sharer_id,
            platform,
        )
        log_failed_link(
            user_id=sharer_id,
            url=text,
            platform=platform or "other",
            reason="extraction_exception",
            failure_stage="pipeline",
            flow="group",
            error_message=str(exc),
            request_id=task_id,
        )
        await safe_edit_status(
            status_msg,
            "Something went wrong while checking that link. Send it again or share the place name.",
        )
    finally:
        context.chat_data.get("group_extraction_tasks", {}).pop(task_id, None)


async def cancel_group_extraction_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cancel a group extraction only when tapped by its initiator."""
    query = update.callback_query
    try:
        _, task_id, owner_raw = query.data.split(":")
        owner_id = int(owner_raw)
    except (ValueError, IndexError):
        await query.answer("This action expired")
        return
    if update.effective_user.id != owner_id:
        await query.answer("Only the person who shared the link can cancel this.", show_alert=True)
        return
    item = context.chat_data.get("group_extraction_tasks", {}).pop(task_id, None)
    task = item.get("task") if item else None
    if task and not task.done():
        task.cancel()
        await query.answer("Cancelled")
    else:
        await query.answer("Already finished")
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:
            pass


async def grp_cancel_name_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle cancel button on the 'What's it called?' prompt."""
    query = update.callback_query
    msg_id = int(query.data.replace("grp_cancel_name_", ""))
    pending = context.chat_data.get("pending_name_requests", {}).get(msg_id)
    if pending and pending.get("sharer_user_id") != update.effective_user.id:
        await query.answer("Only the person who shared the link can cancel this.", show_alert=True)
        return
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
    group_map_url = _group_map_url(group_id)
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
