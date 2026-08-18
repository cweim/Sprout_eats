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
TELEGRAM_BOT_USERNAME = os.getenv("TELEGRAM_BOT_USERNAME", "")  # e.g. sprout_eats_bot (no @)

# Google APIs
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

# Whisper
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")

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

# Upload limits (used in API routes)
MAX_PHOTOS_PER_PLACE = int(os.getenv("MAX_PHOTOS_PER_PLACE", "10"))
MAX_PHOTO_SIZE_MB = int(os.getenv("MAX_PHOTO_SIZE_MB", "10"))
MAX_AVATAR_SIZE_MB = int(os.getenv("MAX_AVATAR_SIZE_MB", "5"))

# Instagram retrieval
INSTAGRAM_COOKIES_B64 = os.getenv("INSTAGRAM_COOKIES_B64", "")
INSTAGRAM_MAX_CONCURRENT_FETCHES = int(os.getenv("INSTAGRAM_MAX_CONCURRENT_FETCHES", "3"))
INSTAGRAM_COOLDOWN_SECONDS = int(os.getenv("INSTAGRAM_COOLDOWN_SECONDS", "300"))

# Instagram no-cookie extraction
INSTAGRAM_NO_COOKIE_ENABLED = os.getenv("INSTAGRAM_NO_COOKIE_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
INSTAGRAM_NO_COOKIE_CONCURRENCY = int(os.getenv("INSTAGRAM_NO_COOKIE_CONCURRENCY", "2"))
INSTAGRAM_NO_COOKIE_TIMEOUT_SECONDS = int(os.getenv("INSTAGRAM_NO_COOKIE_TIMEOUT_SECONDS", "15"))
INSTAGRAM_NO_COOKIE_RETRY_DELAY_SECONDS = int(os.getenv("INSTAGRAM_NO_COOKIE_RETRY_DELAY_SECONDS", "8"))
INSTAGRAM_NO_COOKIE_COOLDOWN_SECONDS = int(os.getenv("INSTAGRAM_NO_COOKIE_COOLDOWN_SECONDS", "600"))
INSTAGRAM_EXTRACTION_BACKEND = os.getenv("INSTAGRAM_EXTRACTION_BACKEND", "direct").strip().lower()
INSTAGRAM_WORKER_URL = os.getenv("INSTAGRAM_WORKER_URL", "").strip()
INSTAGRAM_WORKER_TOKEN = os.getenv("INSTAGRAM_WORKER_TOKEN", "").strip()
APIFY_API_TOKEN = os.getenv("APIFY_API_TOKEN", "").strip()
APIFY_ACTOR_ID = os.getenv("APIFY_ACTOR_ID", "apify/instagram-reel-scraper").strip()
APIFY_RUN_TIMEOUT_SECONDS = float(os.getenv("APIFY_RUN_TIMEOUT_SECONDS", "90"))
APIFY_POLL_INTERVAL_SECONDS = float(os.getenv("APIFY_POLL_INTERVAL_SECONDS", "2"))
INSTAGRAM_METADATA_CACHE_TTL_SECONDS = int(os.getenv("INSTAGRAM_METADATA_CACHE_TTL_SECONDS", "604800"))
INSTAGRAM_METADATA_CACHE_MAX_ENTRIES = int(os.getenv("INSTAGRAM_METADATA_CACHE_MAX_ENTRIES", "512"))

# Telegram capture pipeline deadlines. These bound the full user-visible wait while
# still allowing completed place lookups to be shown when another lookup times out.
BOT_EXTRACTION_TIMEOUT_SECONDS = float(os.getenv("BOT_EXTRACTION_TIMEOUT_SECONDS", "120"))
BOT_METADATA_TIMEOUT_SECONDS = float(os.getenv("BOT_METADATA_TIMEOUT_SECONDS", "95"))
BOT_PLACE_RESOLUTION_TIMEOUT_SECONDS = float(os.getenv("BOT_PLACE_RESOLUTION_TIMEOUT_SECONDS", "15"))
BOT_PLACE_RESOLUTION_CONCURRENCY = int(os.getenv("BOT_PLACE_RESOLUTION_CONCURRENCY", "3"))
BOT_METADATA_PROGRESS_SECONDS = float(os.getenv("BOT_METADATA_PROGRESS_SECONDS", "15"))
BOT_METADATA_STILL_WORKING_SECONDS = float(os.getenv("BOT_METADATA_STILL_WORKING_SECONDS", "45"))

# Place extraction LLM fallback (Claude Haiku) — off by default due to cost
ENABLE_LLM_PLACE_FALLBACK: bool = os.getenv("ENABLE_LLM_PLACE_FALLBACK", "false").lower() in {"1", "true", "yes", "on"}

# Reminder job
REMINDER_JOB_INTERVAL_MINUTES = int(os.getenv("REMINDER_JOB_INTERVAL_MINUTES", "5"))
REMINDER_JOB_STARTUP_DELAY_SECONDS = int(os.getenv("REMINDER_JOB_STARTUP_DELAY_SECONDS", "30"))
REMINDER_CHECK_HOURS = int(os.getenv("REMINDER_CHECK_HOURS", "1"))
REMINDER_PLACE_NAME_MAX_LENGTH = int(os.getenv("REMINDER_PLACE_NAME_MAX_LENGTH", "50"))

# Startup validation — warn loudly if critical vars are missing
import logging as _logging
_startup_logger = _logging.getLogger(__name__)
_missing = [name for name, val in [
    ("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN),
    ("SUPABASE_URL", SUPABASE_URL),
    ("SUPABASE_SERVICE_KEY", SUPABASE_SERVICE_KEY),
    ("GOOGLE_API_KEY", GOOGLE_API_KEY),
] if not val]
if _missing:
    _startup_logger.warning(
        "STARTUP WARNING: Missing required environment variables: %s. "
        "The app may fail at runtime.",
        ", ".join(_missing)
    )
