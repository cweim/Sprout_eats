# Slot-Based Place Extraction Strategy

Goal: given an Instagram or TikTok link, suggest exactly the places recommended by the post.

The core rule is:

> Google Places is the resolver, not the extractor.

The extractor first decides which place slots are actually recommended by the post. Google Places is only used afterward to turn each source-backed slot into a canonical place record.

## Why This Strategy

The previous text-search approach can work for simple one-place captions, but it is unsafe for high-accuracy extraction because:

- A broad caption/transcript query can return real restaurants that were not recommended.
- A multi-place caption can list more places than the pipeline searches.
- Mentions can point to creators, chefs, or publishers instead of venues.
- Transcript text is noisy and often contains dish/category words rather than venue names.
- Visual-only reels/carousels require OCR; guessing from generic captions creates false positives.

The slot-based strategy prevents these failure modes by requiring every suggestion to map back to an explicit source slot.

## Pipeline

### 1. Collect Metadata

Collect all available post evidence:

- Title and caption from downloader metadata.
- Hashtags and mentions.
- OCR text from carousel images or sampled video frames.
- Transcription only when caption/OCR does not expose reliable places.
- Comments only for debugging, not extraction.

### 2. Extract Place Slots

Build `PlaceEvidence` objects before calling Google Places.

Each slot contains:

- `source`: `caption_pin`, `caption_list`, `ocr`, `mention`, or `transcript`.
- `raw_text`: exact evidence text.
- `name_candidate`: extracted venue name.
- `address_candidate`: paired address if present.
- `area_candidate`: neighborhood/city if present.
- `should_resolve`: false for `Multiple locations` brand slots.
- `confidence`: source confidence before Google.

Source priority:

1. Caption pin/list with address.
2. Caption pin/list with name only.
3. OCR pin/list from carousel or video frame.
4. Venue mention plus area/address context.
5. Transcript entity candidates only if caption/OCR has no reliable slots.
6. Broad full-text search is disabled for auto-suggestion.

### 3. Determine Expected Count

The number of slots is the expected output count:

- 12 caption place lines means 12 expected output rows.
- 7 caption list items means 7 expected output rows.
- `Multiple locations` remains a brand-level row and should not force a random branch.
- 0 reliable slots means the bot should say it needs review/OCR/manual input, not guess.

### 4. Resolve Each Slot With Google Places

For each slot:

- Query `name + address` when address exists.
- Query `name + area/city` when only area exists.
- Query `name + country/city` for name-only caption list slots.
- Query venue mentions only when the mention is not a creator/publisher handle.
- Use only source-derived location context. Never bias link extraction by the user's current location or by a hard-coded default country.

Google Places results are still filtered to food/drink types in `services/places.py`.

### 5. Validate Google Candidates

A Google result is accepted only if it passes slot validation:

- Food/drink Google type.
- Strong name match, compact name match, or distinctive one-word venue match.
- Address/area support when the source provides address/area.
- Mention result must overlap the handle by token or compact form.

If no candidate passes, the slot is marked unresolved.

### 6. UX Contract

The user should see one row per source slot:

- Resolved high-confidence slots can be preselected.
- Multiple-location slots should be shown as brand-level entries or require branch selection.
- Unresolved slots should say `Needs review`, not show a random fallback.
- Extra Google candidates that do not map to a source slot should not be shown as suggested places.

## Current Evaluation Result

Evaluation files:

- `place-extraction-pipeline/datasets/slot_pipeline_evaluation.json`
- `place-extraction-pipeline/datasets/slot_pipeline_evaluation.md`

Latest run against the 14-link dataset:

- Records: 14
- Ground-truth places: 35
- Extracted source-backed slots: 33
- Slot precision: 1.0
- Slot recall: 0.943
- Google-resolved suggestions: 33
- Suggestion precision: 1.0
- Suggestion recall: 0.943

The two unrecalled ground-truth places are not exposed by public metadata:

- `DFCnSjRyk3C`: roulette result needs video-frame OCR/manual visual extraction.
- `DQHPIx0idZr`: venue name is not in regenerated caption/transcript metadata and needs frame OCR or external cross-reference.

This behavior is intentional. The pipeline should prefer no suggestion over a wrong suggestion.

## Next Production Changes

To wire this into the bot:

1. Replace `search_places_from_text(metadata_text)` with slot extraction from metadata.
2. Resolve each slot independently.
3. Keep OCR/transcript as evidence sources, not broad full-text search sources.
4. Update multi-place UX to show one source slot per row.
5. Add video-frame OCR and authenticated carousel OCR to recover visual-only posts.
