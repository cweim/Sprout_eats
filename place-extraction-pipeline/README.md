# Place Extraction Pipeline

This document describes the current code path from receiving an Instagram or TikTok link to suggesting places to the user. The purpose of this folder is to make the extraction pipeline easier to inspect and refine.

## Entry Point

Telegram text messages are handled in `bot/main.py` by the generic text message handler:

```text
MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text)
```

`handle_text()` in `bot/handlers.py` checks whether the message is a supported Instagram or TikTok URL.

If it is a valid URL:

1. Clear any pending manual-search state.
2. Call `handle_url(update, context)`.

Supported platforms are detected in `services/downloader.py`:

```text
instagram.com
instagr.am
tiktok.com
vm.tiktok.com
```

Everything else is ignored by the URL pipeline.

## High-Level Flow

Current order:

1. Receive IG/TikTok link.
2. Download/extract metadata with `yt-dlp`.
3. Detect whether the post is video, image, carousel, or mixed.
4. Search caption/title first.
5. If caption/title finds at least one place, stop extraction and suggest those places.
6. If no caption/title result and images exist, OCR images and search metadata plus OCR text.
7. If still no result and audio exists, transcribe audio with Whisper and search the transcript.
8. If places are found, either auto-save one place or show a multi-place selection UI.
9. If no places are found, ask the user to reply with the place name manually.

Important behavior: the code does not currently combine caption, OCR, and transcript results when caption already succeeds. It short-circuits at the first source that returns at least one place.

## Download And Media Detection

Implemented in `services/downloader.py`.

`download_content(url)` first calls `yt-dlp` with `download=False` to extract metadata:

```text
title
description
uploader
duration
tags
entries
thumbnail data
```

Then `_detect_content_type(info, url)` classifies the content:

```text
video
image
carousel
mixed
```

Detection rules:

1. If the metadata has entries, each entry is checked with `_is_video_info()`.
2. If all entries are video-like, content type is `video`.
3. If all entries are image-like, content type is `carousel`.
4. If there is a mix, content type is `mixed`.
5. If the top-level info is video-like, content type is `video`.
6. Instagram `/p/` URLs default to `image`.
7. Otherwise, it defaults to `image`.

`_is_video_info()` treats an item as video if it has any of:

```text
duration
vcodec
ext in mp4/webm/mkv/mov
/reel/ in webpage_url
```

### Video Posts

For `content_type == "video"`:

1. `yt-dlp` downloads the media.
2. FFmpeg extracts MP3 audio.
3. The returned `DownloadResult` includes:

```text
video_path
audio_path
title
description
platform
content_type
uploader
duration
hashtags
```

### Image Or Carousel Posts

For non-video content:

1. Image URLs are collected from `yt-dlp` metadata.
2. If no image URLs are found and the platform is Instagram, the code fetches the Instagram HTML and tries to scrape image URLs from:

```text
display_url
image_versions2 candidates
og:image
```

3. It downloads up to 20 images.
4. The returned `DownloadResult` includes `image_paths`.

## Source Text Priority

The bot searches sources in this exact priority:

### 1. Caption And Title

In `handle_url()`:

```python
metadata_text = f"{result.title} {result.description}".strip()
places = await search_places_from_text(metadata_text)
```

If this returns any places:

```text
match_source = "caption"
```

The pipeline stops here. It does not OCR images or transcribe audio.

### 2. Image OCR

Only runs if caption/title found zero places and `result.image_paths` is non-empty.

OCR is implemented in `services/ocr.py` using:

```text
Pillow
pytesseract
```

Each image is converted to RGB, OCR text is extracted, and all image texts are joined.

The search text is:

```python
f"{metadata_text}\n{ocr_text}".strip()
```

If this returns places:

```text
match_source = "ocr"
```

### 3. Audio Transcription

Only runs if:

```text
no places found yet
audio_path exists
```

Transcription is implemented in `services/transcriber.py` using Whisper.

