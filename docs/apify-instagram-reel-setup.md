# Apify Instagram Reel Scraper Setup Guide

This guide explains how to evaluate and wire Apify's Instagram Reel scraper into this project as a replacement for direct Instagram scraping.

## Why Apify

This repo's Instagram place extraction logic already works when it gets usable metadata.

The weak point is metadata acquisition:

- Railway direct scraping gets blocked
- a self-hosted VM worker can still get rate-limited
- Apify offloads proxying, retries, and scraper maintenance

For this project, Apify is a good next option because it can accept reel URLs and return structured metadata that can be mapped into the existing `MetadataCandidate` pipeline.

## Pricing

At the time of writing:

- Apify `Free` plan includes `$5 / month` of usage credit
- the `apify/instagram-reel-scraper` actor advertises pricing starting around `$1 / 1,000 reels`

That means if actual usage stays within `$5` of monthly spend, the effective cost is `$0`.

Important:

- the free credit resets every billing cycle
- unused credit does not roll over
- if you exceed the included credit, Apify can bill overage depending on your account setup

Official references:

- `https://apify.com/pricing`
- `https://apify.com/apify/instagram-reel-scraper`

## What You Need

1. An Apify account
2. An Apify API token
3. Access to the `apify/instagram-reel-scraper` actor
4. This repo checked out locally

## Step 1: Create an Apify Account

1. Go to `https://apify.com/`
2. Sign up
3. Confirm you are on the `Free` plan
4. Open the `apify/instagram-reel-scraper` page:
   - `https://apify.com/apify/instagram-reel-scraper`

## Step 2: Get Your API Token

1. In Apify, open account settings
2. Find `Integrations` or `API` access
3. Copy your API token

Treat this token like a secret.

Do not commit it to git.

## Step 3: Run a Manual Test in Apify

Before changing app code, confirm the actor works for your links.

In the actor UI:

1. Open `apify/instagram-reel-scraper`
2. Click `Try for free` or `Start`
3. Provide a small input with one or two reel URLs

Example input:

```json
{
  "directUrls": [
    "https://www.instagram.com/reel/DXjJ2aJE9yq/?igsh=MTlrNHQ1c3I1NzJidg==",
    "https://www.instagram.com/reel/DOfjff8EmEQ/?igsh=N2NsdWhveHBzbWV5"
  ]
}
```

Then inspect the output.

You want to confirm it returns useful fields such as:

- caption
- transcript
- hashtags
- timestamp
- duration
- video URL or thumbnail
- likes/comments if available

## Step 4: Decide the Minimum Fields This App Needs

This repo does not need every Apify field.

The existing Instagram place pipeline mostly benefits from:

- `description` or `caption`
- `uploader`
- `hashtags`
- `content_type`
- `thumbnail_url`
- `video_url`
- optional transcript text

The goal is to map Apify output into the same internal shape already used in:

- [services/public_metadata.py](/Users/chinweiming/Desktop/discovery-bot/services/public_metadata.py:1)
- [services/metadata_normalizer.py](/Users/chinweiming/Desktop/discovery-bot/services/metadata_normalizer.py:1)

## Step 5: Add Your Token Locally

Add a new env var to your local `.env`:

```bash
APIFY_API_TOKEN=your_real_apify_token
```

You may also want:

```bash
INSTAGRAM_EXTRACTION_BACKEND=apify
```

That backend switch does not exist yet in code. It is the recommended next change if Apify testing goes well.

## Step 6: Test the Actor from Python

You can either use:

- plain `requests`
- or Apify's Python client

Recommended install:

```bash
pip install apify-client
```

Minimal example:

```python
from apify_client import ApifyClient

client = ApifyClient("YOUR_APIFY_API_TOKEN")

run_input = {
    "directUrls": [
        "https://www.instagram.com/reel/DXjJ2aJE9yq/?igsh=MTlrNHQ1c3I1NzJidg=="
    ]
}

run = client.actor("apify/instagram-reel-scraper").call(run_input=run_input)

for item in client.dataset(run["defaultDatasetId"]).iterate_items():
    print(item)
```

## Step 7: Evaluate Against Your Existing Instagram Samples

Do not wire Apify into production immediately.

First test a small real sample from your corpus:

- 5 links
- then 10 links
- then 20 links if results look good

For each reel, check:

1. Does Apify return usable caption-like text?
2. Does the returned metadata contain place clues?
3. When mapped into the current pipeline, does it resolve the correct venue?

Success criteria:

- better reliability than direct Railway scraping
- better reliability than the GCP worker
- acceptable cost per month

## Step 8: Recommended Integration Design

If testing is good, implement Apify as a new backend instead of replacing the place pipeline.

Recommended shape:

1. Add new env vars:

```bash
APIFY_API_TOKEN=
INSTAGRAM_EXTRACTION_BACKEND=apify
```

2. Add a new service file:

```text
services/instagram_apify_client.py
```

3. Add a function like:

```python
async def extract_instagram_via_apify(url: str) -> MetadataCandidate:
    ...
```

4. Update:

- [services/instagram_pipeline.py](/Users/chinweiming/Desktop/discovery-bot/services/instagram_pipeline.py:1)

to support:

- `direct`
- `worker`
- `apify`

5. Keep the existing fallback UX:

- ask for place name
- or ask for screenshot

Do not change the fallback behavior unless Apify proves consistently complete.

## Step 9: Suggested Field Mapping

Map Apify output into `MetadataCandidate` roughly like this:

- `source`: `instagram_apify`
- `platform`: `instagram`
- `url`: original reel URL
- `success`: `True` if caption/media fields are present
- `title`: optional short title if Apify returns one
- `description`: caption or transcript
- `uploader`: author username
- `duration`: reel duration
- `hashtags`: extracted hashtags list
- `content_type`: `video`
- `thumbnail_url`: cover image
- `video_url`: returned video URL if available
- `raw_fields`: original Apify payload
- `error`: populated only on failure

## Step 10: Usage and Cost Monitoring

Track this monthly:

- total reels processed
- estimated actor cost
- fallback rate
- extraction success rate
- correct place resolution rate

If you want to stay inside the free plan:

- keep monthly actor usage under the included `$5`
- monitor spend in Apify dashboard
- stop or throttle if you are nearing the limit

## Step 11: Recommended Rollout

1. Manual actor test in Apify UI
2. Python API test with 5 known reels
3. Local mapping into `MetadataCandidate`
4. Local end-to-end place extraction check
5. Add `apify` backend in code
6. Deploy behind env flag
7. Test with your own Telegram bot
8. Monitor cost and success rate for 1 week

## Current Recommendation

For this repo, Apify should be evaluated as:

- a replacement for direct Instagram metadata acquisition
- not a replacement for your place extraction logic

Keep:

- `extract_place_evidence_from_metadata()`
- `resolve_place_slots()`
- screenshot / place-name fallback

Replace only the metadata acquisition layer if Apify performs better than the GCP worker.
