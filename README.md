# Discovery Bot

A Telegram bot that extracts and saves places from Instagram and TikTok travel videos.

## Overview

When browsing social media, you discover interesting places in travel videos—cafes, restaurants, attractions—but by the time you're ready to visit, you've lost track of them.

Discovery Bot solves this: send a video link, and it automatically extracts mentioned places, saves them with location pins, and lets you browse them on an interactive map.

### Features

- **Video Processing**: Send Instagram or TikTok URLs, bot downloads and extracts audio
- **Smart Transcription**: Whisper AI transcribes audio with language detection
- **Place Search**: Google Places API finds mentioned locations with ratings, photos, hours
- **Multi-Place Support**: Extract and save multiple places from a single video
- **Interactive Viewer**: Mini App with map view, list view, search, and filtering
- **Proximity Alerts**: Get notified when you're near saved places
- **Personal Notes**: Mark places as visited and add your own notes

## Requirements

- **Python 3.10+**
- **FFmpeg** (for audio extraction from videos)
- **Telegram Bot Token** (from [@BotFather](https://t.me/BotFather))
- **Google Cloud API Key** with:
  - Places API (New) enabled
  - Maps Static API enabled

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/discovery-bot.git
cd discovery-bot

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

### Install FFmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt update && sudo apt install ffmpeg
```

**Windows:**
Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH.

## Configuration

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Edit `.env` with your values:

| Variable | Description | Required |
|----------|-------------|----------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | Yes |
| `GOOGLE_API_KEY` | Google Cloud API key | Yes |
| `WHISPER_MODEL` | Whisper model size: `tiny`, `base`, `small`, `medium`, `large` | No (default: `base`) |
| `DATABASE_PATH` | SQLite database file path | No (default: `discovery_bot.db`) |
| `WEBAPP_URL` | URL where Mini App is hosted (for interactive viewer) | No |

### Getting API Keys

**Telegram Bot Token:**
1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the token provided

**Google Cloud API Key:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable "Places API (New)" and "Maps Static API"
4. Go to Credentials → Create API Key
5. (Recommended) Restrict the key to only these APIs

## Usage

### Running the Bot

```bash
python run.py
```

On startup, you'll see:
```
Loading Whisper model...
Whisper model ready
Starting Discovery Bot...
```

The bot is now running and listening for messages.

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show welcome message and menu |
| `/places` | List all saved places |
| `/nearby` | Find saved places near your location |
| `/map` | View all places on a static map |
| `/delete` | Delete a saved place |
| `/clear` | Clear all saved places |

### How It Works

1. **Send a video link** — Paste an Instagram or TikTok URL
2. **Bot downloads** — Extracts video and audio using yt-dlp
3. **Transcription** — Whisper AI transcribes the audio, detecting language
4. **Place search** — Google Places API searches for mentioned locations
5. **Select places** — Choose which places to save (if multiple found)
6. **Saved!** — Places are stored with coordinates, ratings, photos, and more

### Mini App Viewer

The interactive Mini App lets you browse saved places on a map with search, filtering, and notes.

**Setting up the Mini App:**

1. **Start the API server:**
```bash
uvicorn api.main:app --reload --port 8000
```

2. **For local development:**
   - Use ngrok or similar to expose your local server
   - Set `WEBAPP_URL` in `.env` to your public URL

3. **For production:**
   - Deploy the API server (FastAPI) to your hosting provider
   - Serve `webapp/` files from a static host or CDN
   - Configure `WEBAPP_URL` with your deployed URL

4. **Configure in BotFather:**
   - Message @BotFather → `/mybots` → Select your bot
   - Bot Settings → Menu Button → Configure menu button
   - Enter your Mini App URL

**Mini App Features:**
- Map view with place markers and popups
- List view with search and filtering
- Sort by newest, name, rating, or distance
- Mark places as visited
- Add personal notes
- "Open in Google Maps" links
- "Open original reel" links

## Development

### Project Structure

```
discovery-bot/
├── bot/                 # Telegram bot handlers
│   ├── main.py          # Bot entry point and handler setup
│   └── handlers.py      # Command and message handlers
├── services/            # Core services
│   ├── downloader.py    # Video download with yt-dlp
│   ├── transcriber.py   # Whisper transcription
│   ├── places.py        # Google Places API
│   └── maps.py          # Static map generation
├── database/            # Data layer
│   ├── models.py        # SQLAlchemy models
│   └── repository.py    # CRUD operations
├── api/                 # Mini App backend
│   ├── server.py        # FastAPI app
│   └── routes.py        # API endpoints
├── webapp/              # Mini App frontend
│   ├── index.html       # Single page app
│   ├── styles.css       # Styling
│   └── app.js           # Frontend logic
├── tests/               # Test suite
├── config.py            # Configuration
├── run.py               # Entry point
└── requirements.txt     # Dependencies
```

### Running Tests

```bash
# Install dev dependencies
pip install pytest pytest-asyncio

# Run all tests
pytest

# Run with verbose output
pytest -v
```

## License

MIT
