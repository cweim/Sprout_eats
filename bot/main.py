import logging
from datetime import timedelta
from telegram import BotCommand, MenuButtonCommands, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import BadRequest
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters,
)

import config
from database import supabase_repository as repository
from bot.handlers import (
    start_command,
    places_command,
    map_command,
    viewer_command,
    clear_command,
    delete_command,
    nearby_command,
    clear_callback,
    action_callback,
    toggle_place_callback,
    save_selected_callback,
    save_all_callback,
    cancel_selection_callback,
    incorrect_place_callback,
    correction_pick_callback,
    delete_place_callback,
    unresolved_pick_callback,
    cancel_extraction_callback,
    handle_text,
    handle_location,
    handle_remind_later,
    handle_remind_stop,
    handle_dismiss,
    handle_review_callback,
    feedback_conversation_handler,
)

# Configure logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)


async def handle_bot_error(update, context: ContextTypes.DEFAULT_TYPE):
    """Log expected Telegram API issues compactly and preserve stack traces for real errors."""
    error = context.error
    if isinstance(error, BadRequest):
        message = str(error).lower()
        if "query is too old" in message or "query id is invalid" in message:
            logger.info("Ignoring stale callback query error: %s", error)
            return
        if "message is not modified" in message:
            logger.info("Ignoring no-op message edit error: %s", error)
            return

    logger.error(
        "Unhandled bot error",
        exc_info=(type(error), error, error.__traceback__) if error else True,
    )


async def check_review_reminders(context: ContextTypes.DEFAULT_TYPE):
    """Background job to send review reminders."""
    logger.info("Checking for pending review reminders...")

    # Get reminders that are at least 1 hour old and not sent
    pending = repository.get_pending_reminders(since_hours=config.REMINDER_CHECK_HOURS)

    for reminder in pending:
        try:
            user_id = reminder['user_id']
            place_id = reminder['place_id']
            reminder_id = reminder['id']

            # Get place name
            place = repository.get_place_by_id(user_id, place_id)
            if not place:
                continue

            # Check if user already wrote a review
            existing_review = repository.get_review(user_id, place_id)
            if existing_review:
                repository.mark_reminder_sent(reminder_id)
                continue

            # Send reminder message
            review_btn_row = []
            if config.WEBAPP_URL:
                from telegram import WebAppInfo
                review_btn_row = [InlineKeyboardButton(
                    "⭐ Write Review →",
                    web_app=WebAppInfo(url=f"{config.WEBAPP_URL}?startapp=review_{place_id}")
                )]
            keyboard_rows = []
            if review_btn_row:
                keyboard_rows.append(review_btn_row)
            keyboard_rows.append([
                InlineKeyboardButton("Ask Later", callback_data=f"remind_later:{reminder_id}"),
                InlineKeyboardButton("Don't Ask", callback_data=f"remind_stop:{place_id}"),
            ])
            keyboard = InlineKeyboardMarkup(keyboard_rows)

            await context.bot.send_message(
                chat_id=user_id,
                text=f"Hey! How was *{place['name']}*? 🍜\n\nWrite your review while it's fresh.",
                parse_mode='Markdown',
                reply_markup=keyboard
            )

            repository.mark_reminder_sent(reminder_id)
            logger.info(f"Sent review reminder for place {place_id} to user {user_id}")

        except Exception as e:
            logger.error(f"Failed to send reminder {reminder['id']}: {e}")

    logger.info(f"Processed {len(pending)} reminders")

    # Piggyback: clean up expired bot sessions
    try:
        deleted = repository.cleanup_expired_bot_sessions()
        if deleted:
            logger.info(f"Cleaned up {deleted} expired bot sessions")
    except Exception as e:
        logger.warning(f"Bot session cleanup failed: {e}")


def setup_reminder_job(application):
    """Set up the reminder check job to run every 5 minutes."""
    job_queue = application.job_queue
    if job_queue is None:
        logger.warning(
            "JobQueue is unavailable. Review reminders are disabled. "
            "Install python-telegram-bot with the job-queue extra."
        )
        return False

    # Run every 5 minutes
    job_queue.run_repeating(
        check_review_reminders,
        interval=timedelta(minutes=config.REMINDER_JOB_INTERVAL_MINUTES),
        first=timedelta(seconds=config.REMINDER_JOB_STARTUP_DELAY_SECONDS),
        name='review_reminders'
    )
    logger.info("Review reminder job scheduled")
    return True


