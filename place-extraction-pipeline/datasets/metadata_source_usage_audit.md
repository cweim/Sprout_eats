# Metadata Source Usage Audit

Goal: given one Instagram link, retrieve the exact places recommended in the post: no unrelated places, no missing places, and no extra places.

This audit compares:

- Regenerated metadata: `place-extraction-pipeline/metadata_dataset/instagram_metadata_with_media.json`
- Current ground truth: `place-extraction-pipeline/datasets/instagram_ground_truth.json`
- Current extraction code: `services/places.py` and bot source order in `bot/handlers.py`

## Executive Summary

The strongest source is the caption, especially explicit location pin/list/address lines. In this dataset, most accurate places are recoverable from caption text alone.

Source reliability in this dataset:

- Caption pin/list/address lines: highest precision and highest recall for 10 of 14 links.
- Mentions: useful only when the handle is the venue, risky when the handle is a creator, chef, or publisher.
- Transcript: useful context, but not a reliable primary place source in this dataset. No record has ground truth that is uniquely recoverable from transcript alone.
- OCR: currently not contributing because downloaded image count/OCR text is zero for the regenerated dataset.
- Comments: not suitable for extraction; comments include noise such as `Where` or tagged friends.
- HTML image URLs: not useful as place evidence; mostly static Instagram assets.

The current pipeline has two major accuracy risks:

- It only searches the first 8 extracted location queries even when a caption clearly lists more places. This can miss places in multi-place posts like `DEAN_ZMyAtl`, which has 12 caption-listed places.
- Mention-derived queries skip validation. This can save wrong places when the mention is not the venue, for example `@districtsixtyfive` is a publisher account, not one of the seven restaurants in `DS3v8C4j8dg`.

## Current Pipeline Behavior

Current bot source order:

1. Download metadata from the link.
2. Search Google Places from metadata text, usually title + caption.
3. If places are found, stop; do not run OCR or transcript.
4. If no places found and images exist, run OCR and search caption + OCR.
5. If still no places found and audio exists, transcribe and search transcript.

Current `search_places_from_text()` behavior:

1. Extract smart queries from location pins, bracket names, addresses, and mentions.
2. Search only the first 8 smart queries.
3. If any smart-query results are kept, return immediately.
4. Only if no smart-query results survive, search text chunks.
5. Only if chunks produce no results, search the full text fallback.

This is precision-friendly for single explicit captions, but it is not safe for exact cardinality on multi-place content.

## Source Reliability Matrix

| Source | Precision | Recall | Main Use | Main Risk |
| --- | --- | --- | --- | --- |
| Caption location pin lines | Very high | High | Primary extraction | Current parser misses non-pin lists and caps search at 8 queries |
| Caption address snippets | Very high | Medium | Validate branch/address | Address regex can miss Malaysian addresses or split name/address poorly |
| Caption plain list without pins | High | Medium | Multi-place photo/carousel posts | Current smart extraction may ignore these and fall into mention/chunk behavior |
| Mentions | Medium | Low/Medium | Resolve venue handles like `@fuegomesa` | Creator/chef/publisher handles create false positives |
| Transcript | Low/Medium | Low | Fallback only | Searching whole transcript can produce noisy or partial place candidates |
| OCR | Potentially high | Currently zero | Carousel/video-frame text | Current dataset did not download actual carousel images or video frames for OCR |
| Comments | Low | Low | Debug only | Viewer comments are not place recommendations |
| HTML metadata/images | Low | Low | Availability/debug only | Public HTML images are mostly Instagram static assets |

## Link-by-Link Audit

### C09WEZkyfys

Ground truth count: 1

Ground truth:

- Hong Chang Frog Porridge and BBQ Fish

Best source:

- Caption address snippet.

Metadata evidence:

- Caption contains `Hong Chang Frog Porridge and BBQ Fish (2 Braddell Rd, Singapore 359895)`.
- Extracted query: `📌 Hong Chang Frog Porridge and BBQ Fish (2 Braddell Rd, Singapore 359895)` as `address`.
- Transcript quality is weak and should not be used.

Current pipeline likely outcome:

- Should retrieve the correct single place from caption/address.

Risk:

- The caption uses `📌`, not `📍`. The current extractor catches it only because it contains `Singapore 359895`, not because it recognizes `📌` as a pin marker.

Recommendation:

- Treat `📌` the same as `📍`.
- Stop after the caption/address result; do not search transcript.

### DGQOuG2SrnY

Ground truth count: 1

Ground truth:

- NÓMADA / NOMADA

Best source:

- Caption location pin.

Metadata evidence:

- Caption contains `📍 NÓMADA, 1 Keong Saik Rd., 01-05, Singapore 089109`.
- Mention `@gonzaloland` is a chef, not the venue.

