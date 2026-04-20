# Instagram Food Link Ground Truth Dataset

This folder contains a first-pass ground-truth dataset for the Instagram links in `place-extraction-pipeline/ig_links.md`.

## Files

- `instagram_ground_truth.json`: structured dataset of each Instagram link and the places it is actually recommending.
- `../ig_metadata.tsv`: compact metadata extracted with `yt-dlp` for links where public metadata was available.

## Ground Truth Method

Records are marked with a `ground_truth_status`:

- `verified_from_caption`: the Instagram caption explicitly names the place or lists places.
- `verified_from_video_frame`: the caption was insufficient, but manual video-frame inspection showed the venue overlay.
- `verified_from_caption_and_web`: the caption gave a partial clue, and public web listings were used to confirm the full venue/address.
- `verified_from_caption_video_and_web`: caption, visible media context, and web search were combined.
- `needs_manual_review`: the public caption/metadata did not expose the actual place list.

## Categories

- `single_place_explicit_caption`: one venue is directly named in the caption.
- `multi_place_explicit_caption_list`: several venues are directly listed in the caption.
- `multi_place_caption_list_no_addresses`: several venues are listed, but branch/address is missing.
- `single_place_mention_plus_address`: the place is represented by an account mention plus address.
- `single_place_mention_plus_area`: the place is represented by an account mention plus area.
- `single_place_caption_incomplete_cross_verified`: caption clearly describes the venue but omits the final name, requiring cross-reference.
- `ambiguous_roulette_reel`: the reel is a roulette/randomizer format; the visible stopped result is treated as ground truth.
- `carousel_places_in_images_not_publicly_exposed`: place names appear to be inside carousel images, but unauthenticated public metadata did not expose them.

## Current Coverage

Total links inspected: 14

Usable ground truth: 13

Needs manual review: 1

The unresolved link is:

```text
DQwiEYlEgft
https://www.instagram.com/p/DQwiEYlEgft/?img_index=3&igsh=bGxsYWZxaDM4b3Fj
```

For this post, public metadata only says it contains KL food recommendations. The publicly available image is the cover image and does not expose the place list. To complete this record, inspect the full carousel in a browser or provide authenticated Instagram cookies for media extraction.

## Dataset Use

This dataset can be used to evaluate the current extraction pipeline with metrics like:

- Did the bot return every expected place?
- Did the bot return non-ground-truth false positives?
- Did the bot choose the correct branch/address?
- Did the bot miss places because it stopped after caption search?
- Did mention-based extraction produce accurate or overconfident results?
- Did photo/carousel posts need OCR rather than caption parsing?

## Important Evaluation Notes

Some records intentionally contain `Multiple locations` or `null` addresses. These should not be treated as failed ground truth. They reflect the source post itself not committing to a specific branch.

For `Under The Big Tree Fried Nian Gao`, the source caption explicitly says the place is not on Google Maps. A Google Places-only pipeline may fail this record even if it correctly extracts the name.

For `DFCnSjRyk3C`, the source is a roulette-style reel. The visible stopped result is the expected answer for this dataset, but the post format may include many rapidly changing restaurants that are not intended to all be saved.

