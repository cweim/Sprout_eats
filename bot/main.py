import logging
from telegram import BotCommand, MenuButtonCommands
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
)

import config
from database.models import init_db
from services.transcriber import preload_model
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
    cancel_selection_callback,
    delete_place_callback,
    handle_text,
    handle_location,
    review_conversation_handler,
)

# Configure logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


async def post_init(application):
    """Set up bot commands menu after initialization."""
    await application.bot.set_my_commands([
        BotCommand("start", "👋 Start here"),
        BotCommand("viewer", "🗺️ Open my map"),
        BotCommand("nearby", "📍 Find places near me"),
    ])
    # Set the menu button to show commands instead of a web app
    await application.bot.set_chat_menu_button(menu_button=MenuButtonCommands())
    logger.info("Bot commands menu configured")


def main():
    # Initialize database
    init_db()

    # Pre-load Whisper model (takes a few seconds)
    logger.info("Loading Whisper model...")
    preload_model()
    logger.info("Whisper model ready")

    if not config.TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN not set. Please check your .env file.")
        return

    # Create application
    app = Application.builder().token(config.TELEGRAM_BOT_TOKEN).post_init(post_init).build()

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
    app.add_handler(CallbackQueryHandler(cancel_selection_callback, pattern="^cancel_selection$"))
    app.add_handler(CallbackQueryHandler(delete_place_callback, pattern="^delete_place_"))

    # Review conversation handler (must be before generic text handler)
    app.add_handler(review_conversation_handler)

    # Handle text messages (URLs and place name responses)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    # Handle location messages (for /nearby command)
    app.add_handler(MessageHandler(filters.LOCATION, handle_location))

    logger.info("🗺️ Discovery Bot is ready!")
    app.run_polling(allowed_updates=["message", "callback_query"])


if __name__ == "__main__":
    main()
