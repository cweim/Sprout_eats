# Social Place Extraction Audit

This audit covers the current cross-platform link set in:

- [ig_links.md](/Users/chinweiming/Desktop/discovery-bot/place-extraction-pipeline/ig_links.md)
- [tiktok_links.md](/Users/chinweiming/Desktop/discovery-bot/place-extraction-pipeline/tiktok_links.md)

It uses:

- normalized metadata with OCR/transcription in [social_metadata_with_media.json](/Users/chinweiming/Desktop/discovery-bot/place-extraction-pipeline/metadata_dataset/social_metadata_with_media.json)
- ground truth in [social_ground_truth.json](/Users/chinweiming/Desktop/discovery-bot/place-extraction-pipeline/datasets/social_ground_truth.json)
- bot-like evaluation output in [social_pipeline_evaluation.json](/Users/chinweiming/Desktop/discovery-bot/place-extraction-pipeline/datasets/social_pipeline_evaluation.json)

## Dataset

- Links audited: `29`
- Instagram links: `19`
- TikTok links: `10`
- Records with full metadata/media evidence: `25`
- Partial records: `4`
- Ground-truth places captured: `56`
- Records still needing manual review: `4`

Manual-review records:

- `DQwiEYlEgft`: Instagram carousel where public metadata still does not expose the actual KL place list.
- `ZS9JMT48Y`: TikTok photo post unsupported by the current downloader.
- `ZS9JfsvpD`: TikTok photo post unsupported by the current downloader.
- `ZS9JfqUr5`: TikTok photo post unsupported by the current downloader.

## Accuracy

Current bot-like staged slot pipeline:

- Slot precision: `0.759`
- Slot recall: `0.732`
- Suggested-place precision: `0.909`
- Suggested-place recall: `0.714`
- Exact suggested-place count on records: `21 / 29`

Interpretation:

- Precision is still strong once the pipeline actually suggests a place.
- Recall is now the main weakness on the broader mixed-platform dataset.
- The new audit exposes several failure modes that were underrepresented in the earlier Instagram-only evaluation.

## Main Failure Modes

### 1. Unsupported TikTok photo posts

Three TikTok shortlinks redirect to `.../photo/...` URLs and the current downloader rejects them.

Affected records:

- `ZS9JMT48Y`
- `ZS9JfsvpD`
- `ZS9JfqUr5`

Impact:

- no metadata
- no OCR
- no transcription
- no ground truth without manual inspection

### 2. OCR noise being treated as venue slots

Some reels fall through to video OCR, and noisy overlay text becomes candidate place slots.

Examples:

- `DFCnSjRyk3C`
  - extracted slots: `@ Monday & gursday Closed od`, `HarbourFront MRT Station (120m)`, `A) la —`
  - wrong suggestion: `Gong Yuan Ma La Tang 宫源麻辣烫 @ Century Square`
  - missed ground truth: `Lai Heng Fried Kuay Teow & Cooked Food`

- `DNR_3IeSIAE`
  - extracted slots are all OCR garbage
  - no place suggestion survives validation
  - missed ground truth: `Ah Fai Dry Laksa`

- `ZS9JPRm49`
  - extracted slots: `S`, `nM`, `BEEF CHEEK`
  - wrong suggestion: `Sippysip.s`
  - missed ground truth: `Bronzo Pasta Bar`

### 3. Caption list parsing still misses multi-place TikTok posts

`ZS9JftuDa` contains a 10-place dating list in the caption, but the current extractor only pulls one junk slot:

- extracted slot: `✨ No specific ranking`
- suggestion: `Umai Artisanal Udon Bar`
- missed ground truth places: `9`

This is a real recall problem for list-style TikTok captions.

### 4. Mention-plus-branch captions are still too weak

`DCsxHAqSIby` clearly points to `@huevossg` at `New Bahru`, but the slot extractor keeps the whole noisy mention line as one unresolved slot instead of isolating the venue handle and branch context.

Impact:

- missed ground truth: `Huevos`

### 5. Non-Singapore venue names can be missed when the slot parser finds nothing

`ZS9JMgdjP` is a Sydney sushi video. Title and video OCR clearly indicate `Sushi Muni Surry Hills`, but the current extractor finds no usable slot at all.

Impact:

- missed ground truth despite usable metadata

### 6. Brand-or-multiple-location handling is conservative by design

`DEAN_ZMyAtl` is not a precision bug, but it does suppress branch resolution for brands explicitly marked as multiple locations.

The pipeline correctly avoids random branch selection for:

- `One Fattened Calf Burgers`
- `Shang Hai La Mian Xiao Long Bao`
- `Khao Hom`
- `Sin Heng Kee Porridge`
- `Common Man Coffee Roasters`
- `Fiie’s Cafe`
- `A Hot Hideout`

This keeps precision high, but it lowers apparent recall if the evaluation expects one concrete place result per brand mention.

## Current Recommendation

If the goal remains maximum precision with low wrong-place risk, the current slot-based resolver is still directionally correct. The next improvements should target recall without reintroducing noisy broad search.

Priority order:

1. Add TikTok photo-post support so those links are no longer blind spots.
2. Tighten video OCR slot filtering so garbage text cannot become candidate venue names.
3. Improve multi-place list extraction for TikTok captions with numbered sequences.
4. Improve mention-plus-branch parsing so handles like `@huevossg ... @newbahru` become `Huevos` plus branch context.
5. Add stronger title/video-OCR venue-name extraction for non-captioned single-place clips like `ZS9JMgdjP`.