Behavior:

1. First pass: transcribe original language.
2. If language is English, use that text directly.
3. If language is not English, run a second Whisper pass with `task="translate"`.
4. Search uses English text when available.

Search text:

```python
search_text = transcription_result.english_text or transcription_result.text
places = await search_places_from_text(search_text)
```

If this returns places:

```text
match_source = "transcript"
```

## Place Search Algorithm

The main algorithm is `search_places_from_text()` in `services/places.py`.

Current default max suggestions:

```python
DEFAULT_PLACE_RESULT_LIMIT = 12
```

So the pipeline can suggest up to 12 places from a link.

Each Google Places query can request:

```python
per_query_limit = max(5, min(max_results, 12))
```

With the current default `max_results=12`, each query asks Google for up to 12 food-place candidates.

## Google Places API Call

`search_place()` calls the Google Places API New Text Search endpoint:

```text
POST https://places.googleapis.com/v1/places:searchText
```

Request body:

```json
{
  "textQuery": "query text"
}
```

Optional:

```json
{
  "regionCode": "SG"
}
```

Fields requested:

```text
displayName
formattedAddress
location
id
types
rating
userRatingCount
priceLevel
regularOpeningHours
```

## Food-Place Filtering

Before a Google result is allowed into the candidate list, it must have at least one type in `FOOD_PLACE_TYPES`.

Examples of accepted types:

```text
restaurant
cafe
coffee_shop
bakery
bar
pub
meal_takeaway
meal_delivery
brunch_restaurant
breakfast_restaurant
lunch_restaurant
diner
fast_food_restaurant
pizza_restaurant
seafood_restaurant
steak_house
sushi_restaurant
ramen_restaurant
chinese_restaurant
japanese_restaurant
korean_restaurant
thai_restaurant
vietnamese_restaurant
indian_restaurant
italian_restaurant
mexican_restaurant
american_restaurant
mediterranean_restaurant
middle_eastern_restaurant
hamburger_restaurant
hot_pot_restaurant
sandwich_shop
ice_cream_shop
dessert_shop
```

This means random non-food places should be filtered out before relevance scoring.

## Query Extraction Strategy

`search_places_from_text()` uses three levels of search:

1. Smart extracted queries.
2. Text chunks.
3. Full-text fallback.

It stops as soon as a level returns candidates.

### Level 1: Smart Extracted Queries

`extract_location_queries(text)` extracts specific location clues in priority order:

1. Lines containing a location pin emoji.
2. Place names inside special brackets.
3. Address-like lines, only if no previous location queries were found.
4. Instagram-style `@mentions`.

Location pin lines:

```text
text after the pin is used as query
hours/phone suffixes are removed
hashtags are removed
leading punctuation is removed
```

Special brackets:

```text
《place name》
【place name】
「place name」
```

Address patterns:

```text
Singapore or SG plus 6-digit postal code
Malaysia state/postal-code patterns
street/road indicators used later for validation
```

Mentions:

```text
@some.place -> "some place Singapore restaurant"
```

The function can extract many queries, but only the first 8 are searched:

```python
for query, source_type in location_queries[:8]:
```

If smart extracted queries return any accepted candidates, the function ranks and returns them immediately.

### Level 2: Text Chunks

Only runs if smart extracted queries return zero accepted candidates.

`extract_text_chunks(text, chunk_size=150)`:

1. Removes hashtags.
2. Splits text by periods and newlines.
3. Groups sentences into chunks under about 150 characters.

Only the first 4 chunks are searched:

```python
for chunk in chunks[:4]:
```

If chunks return any accepted candidates, the function ranks and returns them immediately.

### Level 3: Full-Text Fallback

Only runs if smart extraction and chunks return zero accepted candidates.

It searches the first 500 characters of the whole text:

```python
search_place(text[:500], max_results=max_results)
```

This fallback is strictly validated because it is the noisiest source.

## Candidate Relevance Validation