Current pipeline likely outcome:

- Should retrieve NÓMADA from the location pin.

Risk:

- If the location pin failed, mention fallback could search the chef handle and produce an unrelated place.

Recommendation:

- Do not use mentions when a location pin already exists unless the mention text overlaps the chosen place or the caption context says the mention is the venue.

### DTp98aACdL7

Ground truth count: 1

Ground truth:

- Ganko Sushi

Best source:

- Caption location pin and venue mention.

Metadata evidence:

- Caption contains `📍Ganko Sushi`.
- Caption contains `9 Penang Rd, 01-01, Singapore 238459`.
- Mention `@ganko.sushi_sg` matches the venue.

Current pipeline likely outcome:

- Should retrieve the correct single place from caption pin.

Risk:

- Low.

Recommendation:

- Use caption pin as primary. Mention can be supporting evidence because it overlaps the venue name.

### DEAN_ZMyAtl

Ground truth count: 12

Ground truth:

- One Fattened Calf Burgers
- Shang Hai La Mian Xiao Long Bao
- Meadesmoore Steakhouse
- FYP (For You People) Cafe - Orchard Central
- sen-ryo ION Orchard
- Hot Duck
- Khao Hom
- Sin Heng Kee Porridge
- Common Man Coffee Roasters
- Nassim Hill Bakery Bistro Bar
- Fiie's Cafe
- A Hot Hideout

Best source:

- Caption location-pin list.

Metadata evidence:

- Caption has 12 `📍` location lines.
- Extracted smart queries count is 12.

Current pipeline likely outcome:

- At risk of missing places because the code only searches `location_queries[:8]`.
- It can miss the last four caption-listed places: Common Man Coffee Roasters, Nassim Hill Bakery Bistro Bar, Fiie's Cafe, and A Hot Hideout.

Risk:

- High recall risk: fewer places than actually recommended.
- Possible over-suggestion if any query returns multiple branches or unrelated variants.

Recommendation:

- If explicit location-line count is N, search all N lines, not a fixed first 8.
- Return at most one accepted canonical result per explicit location line unless the source line says `Multiple locations`.
- Preserve `Multiple locations` as a brand-level result rather than forcing a random branch.

### DFCnSjRyk3C

Ground truth count: 1

Ground truth:

- Lai Heng Fried Kuay Teow & Cooked Food

Best source:

- Video-frame OCR/manual visual inspection.

Metadata evidence:

- Caption does not name a place.
- Transcript says only generic roulette context.
- Current regenerated metadata has no frame OCR.

Current pipeline likely outcome:

- Likely no accurate result from current metadata.
- If chunk/fallback search returns anything, it is probably a false positive.

Risk:

- High false-positive risk if broad caption/transcript fallback is allowed.
- High miss risk without video-frame OCR.

Recommendation:

- For roulette/randomizer posts with generic caption and no explicit place text, do not suggest Places API results from caption/transcript.
- Add frame sampling OCR before transcript fallback.
- Only suggest a place if OCR finds a visible stopped-result restaurant name.

### CmEFYWzpMQc

Ground truth count: 1

Ground truth:

- Yan Wo Thai

Best source:

- Caption location pin.

Metadata evidence:

- Caption contains `📍Yan Wo Thai, Jalan PJU 1/43, Aman Suria, 47301 Petaling Jaya`.
- Transcript independently mentions a phonetically similar `Yen Wautai`, but caption is better.

Current pipeline likely outcome:

- Should retrieve the correct single place from caption pin.

Risk:

- Low.

Recommendation:

- Caption pin should dominate. Transcript should be ignored once the caption result is accepted.

### DS3v8C4j8dg

Ground truth count: 7

Ground truth:

- Osteria Mozza
- GU:UM
- Uncle Fong Hotpot
- Sushi Zushi
- The Plump Frenchman
- Vios by Blu Kouzina
- Bochinche

Best source:

- Caption plain list.

Metadata evidence:

- Caption lists all seven places with food descriptions.
- No `📍` pin lines.
- Mention is `@districtsixtyfive`, which is the publisher account, not a venue.

Current pipeline likely outcome:

- At high risk of wrong result because `@districtsixtyfive` becomes a mention query and mention results skip validation.
- If the mention query returns any food place, the pipeline returns early and never chunks the caption list.
- Even if mention returns nothing, chunking only searches first four chunks, which may miss later places like Bochinche.

Risk:

- High false-positive risk from creator mention.
- High recall risk for seven-place plain-list caption.

Recommendation:

- Detect plain caption lists using emoji/line structure and extract venue names directly.
- Do not use creator/publisher mentions as place queries.
- Require mention-derived candidates to have venue-name overlap or be backed by nearby address/area words.

### DUExJM_Ep6i

Ground truth count: 1

