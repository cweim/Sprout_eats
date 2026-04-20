# Manual Deployment Guide

Steps that require manual action in external dashboards/consoles.

---

## 0. Key Rotation (If Exposed)

If your keys were committed to git or exposed publicly, rotate them immediately in this order:

### Priority 1: GOOGLE_API_KEY ($$$ risk)

Exposed key = anyone can run up your Google Cloud bill.

1. Go to [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. Find your API key → click the 3-dot menu → **Regenerate key**
3. Copy new key
4. Update `.env`: `GOOGLE_API_KEY=new_key_here`
5. Restart API and bot
6. **Also apply restrictions** (see Section 1 below)

### Priority 2: SUPABASE_SERVICE_KEY (data risk)

Service key = full database access, bypass RLS.

1. Go to [Supabase Dashboard](https://supabase.com/dashboard) → your project
2. **Settings > API**
3. Under "Service role key" → click **Generate new key**
4. Copy new key
5. Update `.env`: `SUPABASE_SERVICE_KEY=new_key_here`
6. Restart API and bot

### Priority 3: SUPABASE_ANON_KEY (lower risk)

Anon key is public-facing, but rotating is still good practice.

1. Same location: **Settings > API**
2. Under "anon public" → **Generate new key**
3. Update `.env`: `SUPABASE_ANON_KEY=new_key_here`
4. Restart API and bot

### Priority 4: TELEGRAM_BOT_TOKEN (bot hijack risk)

Exposed token = someone can control your bot.

1. Open Telegram → [@BotFather](https://t.me/BotFather)
2. Send `/revoke`
3. Select your bot
4. Copy new token
5. Update `.env`: `TELEGRAM_BOT_TOKEN=new_token_here`
6. Restart bot

### After Rotation

```bash
# Verify .env is in .gitignore
grep -q "^\.env$" .gitignore && echo "OK: .env is ignored" || echo "WARNING: Add .env to .gitignore!"

# Check git history for exposed secrets
git log --all --full-history -- .env
# If found, consider using BFG Repo-Cleaner or git filter-branch
```

---

## 1. Google API Key Restrictions

Prevent abuse and unexpected billing.

### Steps

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Click your API key
3. Under **API restrictions**:
   - Select "Restrict key"
   - Enable only:
     - Places API
     - Maps Static API
4. Under **Application restrictions** (optional):
   - For API server: "IP addresses" → add your server IP
   - For web: "HTTP referrers" → add your `WEBAPP_URL`
5. Click **Save**

### Monitor Spend

1. Go to [APIs & Services > Dashboard](https://console.cloud.google.com/apis/dashboard)
2. Click "Places API"
3. Check "Quotas" tab
4. Set up billing alerts in [Billing > Budgets & alerts](https://console.cloud.google.com/billing)

---

## 2. Supabase Backups

### Enable Point-in-Time Recovery (Pro plan)

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project
3. Go to **Settings > Database**
4. Under "Backups", enable PITR if on Pro plan

### Manual Backup (Free plan)

1. Go to **Database > Backups**
2. Click "Create backup" periodically
3. Download and store securely

### Export Data

```sql
-- Run in SQL Editor to export places
COPY (SELECT * FROM places) TO STDOUT WITH CSV HEADER;
```

---

## 3. Deployment Architecture

Run API and Bot as separate processes.

### Option A: Two Terminal Sessions (Dev)

```bash
# Terminal 1 - API
uvicorn api.main:app --host 0.0.0.0 --port 8000

# Terminal 2 - Bot
python run.py
```

### Option B: Docker Compose (Production)

```yaml
# docker-compose.yml
version: '3.8'
services:
  api:
    build: .
    command: uvicorn api.main:app --host 0.0.0.0 --port 8000
    ports:
      - "8000:8000"
    env_file: .env

  bot:
    build: .
    command: python run.py
    env_file: .env
    deploy:
      replicas: 1  # Only ONE bot instance!
```

### Option C: Systemd Services (Linux VPS)

```ini
# /etc/systemd/system/discovery-api.service
[Unit]
Description=Discovery Bot API
After=network.target

[Service]
User=www-data
WorkingDirectory=/opt/discovery-bot
ExecStart=/opt/discovery-bot/venv/bin/uvicorn api.main:app --host 0.0.0.0 --port 8000
Restart=always
EnvironmentFile=/opt/discovery-bot/.env

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/discovery-bot.service
[Unit]
Description=Discovery Bot Telegram Worker
After=network.target

[Service]
User=www-data
WorkingDirectory=/opt/discovery-bot
ExecStart=/opt/discovery-bot/venv/bin/python run.py
Restart=always
EnvironmentFile=/opt/discovery-bot/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable discovery-api discovery-bot
sudo systemctl start discovery-api discovery-bot
```

### Important: Single Bot Instance

Telegram polling conflicts if multiple bot instances run. Ensure:
- Only ONE `python run.py` process
- Use `replicas: 1` in Docker/K8s
- Don't run bot in dev while production is active

---

## 4. Environment Variables Checklist

Create `.env` from `.env.example`:

```bash
# Required
TELEGRAM_BOT_TOKEN=your_bot_token
GOOGLE_API_KEY=your_restricted_key
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...
WEBAPP_URL=https://your-deployed-api.com

# Production settings
LOCAL_DEV_AUTH=false
WHISPER_MODEL=base

# Limits (optional, defaults shown)
MAX_VIDEO_DURATION=300
MAX_DOWNLOAD_SIZE_MB=100
MAX_OCR_IMAGES=10
DOWNLOAD_TIMEOUT=120
```

---

## 5. Pre-Launch Testing Checklist

### Multi-User Isolation

1. Get two Telegram accounts
2. Both send `/start` to bot
3. User A saves a place
4. User B opens Mini App → should NOT see User A's place
5. User B saves a place
6. User A runs `/places` → should only see their own

### Feature Tests

| Test | Steps |
|------|-------|
| Instagram Reel | Send reel link → place extracted & saved |
| TikTok | Send TikTok link → place extracted & saved |
| Instagram Carousel | Send carousel → OCR extracts text |
| Discover Places | Open Mini App → search → add place |
| Mark Visited | Open Mini App → toggle visited |
| Write Review | Mark visited → add review with photos |
| Delete Place | `/delete` or Mini App → remove place |
| Clear All | `/clear` → only clears YOUR places |
| Nearby | `/nearby` → share location → see YOUR nearest |

### Bot Restart Test

1. Stop bot process
2. Start bot process
3. Send `/start` → should respond normally
4. Check no "Conflict: terminated by other getUpdates" error

---

## 6. Uptime Monitoring (Optional)

### Health Check Endpoint

```
GET https://your-api.com/api/health
Response: {"status": "ok"}
```

### Free Monitoring Options

- [UptimeRobot](https://uptimerobot.com) - 5 min checks, free tier
- [Freshping](https://freshping.io) - 1 min checks, free tier
- [Healthchecks.io](https://healthchecks.io) - cron job monitoring

### Setup

1. Create account
2. Add monitor for `https://your-api.com/api/health`
3. Set alert (email/Telegram) for downtime

---

## 7. Future Improvements

Not blocking launch, but consider later:

- [ ] Rate limiting with `slowapi`
- [ ] Background job queue for video processing (Celery/RQ)
- [ ] Per-user daily limits on Google API calls
- [ ] Delete account / export data flow (GDPR)
- [ ] Error tracking (Sentry)
- [ ] Telegram webhook mode instead of polling
