# Instagram Metadata Extraction Plan

This dataset is a raw evidence dataset for refining the place extraction pipeline. It is intentionally separate from the bot runtime and from the ground-truth place dataset.

## Goal

For every Instagram URL in `../ig_links.md`, extract all metadata that can be collected without saving the post into the app database:

- `yt-dlp` metadata
- public HTML/OpenGraph metadata
- available media/image URL signals
- derived caption signals useful for place extraction
- extraction timing per URL and per stage
- errors per stage

## Output Files

- `instagram_metadata_dataset.json`: pretty consolidated JSON array.
- `instagram_metadata_dataset.jsonl`: one compact JSON record per URL.
- `raw/{shortcode}.yt_dlp.json`: raw `yt-dlp` extraction result, sanitized to avoid huge direct media URLs.
- `raw/{shortcode}.html`: public HTML snapshot if fetch succeeds.
- `scripts/extract_instagram_metadata.py`: repeatable extraction script.

## Stages

1. `yt_dlp_metadata`
   - Runs `yt_dlp.YoutubeDL(...).extract_info(url, download=False)`.
   - Captures core post fields, media fields, counts, comments if exposed, carousel entries if exposed, and available raw keys.

2. `html_metadata`
   - Fetches the public Instagram page with browser-like headers.
   - Extracts OpenGraph, Twitter, and standard meta tags.
   - Extracts public CDN image URLs from the HTML.

3. `derived_processing`
   - Uses caption/title/html text to derive useful place-extraction clues:
     - hashtags
     - account mentions
     - location pin lines
     - bracketed names
     - address-like snippets
     - caption length
     - inferred URL type
     - inferred content type

## Timing

Each record stores:

```json
"timings": {
  "yt_dlp_metadata_seconds": 2.31,
  "html_metadata_seconds": 0.74,
  "derived_processing_seconds": 0.02,
  "total_seconds": 3.07
}
```

## Status

Each record has:

- `ok`: all major stages succeeded.
- `partial`: at least one major stage failed, but some metadata was collected.
- `failed`: no useful metadata was collected.

Stage errors are stored under `errors`.

## Non-Goals

This script does not:

- call Google Places
- save places
- decide ground truth

By default, it also does not:

- run OCR
- transcribe audio
- download full videos

Those slower media-derived stages are available only when `--include-media-evidence` is passed.
