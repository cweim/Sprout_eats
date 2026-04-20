# Instagram Metadata Dataset

This folder contains raw and normalized metadata extracted from the Instagram links in `../ig_links.md`.

The dataset is for place-extraction pipeline research. It does not represent the bot's suggestions and does not call Google Places.

## Files

- `instagram_metadata_dataset.json`: pretty JSON array with one normalized record per link.
- `instagram_metadata_dataset.jsonl`: compact JSONL version with one record per line.
- `instagram_metadata_with_media.json`: enriched JSON array including opt-in OCR/transcription evidence.
- `instagram_metadata_with_media.jsonl`: compact JSONL version of the enriched dataset.
- `metadata_extraction_plan.md`: extraction design and schema goals.
- `scripts/extract_instagram_metadata.py`: repeatable extraction script.
- `raw/{shortcode}.yt_dlp.json`: sanitized raw `yt-dlp` metadata snapshot.
- `raw/{shortcode}.html`: public Instagram HTML snapshot.
- `media_evidence/{shortcode}.media_evidence.json`: per-link OCR/transcription evidence snapshots.

## Current Run Summary

- Records: 14
- Status: 14 `ok`, 0 `partial`, 0 `failed`
- Average total extraction time: 1.809 seconds per link
- Slowest link: `DEAN_ZMyAtl`, 2.601 seconds
- Detected content types: 11 `video`, 3 `image_or_carousel`
- Raw snapshot files: 28

## Current Media Evidence Run Summary

The enriched media run was generated with:

```bash
python place-extraction-pipeline/metadata_dataset/scripts/extract_instagram_metadata.py \
  --include-media-evidence \
  --output-json place-extraction-pipeline/metadata_dataset/instagram_metadata_with_media.json \
  --output-jsonl place-extraction-pipeline/metadata_dataset/instagram_metadata_with_media.jsonl
```

Summary:

- Records: 14
- Status: 14 `ok`, 0 `partial`, 0 `failed`
- Average total extraction time: 14.488 seconds per link
- Average media evidence time: 12.479 seconds per link
- Slowest link: `DEAN_ZMyAtl`, 40.14 seconds
- Transcriptions captured: 11
- Transcript languages detected: `en`, `ko`, `ms`
- OCR records with text: 0
- Downloaded image files: 0

OCR produced no text in this run because the unauthenticated Instagram image/carousel download path did not retrieve actual carousel image files. The public HTML still exposes some cover/preview image URLs in `html_metadata`, but those were not downloaded for OCR in the current media evidence stage.

## Carousel Auth Notes

These links likely require authenticated Instagram access to extract full carousel media entries:

- `DS3v8C4j8dg`
- `DPyhLE4kqmp`
- `DQwiEYlEgft`

Public metadata exposes captions for these posts, but `yt-dlp` reports playlist-style posts with zero entries.

## Record Shape

Each record contains:

- `input`: original URL, shortcode, inferred URL type.
- `yt_dlp_core`: title, caption/description, uploader, channel, duration, timestamp, likes/comments when exposed, raw available key list.
- `yt_dlp_media`: format counts, thumbnail info, resolution, codec and media availability flags.
- `yt_dlp_social`: public comments sample when exposed.
- `yt_dlp_carousel`: carousel/playlist entry summary when exposed.
- `html_metadata`: public HTML diagnostics, OpenGraph/Twitter/meta tags, image URL samples.
- `derived`: caption-derived signals such as hashtags, mentions, pin lines, bracketed names, address-like snippets and inferred content type.
- `availability`: booleans for what data was actually available.
- `timings`: extraction duration per stage and total duration.
- `errors`: per-stage errors, if any.

## Regenerate

From the repository root:

```bash
python place-extraction-pipeline/metadata_dataset/scripts/extract_instagram_metadata.py
```

To test only the first link:

```bash
python place-extraction-pipeline/metadata_dataset/scripts/extract_instagram_metadata.py --limit 1
```

Warning: running with `--limit 1` writes over the default output files unless you provide custom `--output-json` and `--output-jsonl` paths.

To include OCR/transcription evidence:

```bash
python place-extraction-pipeline/metadata_dataset/scripts/extract_instagram_metadata.py \
  --include-media-evidence \
  --output-json place-extraction-pipeline/metadata_dataset/instagram_metadata_with_media.json \
  --output-jsonl place-extraction-pipeline/metadata_dataset/instagram_metadata_with_media.jsonl
```

This downloads media temporarily, runs Tesseract OCR for downloaded images, runs Whisper transcription for downloaded audio, stores the extracted text in the output dataset, and then deletes the temporary media files.
