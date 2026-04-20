import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Base paths
BASE_DIR = Path(__file__).parent
TEMP_DIR = BASE_DIR / "temp"
TEMP_DIR.mkdir(exist_ok=True)

# Telegram
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")  # For single-user bot, your Telegram user ID

# Google APIs
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

# Whisper
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")

# Database (SQLite - legacy, kept for migration)
DATABASE_PATH = os.getenv("DATABASE_PATH", "discovery_bot.db")
DATABASE_URL = f"sqlite:///{DATABASE_PATH}"

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

# Local development auth fallback for opening the Mini App in a normal browser.
# Keep disabled in production. When enabled, requests without Telegram initData
# are treated as DEV_TELEGRAM_USER_ID, or TELEGRAM_CHAT_ID if set.
LOCAL_DEV_AUTH = os.getenv("LOCAL_DEV_AUTH", "false").lower() in {"1", "true", "yes", "on"}
DEV_TELEGRAM_USER_ID = os.getenv("DEV_TELEGRAM_USER_ID") or TELEGRAM_CHAT_ID

# Mini App
WEBAPP_URL = os.getenv("WEBAPP_URL", "")

# Production limits
MAX_VIDEO_DURATION = int(os.getenv("MAX_VIDEO_DURATION", "300"))  # 5 min default
MAX_DOWNLOAD_SIZE_MB = int(os.getenv("MAX_DOWNLOAD_SIZE_MB", "100"))  # 100MB default
MAX_OCR_IMAGES = int(os.getenv("MAX_OCR_IMAGES", "10"))  # Max carousel images to OCR
DOWNLOAD_TIMEOUT = int(os.getenv("DOWNLOAD_TIMEOUT", "120"))  # 2 min default