async def post_init(application):
    """Set up bot commands menu after initialization."""
    await application.bot.set_my_commands([
        BotCommand("start", "👋 Start here"),
        BotCommand("viewer", "🗺️ Open my map"),
        BotCommand("nearby", "📍 Find places near me"),
        BotCommand("feedback", "🛠️ Send feedback or report a bug"),
    ])
    # Set the menu button to show commands instead of a web app
    await application.bot.set_chat_menu_button(menu_button=MenuButtonCommands())
    logger.info("Bot commands menu configured")


def _validate_config() -> bool:
    """Fail fast if required environment variables are missing."""
    required = {
        "TELEGRAM_BOT_TOKEN": config.TELEGRAM_BOT_TOKEN,
        "GOOGLE_API_KEY": config.GOOGLE_API_KEY,
        "SUPABASE_URL": config.SUPABASE_URL,
        "SUPABASE_SERVICE_KEY": config.SUPABASE_SERVICE_KEY,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        for name in missing:
            logger.error("Required config missing: %s", name)
        return False
    return True


def main():
    if not _validate_config():
        return

    # Create application
    app = (
        Application.builder()
        .token(config.TELEGRAM_BOT_TOKEN)
        .post_init(post_init)
        .concurrent_updates(True)
        .build()
    )

    # Set up reminder job
    setup_reminder_job(app)

    # Add handlers
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("places", places_command))
    app.add_handler(CommandHandler("map", map_command))
    app.add_handler(CommandHandler("viewer", viewer_command))
    app.add_handler(CommandHandler("clear", clear_command))
    app.add_handler(CommandHandler("delete", delete_command))
    app.add_handler(CommandHandler("nearby", nearby_command))
    app.add_handler(CallbackQueryHandler(clear_callback, pattern="^clear_"))
    app.add_handler(CallbackQueryHandler(action_callback, pattern="^action_"))
    app.add_handler(CallbackQueryHandler(toggle_place_callback, pattern="^toggle_place_"))
    app.add_handler(CallbackQueryHandler(save_selected_callback, pattern="^save_selected$"))
    app.add_handler(CallbackQueryHandler(save_all_callback, pattern="^save_all$"))
    app.add_handler(CallbackQueryHandler(cancel_selection_callback, pattern="^cancel_selection$"))
    app.add_handler(CallbackQueryHandler(incorrect_place_callback, pattern="^incorrect_place_"))
    app.add_handler(CallbackQueryHandler(correction_pick_callback, pattern="^correction_pick_"))
    app.add_handler(CallbackQueryHandler(delete_place_callback, pattern="^delete_place_"))
    app.add_handler(CallbackQueryHandler(unresolved_pick_callback, pattern="^unresolved_pick_"))
    app.add_handler(CallbackQueryHandler(cancel_extraction_callback, pattern="^cancel_extraction_"))

    # Reminder callback handlers
    app.add_handler(CallbackQueryHandler(handle_remind_later, pattern=r'^remind_later:'))
    app.add_handler(CallbackQueryHandler(handle_remind_stop, pattern=r'^remind_stop:'))
    app.add_handler(CallbackQueryHandler(handle_dismiss, pattern=r'^dismiss$'))
    app.add_handler(CallbackQueryHandler(handle_review_callback, pattern=r'^review:'))

    # Feedback conversation handler must be before generic message handlers
    app.add_handler(feedback_conversation_handler)

    # Handle text messages (URLs and place name responses)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    # Handle location messages (for /nearby command)
    app.add_handler(MessageHandler(filters.LOCATION, handle_location))
    app.add_error_handler(handle_bot_error)

    logger.info("🗺️ Discovery Bot is ready!")
    app.run_polling(allowed_updates=["message", "callback_query"])


if __name__ == "__main__":
    main()
