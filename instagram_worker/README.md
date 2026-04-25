# Instagram Worker

This service exposes a small HTTP API for no-cookie Instagram metadata extraction.

## Run locally

From the repository root:

```bash
uvicorn instagram_worker.main:app --host 0.0.0.0 --port 8765
```

Optional auth:

```bash
export INSTAGRAM_WORKER_TOKEN=your-shared-secret
```

## Verify locally

```bash
python scripts/check_instagram_worker.py \
  --worker-url http://127.0.0.1:8765 \
  --instagram-url https://www.instagram.com/reel/C09WEZkyfys/?igsh=MWdndjZicDFiY3plNw==
```

With auth:

```bash
python scripts/check_instagram_worker.py \
  --worker-url https://your-worker-url \
  --token your-shared-secret \
  --instagram-url https://www.instagram.com/reel/C09WEZkyfys/?igsh=MWdndjZicDFiY3plNw==
```

## Main app env vars

Set these on the main app:

```bash
INSTAGRAM_EXTRACTION_BACKEND=worker
INSTAGRAM_WORKER_URL=https://your-worker-url
INSTAGRAM_WORKER_TOKEN=your-shared-secret
INSTAGRAM_NO_COOKIE_ENABLED=true
```

## Endpoints

### `GET /health`

Returns:

```json
{ "status": "ok" }
```

### `POST /extract/instagram`

Request:

```json
{ "url": "https://www.instagram.com/reel/..." }
```

Response:

```json
{
  "success": true,
  "source": "instagram_instaloader",
  "title": "",
  "description": "...",
  "uploader": "...",
  "duration": 28.566,
  "hashtags": [],
  "content_type": "video",
  "thumbnail_url": null,
  "video_url": null,
  "image_urls": [],
  "raw_fields": {},
  "error": null
}
```
