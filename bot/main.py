import logging
from telegram import BotCommand
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
)

import config
from database.models import init_db
from bot.handlers import (
    start_command,
    places_command,
    map_command,
    clear_command,
    delete_command,
    clear_callback,
    action_callback,
    select_place_callback,
    delete_place_callback,
    handle_text,
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
        BotCommand("start", "Show welcome message"),
        BotCommand("places", "List all saved places"),
        BotCommand("map", "View all places on a map"),
        BotCommand("delete", "Delete a saved place"),
        BotCommand("clear", "Clear all saved places"),
    ])
    logger.info("Bot commands menu configured")


def main():
    # Initialize database
    init_db()

    if not config.TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN not set. Please check your .env file.")
        return

    # Create application
    app = Application.builder().token(config.TELEGRAM_BOT_TOKEN).post_init(post_init).build()

    # Add handlers
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("places", places_command))
    app.add_handler(CommandHandler("map", map_command))
    app.add_handler(CommandHandler("clear", clear_command))
    app.add_handler(CommandHandler("delete", delete_command))
    app.add_handler(CallbackQueryHandler(clear_callback, pattern="^clear_"))
    app.add_handler(CallbackQueryHandler(action_callback, pattern="^action_"))
    app.add_handler(CallbackQueryHandler(select_place_callback, pattern="^select_place_"))
    app.add_handler(CallbackQueryHandler(delete_place_callback, pattern="^delete_place_"))

    # Handle text messages (URLs and place name responses)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    logger.info("Starting Discovery Bot...")
    app.run_polling(allowed_updates=["message", "callback_query"])


if __name__ == "__main__":
    main()
