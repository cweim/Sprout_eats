# Railway Deployment Guide

Deploy Sprout Eats on Railway as two services from the same GitHub repo:

1. `sprout-api`: FastAPI server and Mini App web UI.
2. `sprout-bot`: Telegram bot polling worker.

Do not run more than one bot worker. Telegram polling conflicts if multiple `python run.py` processes are active.

## References

- Railway FastAPI deployment guide: https://docs.railway.com/guides/fastapi
- Railway start command docs: https://docs.railway.com/guides/start-command
- Railway variables docs: https://docs.railway.com/guides/variables
- Railway public networking docs: https://docs.railway.com/deploy/exposing-your-app
- Railway services docs: https://docs.railway.com/guides/services
- Railpack package install docs: https://railpack.com/guides/installing-packages

## Prerequisites

The repo is pushed to:

```text
https://github.com/cweim/Sprout_eats.git
```

Required external services and keys:

```text
TELEGRAM_BOT_TOKEN
GOOGLE_API_KEY
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_KEY
```

Supabase schema must already be applied using:

```text
database/schema.sql
```

Google API key should be restricted to only:

```text
Places API
Maps Static API
```

## Runtime Dependencies

The app uses video/audio/OCR tooling:

```text
ffmpeg
tesseract-ocr
openai-whisper
yt-dlp
pytesseract
```

If Railway uses Railpack, set this variable on both services:

```env
RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg tesseract-ocr
```

If Railway uses Nixpacks and the Railpack variable does not work, add a `nixpacks.toml` later:

```toml
[phases.setup]
nixPkgs = ["...", "ffmpeg", "tesseract"]
```

## Step 1: Create Railway Project

1. Go to https://railway.com.
2. Sign in with GitHub.
3. Click `New Project`.
4. Choose `Deploy from GitHub repo`.
5. Select `cweim/Sprout_eats`.
6. Rename the first service to `sprout-api`.

## Step 2: Configure API Service

Open the `sprout-api` service.

Set the start command:

```bash
uvicorn api.main:app --host 0.0.0.0 --port $PORT
```

Railway public web services must listen on `0.0.0.0:$PORT`.

Add variables to `sprout-api`:

```env
TELEGRAM_BOT_TOKEN=your_rotated_bot_token
GOOGLE_API_KEY=your_restricted_google_key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_publishable_or_anon_key
SUPABASE_SERVICE_KEY=your_supabase_secret_or_service_role_key
LOCAL_DEV_AUTH=false
WHISPER_MODEL=base
RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg tesseract-ocr
```

Leave `WEBAPP_URL` empty for the first deploy, or set it later after Railway generates a domain.

Deploy `sprout-api`.

## Step 3: Generate API Public Domain

After `sprout-api` deploys:

1. Open `sprout-api`.
2. Go to `Settings`.
3. Find `Networking`.
4. Click `Generate Domain`.

Railway will create a URL like:

```text
https://sprout-api-production.up.railway.app
```

Open the URL in a browser. It should show the Mini App page.

Then set this variable on `sprout-api`:

```env
WEBAPP_URL=https://your-api-domain.up.railway.app
```

Redeploy `sprout-api`.

This matters because:

- The Telegram Mini App button uses `WEBAPP_URL`.
- FastAPI CORS uses `WEBAPP_URL`.
- The static webapp is served by the API service.

## Step 4: Create Bot Worker Service

Inside the same Railway project:

1. Click `New`.
2. Choose `GitHub Repo`.
3. Select `cweim/Sprout_eats`.
4. Rename the second service to `sprout-bot`.

Set the bot start command:

```bash
python run.py
```

Do not generate a public domain for this service. It is a background worker using Telegram polling.

Add variables to `sprout-bot`:

```env
TELEGRAM_BOT_TOKEN=your_rotated_bot_token
GOOGLE_API_KEY=your_restricted_google_key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_publishable_or_anon_key
SUPABASE_SERVICE_KEY=your_supabase_secret_or_service_role_key
WEBAPP_URL=https://your-api-domain.up.railway.app
LOCAL_DEV_AUTH=false
WHISPER_MODEL=base
RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg tesseract-ocr
```

Deploy `sprout-bot`.

## Step 5: Check Logs

For `sprout-api`, expected logs:

```text
Uvicorn running on http://0.0.0.0:$PORT
Application startup complete
```

For `sprout-bot`, expected logs:

```text
Loading Whisper model...
Whisper model ready
Bot commands menu configured
Discovery Bot is ready
```

The PTB warning about `ConversationHandler per_message=False` is non-fatal.

If you see this:

```text
Conflict: terminated by other getUpdates request
```

Then another bot instance is running. Stop your local `python run.py` and make sure Railway only has one `sprout-bot` service.

## Step 6: Configure Telegram Mini App

Open `@BotFather` in Telegram.

Set the Mini App / Web App URL to the Railway API domain:

```text
https://your-api-domain.up.railway.app
```

Make sure Railway uses the latest rotated bot token.

Test:

```text
/start
```

Tap:

```text
Open My Map
```

It should open the Railway-hosted Mini App.

## Step 7: Production Test Checklist

Test these in order:

```text
/start responds
Open My Map opens Mini App
Send Instagram reel link
Single place saves correctly
Tap "This is incorrect" deletes auto-saved place and asks for manual name
Reply with manual place name
Multiple-place reel shows checklist
Mini App loads saved places
Mark place visited
Write review
Upload review photo
Delete place
```

Test multi-user isolation:

```text
User A saves a place
User B opens Mini App
User B should not see User A's place
```

## Common Railway Issues

### App crashes because `$PORT` is missing

Use this exact API start command:

```bash
uvicorn api.main:app --host 0.0.0.0 --port $PORT
```

### Bot service gets exposed publicly

Do not generate a domain for `sprout-bot`. Only `sprout-api` needs a domain.

### Telegram conflict error

Only one bot worker can run. Stop the local bot before production testing:

```bash
pkill -f "python run.py"
```

### OCR or video processing fails

Make sure both Railway services have:

```env
RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg tesseract-ocr
```

If Railway is using Nixpacks instead of Railpack and that variable does not work, add `nixpacks.toml`:

```toml
[phases.setup]
nixPkgs = ["...", "ffmpeg", "tesseract"]
```

### Whisper is slow or memory-heavy

Set:

```env
WHISPER_MODEL=tiny
```

Use `base` only if Railway memory is stable.

### Mini App gets HTTP 401

In production, Mini App requests require Telegram `initData`.

Keep:

```env
LOCAL_DEV_AUTH=false
```

Do not test the production Mini App in a normal browser unless intentionally enabling dev auth. Do not enable dev auth in production.

## Recommended Railway Service Summary

```text
Service 1: sprout-api
Start command:
uvicorn api.main:app --host 0.0.0.0 --port $PORT
Public domain: yes

Service 2: sprout-bot
Start command:
python run.py
Public domain: no
```

Shared variables for both:

```env
TELEGRAM_BOT_TOKEN=
GOOGLE_API_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
WEBAPP_URL=https://your-api-domain.up.railway.app
LOCAL_DEV_AUTH=false
WHISPER_MODEL=base
RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg tesseract-ocr
```

Optional limits:

```env
MAX_VIDEO_DURATION=300
MAX_DOWNLOAD_SIZE_MB=100
MAX_OCR_IMAGES=10
DOWNLOAD_TIMEOUT=120
```