Ground truth:

- Uokatsu Malaysia

Best source:

- Caption mention plus full address.

Metadata evidence:

- Caption says `@uokatsu.malaysia`.
- Caption gives full address at Plaza Damas 3.

Current pipeline likely outcome:

- Should retrieve the correct place, but current first query is address-only without venue name.
- Mention query uses `uokatsu malaysia Singapore restaurant`, which is geographically wrong for a Kuala Lumpur venue.

Risk:

- Medium branch/location risk because the mention query appends `Singapore restaurant` regardless of source country.

Recommendation:

- Infer country/city from caption before building mention queries.
- For this caption, query should be `uokatsu malaysia Kuala Lumpur restaurant` or `uokatsu malaysia Plaza Damas 3`.

### DVYIIu-EoyO

Ground truth count: 1

Ground truth:

- Pazonia Italian Street Food @ Amoy

Best source:

- Caption location pin and address.

Metadata evidence:

- Caption contains `📍Pazonia Italian Street Food @ Amoy`.
- Caption contains `49 Amoy St, Singapore 069875`.
- Mention `@pazonia.sg` supports the same venue.

Current pipeline likely outcome:

- Should retrieve the correct single place.

Risk:

- Low.

Recommendation:

- Keep caption pin as primary.
- Deduplicate repeated mention queries.

### DPyhLE4kqmp

Ground truth count: 1

Ground truth:

- Baker's Bench Bakery

Best source:

- Caption location pin.

Metadata evidence:

- Caption contains `📍Baker’s Bench Bakery, Bukit Pasoh Road`.
- Full exact address is externally verified, not fully present in metadata.

Current pipeline likely outcome:

- Should retrieve the correct place from caption pin/street.

Risk:

- Low place-name risk, medium address completeness risk.

Recommendation:

- Accept the place if Google resolves the branch from `Baker's Bench Bakery, Bukit Pasoh Road`.
- Store source evidence as caption-street, not full caption-address.

### DQHPIx0idZr

Ground truth count: 1

Ground truth:

- Joong San

Best source:

- Not available from regenerated metadata alone.
- Needs video-frame OCR, creator page context, or web/manual cross-reference.

Metadata evidence:

- Caption says `NEW Korean restaurant by the popular Um Yong Baek`.
- Caption does not name `Joong San`.
- Transcript preferred text is very short and useless.

Current pipeline likely outcome:

- High risk of returning wrong places, especially Um Yong Baek or generic Korean restaurants.

Risk:

- High false-positive risk.
- High miss risk.

Recommendation:

- Do not suggest a place from this metadata alone.
- If caption contains relationship clues like `by [brand]` but no venue name/address, mark as `needs visual/web verification`.
- Add video-frame OCR and/or web search cross-reference before querying Google Places.

### DOmzzsxEq_9

Ground truth count: 1

Ground truth:

- Fuego Mesa

Best source:

- Caption venue mention plus area.

Metadata evidence:

- Caption says `@fuegomesa (Farrer Park)`.
- Transcript is poor and should be ignored.

Current pipeline likely outcome:

- Might retrieve the correct place via mention.
- Current mention query appends `Singapore restaurant`, which is okay for this record.

Risk:

- Medium false-positive risk because mentions skip validation.

Recommendation:

- Allow mention-only extraction only when the mention is near food/location terms or area hints such as `Farrer Park`.
- Validate mention result against normalized handle tokens, for example `fuego` and `mesa`.

### DQwiEYlEgft

Ground truth count: unresolved

Best source:

- Carousel image OCR or manual inspection.

Metadata evidence:

- Caption says it contains KL food spots but does not list names.
- No OCR images were extracted.

Current pipeline likely outcome:

- Should not suggest places from current metadata.
- Any result from chunk/fallback would likely be a false positive, such as generic nasi lemak/nasi kandar places.

Risk:

- Very high false-positive risk if broad text search is used.

Recommendation:

- Mark as `needs carousel OCR`.
- Suppress Google Places search when the caption only says generic category/location text and contains no specific venue names.

### DG7pUH8yICz

Ground truth count: 6

Ground truth:

- Huen Kee Claypot Chicken Rice
- Restoran Kin Kin
- Lam Kee Wantan Noodles
- Under The Big Tree Fried Nian Gao
- Nasi Lemak Shop
- YUAN

Best source:

- Caption location-pin list.

Metadata evidence:

- Caption lists six `📍` locations and full addresses.
- Transcript broadly agrees but has many phonetic errors.

Current pipeline likely outcome:

- Should retrieve most or all six because there are only six location queries, under the current first-8 cap.

Risk:

