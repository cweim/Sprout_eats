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

# Google APIs
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

# Whisper
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")

# Database
DATABASE_PATH = os.getenv("DATABASE_PATH", "discovery_bot.db")
DATABASE_URL = f"sqlite:///{DATABASE_PATH}"
