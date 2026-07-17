import logging
from telegram import BotCommand, MenuButtonCommands
from telegram.error import BadRequest
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ChatMemberHandler,
    ContextTypes,
    filters,
)

import config
from bot.handlers import (
    start_command,
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
    set_name_tg_callback,
    handle_dismiss,
    handle_review_callback,
    feedback_conversation_handler,
    handle_group_welcome,
    handle_group_url,
    vote_group_place_callback,
    grp_cancel_name_callback,
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


async def post_init(application):
    """Set up bot commands menu after initialization."""
    await application.bot.set_my_commands([
        BotCommand("start", "\U0001f44b Start here"),
        BotCommand("feedback", "\U0001f6e0\ufe0f Send feedback or report a bug"),
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

    # Add handlers
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CallbackQueryHandler(set_name_tg_callback, pattern="^set_name_tg$"))
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
    app.add_handler(CallbackQueryHandler(handle_dismiss, pattern=r'^dismiss$'))
    app.add_handler(CallbackQueryHandler(handle_review_callback, pattern=r'^review:'))

    # Feedback conversation handler must be before generic message handlers
    app.add_handler(feedback_conversation_handler)

    # Group map handlers
    app.add_handler(ChatMemberHandler(handle_group_welcome, ChatMemberHandler.MY_CHAT_MEMBER))
    app.add_handler(CallbackQueryHandler(grp_cancel_name_callback, pattern=r"^grp_cancel_name_"))
    app.add_handler(CallbackQueryHandler(vote_group_place_callback, pattern=r"^grp_vote_"))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND & filters.ChatType.GROUPS, handle_group_url))

    # Handle text messages (URLs and place name responses)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    app.add_error_handler(handle_bot_error)

    logger.info("\U0001f5fa\ufe0f Discovery Bot is ready!")
    app.run_polling(allowed_updates=["message", "callback_query", "my_chat_member"])


if __name__ == "__main__":
    main()