- `Under The Big Tree Fried Nian Gao` may fail because caption says it is not on Google Maps.
- `Nasi Lemak Shop` is a generic-sounding one-word-ish phrase plus category words, so it needs address support to avoid wrong branches.
- Current derived address snippets missed the Nasi Lemak Shop address even though the raw caption contains it.

Recommendation:

- Pair each location line with the following address block before querying.
- Query `Nasi Lemak Shop + G10 Oasis Business Center BU4...`, not just `Nasi Lemak Shop`.

## Overall Failure Modes

### 1. Exact Count Failure

When the post explicitly lists N places, the pipeline should produce N candidate slots. Current code can produce fewer because it caps smart queries at 8 and chunks only the first four chunks.

Fix:

- Extract structured place slots first.
- Search every slot.
- Return one candidate group per slot.

### 2. Mention False Positives

Mentions are not always places. In this dataset:

- Good venue mentions: `@ganko.sushi_sg`, `@uokatsu.malaysia`, `@pazonia.sg`, `@fuegomesa`.
- Risky non-venue mentions: `@districtsixtyfive`, `@gonzaloland`.

Fix:

- Classify mentions by context before querying.
- Do not skip validation for mention results.
- If the mention is the uploader/creator or appears after `follow`, treat it as non-place.

### 3. Broad Transcript Noise

Transcript is not the primary source for any verified place in this dataset. It can help when captions are empty, but it should not override caption evidence.

Fix:

- Use transcript only if caption has no structured place evidence.
- Search extracted entity candidates from transcript, not the whole transcript.
- Suppress transcript search if transcript quality is poor or if it contains only generic food words.

### 4. Missing Visual OCR

Some posts require visual extraction:

- `DFCnSjRyk3C`: roulette result appears in video frame.
- `DQHPIx0idZr`: venue likely appears visually or needs external cross-reference.
- `DQwiEYlEgft`: carousel place list likely appears in images.

Fix:

- Add video-frame sampling OCR for reels with weak captions.
- Add authenticated carousel image extraction or browser screenshot OCR.
- Use OCR text as structured source before transcript.

### 5. Branch/Address Ambiguity

Some ground truth entries are brand-level or multiple-location.

Fix:

- If source says `Multiple locations`, do not force a single branch unless the user picks one.
- If source gives address, require address support for final Google candidate.
- For generic names like `Nasi Lemak Shop`, branch/address matching must be mandatory.

## Recommended Extraction Architecture

### Stage 1: Build Structured Evidence Slots

Create `PlaceEvidence` objects before calling Google:

- `source`: caption_pin, caption_plain_list, caption_address, mention, ocr, transcript
- `raw_text`: exact source line or OCR snippet
- `name_candidate`: extracted venue name
- `address_candidate`: paired address if available
- `area_candidate`: city/neighborhood if available
- `confidence`: source confidence before Google
- `must_return`: true if from explicit caption list

### Stage 2: Determine Expected Count

Rules:

- If caption has explicit place lines/list items, expected count equals extracted place slots.
- If carousel OCR finds a place list, expected count equals OCR slots.
- If source is roulette/video-frame result, expected count is one selected visible result.
- If only generic caption/transcript exists, expected count is unknown and no auto-save should happen.

### Stage 3: Search Per Slot

For each `PlaceEvidence` slot:

- Query `name + address` when address exists.
- Query `name + area/city` when no address exists.
- Query mention only if mention is classified as a venue handle.
- Keep only one best candidate per slot unless the source says multiple locations.

### Stage 4: Validate Candidate Against Slot

Validation should require:

- Name overlap or exact normalized phrase match.
- Address/area match when source provides one.
- Food/drink Google type.
- No acceptance based only on broad transcript/category words.

### Stage 5: User UX

For multi-place posts:

- Show grouped slots: one row per extracted source place.
- If a slot has high-confidence Google match, preselect it.
- If a slot is unresolved, show `Needs review`, not a random fallback.
- Do not add extra candidates that do not map to a source slot.

## Source Priority Policy

Use this priority:

1. Caption explicit pin/list with address.
2. Caption explicit pin/list with name only.
3. OCR explicit pin/list from carousel/video frame.
4. Mention plus area/address context.
5. Transcript only if it contains explicit venue names and caption/OCR has none.
6. Broad full-text search should be disabled for auto-suggestion; use it only for manual user search.

## Dataset-Level Conclusion

For highest accuracy, this pipeline should become slot-based rather than text-search-based.

The current text-search pipeline is good for simple single-place captions but unsafe for:

- Multi-place captions with more than 8 entries.
- Plain caption lists without pin emojis.
- Creator/publisher mentions.
- Visual-only posts.
- Generic captions with no venue names.

The correct behavior is to extract source-backed place slots first, then resolve each slot with Google Places. If no reliable slot exists, the bot should ask for manual confirmation or run OCR/web verification rather than suggesting random places.