Every Google result is scored by `assess_candidate()` unless validation is skipped.

Validation looks at:

```text
exact normalized place-name match
meaningful word overlap between source text and place name
distinctive one-word venue names
address overlap, only for address-derived queries
rating
rating count
source type
```

### Normalization

`normalize_text()`:

1. Lowercases.
2. Replaces non-alphanumeric characters with spaces.
3. Collapses whitespace.

This allows exact phrase checks like:

```text
"Burnt Ends" matches "burnt ends"
```

### Meaningful Tokens

`tokenize_meaningful_words()` removes:

```text
common English words
generic food words
generic quality words
common location words like singapore, malaysia, sg, kl
tokens with length <= 2
```

This helps avoid weak matches such as matching only on "restaurant", "cafe", or "Singapore".

### One-Word Place Names

One-word venue names are allowed only if the token is distinctive:

```python
len(token) >= 4
token not in GENERIC_NAME_TOKENS
token not in STOPWORDS
```

This is meant to support real one-word names while rejecting generic names like:

```text
Cafe
Restaurant
Kitchen
Grill
Bakery
Dessert
```

### Required Name Overlap

For specific sources:

```text
location_pin
bracket_name
address
mention
```

One meaningful overlapping name token can pass.

For noisier sources:

```text
chunk
fallback
```

Two meaningful overlapping name tokens are required, unless there is an exact phrase match or a distinctive one-word match.

### Address Matching

Address matching is only allowed when the extracted query came from an address.

Address support checks whether the source text contains an address-like pattern:

```text
Singapore/SG plus 6-digit postal code
Malaysia postal/state pattern
road/street/avenue/lane/drive words
```

For chunk and fallback searches, address matching is not enabled.

## Confidence Scoring

Each accepted candidate gets a numeric confidence score.

Base score comes from the source type:

```text
location_pin: 36
bracket_name: 30
address: 24
mention: 18
chunk: 10
fallback: 6
default/smart: 14
```

Then bonuses are added:

```text
exact place-name match: +44
distinctive one-word venue match: +30
name overlap: +12 per overlapping token, capped at 3 tokens
address overlap: +6 per overlapping token, capped at 2 tokens
rating: +1 to +5 based on integer rating
rating count: +3 if >= 50 reviews, else +1 if present
```

Confidence labels:

```text
score >= 85: high
score >= 60: likely
otherwise: possible
```

The user-facing reason is generated from the strongest matching signal, for example:

```text
Exact place-name match from a pinned location line
Distinctive one-word venue match from transcript or caption context
Strong name overlap from a highlighted place name
Address-supported match from an address clue
Likely venue match from a broad text search
```

## Special Case: Mentions

For `@mentions`, validation is skipped.

Reason:

```text
The Instagram/TikTok handle may differ from the actual Google business name.
```

Mention results are assigned:

```text
confidence_score = 90
confidence_label = high
confidence_reason = Matched from a tagged account
```

This is powerful but risky. It can produce false positives if a tagged account is not the venue.

## Deduping And Ranking

Candidates are stored by Google `place_id`.

If the same place appears from multiple queries:

```text
keep the version with the highest confidence score
```

Final ranking:

```python
sorted(
    results,
    key=lambda r: (r.confidence_score, r.rating or 0, r.rating_count or 0),
    reverse=True,
)
```

Ranking priority:

1. Confidence score.
2. Google rating.
3. Google rating count.

Then the result list is truncated:

```python
ranked[:max_results]
```

With default settings, this means at most 12 suggested places.

## User Suggestion UI

Implemented in `bot/handlers.py`.

### One Place

If exactly one place is returned:

1. The bot auto-saves it.
2. Sends a Telegram location pin.
3. Sends a confirmation message with:

```text
place name
address
rating/review count
first two place types
source uploader
Google Maps link
original reel/post link
```

### Multiple Places

If more than one place is returned:

1. The bot stores the places in `context.user_data["pending_places"]`.
2. It stores source metadata in `context.user_data["pending_video_meta"]`.
3. It preselects every place with `confidence_label == "high"`.
4. If there are no high-confidence places, it preselects only the top-ranked result.
5. It shows a checklist-style review message.
6. The user can toggle individual places.
7. The user can save selected places or reject all suggestions.

The review message shows each candidate's:

```text
rank
name
address
confidence label
first two Google place types
rating/review count
confidence reason
```

The first ranked result is marked:

```text
[Best match]
```

There is no longer a separate "save best match" button.

## Failure Path

If no places are found:

1. The bot combines any available metadata, OCR text, and transcript text.
2. If there is no usable text/audio, it says it could not find text or audio.
3. If there is text, it shows a short preview of what it found.
4. It stores the original URL as pending state.
5. The user can reply with a manual place name.

Manual place search uses:

```python
search_place(text)
```

That returns the first food-filtered Google Places result and saves it directly if found.

## Current Pipeline Strengths

1. Caption-first avoids expensive audio transcription when captions already identify places.
2. OCR supports photo/carousel posts that have place text in the image.
3. Whisper translation helps non-English videos search Google Places in English.
4. Google result type filtering removes many non-food places.
5. Relevance validation reduces broad full-transcript noise.
6. Confidence scoring makes multi-place review more explainable.
7. High-confidence preselection supports posts with many real venues.

## Current Weaknesses To Refine

1. Caption short-circuit can miss additional places mentioned only in audio or images.
2. Mention validation is skipped and always marked high confidence, which can be too trusting.
3. Search uses Google Text Search only; it does not use a separate entity-extraction model before querying.
4. Full text and chunk searches can still be noisy if Google returns plausible restaurants unrelated to the actual content.
5. There is no geographic context unless the query text itself includes a location.
6. The pipeline returns only from the first successful source level instead of merging caption, OCR, and transcript evidence.
7. No per-source evidence is stored for rejected candidates, making debugging false positives harder.
8. OCR quality depends on Tesseract and image download success; private/blocked Instagram posts may produce no images.
9. The result cap is 12, so posts mentioning more than 12 valid venues will be truncated after ranking.
10. Single-result auto-save can still save a low-confidence result without user confirmation.

## Refinement Ideas

These are concrete improvements to consider next.

1. Always gather all available evidence first: caption/title, OCR, and transcript.
2. Run place search per evidence source, then merge candidates by `place_id`.
3. Track source evidence per candidate, for example `caption_exact`, `ocr_overlap`, `transcript_overlap`, `mention`.
4. Lower confidence for mentions unless the handle text also overlaps with the Google place name, website, or address.
5. Require user confirmation for single candidates below a confidence threshold.
6. Add a minimum confidence threshold for auto-save, such as only auto-save `high`.
7. Use location hints from caption hashtags and addresses to set Google region or location bias.
8. Add a debug output mode that shows query, returned candidates, filtered candidates, and rejection reason.
9. Store rejected candidates temporarily during development to analyze false positives.
10. Split extraction into explicit stages: evidence extraction, query generation, Google retrieval, candidate validation, ranking, and user review.

## Current Algorithm Summary

In compact form:

```text
input URL
  -> validate platform
  -> yt-dlp metadata extraction
  -> detect content type
  -> if video: download video/audio
  -> if image/carousel: download up to 20 images
  -> search title + caption
      -> smart queries, chunks, fallback
      -> Google Places Text Search
      -> food-type filter
      -> relevance scoring
      -> rank up to 12
  -> if no caption result and images exist:
      -> OCR images
      -> search metadata + OCR text
  -> if no OCR result and audio exists:
      -> Whisper transcribe/translate
      -> search transcript
  -> if 0 results:
      -> ask user for manual place name
  -> if 1 result:
      -> auto-save
  -> if 2 to 12 results:
      -> show checklist
      -> preselect high-confidence results or top result
      -> user saves selected results
```

