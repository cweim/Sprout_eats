# Ground Truth Audit From Regenerated Metadata

Generated from `place-extraction-pipeline/metadata_dataset/instagram_metadata_with_media.json`.

## Summary

- Total links reviewed: 14
- Current ground-truth records that match explicit metadata evidence: 10
- Current ground-truth records that are plausible but not fully provable from the regenerated metadata alone: 3
- Current ground-truth records still unresolved from public metadata: 1
- Clear wrong ground-truth entries found: 0

## Evidence Rules Used

- Strong evidence: caption pin lines, caption place lists, explicit address lines.
- Medium evidence: account mention plus area/address, transcript agreement.
- Weak evidence: prior manual frame inspection or web cross-reference not present in the regenerated metadata.
- Unresolved: public metadata does not expose the actual place names.

## Link-by-Link Audit

### C09WEZkyfys

Verdict: accurate.

Ground truth:

- Hong Chang Frog Porridge and BBQ Fish, 2 Braddell Rd, Singapore 359895

Evidence:

- Caption explicitly says `Hong Chang Frog Porridge and BBQ Fish (2 Braddell Rd, Singapore 359895)`.

Notes:

- Transcript is not useful for this link, but caption evidence is sufficient.

### DGQOuG2SrnY

Verdict: accurate.

Ground truth:

- NOMADA, 1 Keong Saik Rd., 01-05, Singapore 089109

Evidence:

- Caption explicitly says `NOMADA, 1 Keong Saik Rd., 01-05, Singapore 089109`.

Notes:

- Source caption uses `NOMADA` with an accent in the metadata text: `NÓMADA`. The dataset's unaccented spelling is acceptable for matching, but preserving the accented display name would be cleaner.

### DTp98aACdL7

Verdict: accurate.

Ground truth:

- Ganko Sushi, 9 Penang Rd, 01-01, Singapore 238459

Evidence:

- Caption explicitly says `Ganko Sushi` and `9 Penang Rd, 01-01, Singapore 238459`.

### DEAN_ZMyAtl

Verdict: accurate.

Ground truth:

- One Fattened Calf Burgers, Multiple locations
- Shang Hai La Mian Xiao Long Bao, Multiple locations
- Meadesmoore Steakhouse, 21A Boon Tat Street Level 2, near Telok Ayer St, Singapore 069620
- FYP (For You People) Cafe - Orchard Central, 181 Orchard Rd, #04-22 Orchard Central, Singapore 238896
- sen-ryo ION Orchard, 2 Orchard Turn, #03-17/18, Singapore 238801
- Hot Duck, 1 North Point Dr, B2-147, South Wing, Singapore 768019
- Khao Hom, Multiple locations
- Sin Heng Kee Porridge, Multiple locations
- Common Man Coffee Roasters, Multiple locations
- Nassim Hill Bakery Bistro Bar, 56 Tanglin Rd, #01-03, Singapore 247964
- Fiie's Cafe, Multiple locations
- A Hot Hideout, Multiple locations

Evidence:

- Caption explicitly lists all 12 places with either `Multiple locations` or branch addresses.

Notes:

- The dataset is accurate. Some display names are normalized versus the source caption, for example `千両 sen-ryo (ION Orchard)` becomes `sen-ryo ION Orchard`.

### DFCnSjRyk3C

Verdict: plausible but not verifiable from regenerated metadata alone.

Ground truth:

- Lai Heng Fried Kuay Teow & Cooked Food, 320 Shunfu Rd, #02-20, Singapore 570320

Evidence:

- Current regenerated metadata does not expose this place in the caption, comments, or transcript.
- Existing dataset says this came from manual video-frame inspection of a roulette-style reel.

Notes:

- Keep this record if manual frame inspection was actually done.
- For metadata-only evaluation, mark this as weak evidence because the current dataset cannot independently prove it.

### CmEFYWzpMQc

Verdict: accurate.

Ground truth:

- Yan Wo Thai, Jalan PJU 1/43, Aman Suria, 47301 Petaling Jaya

Evidence:

- Caption explicitly says `Yan Wo Thai, Jalan PJU 1/43, Aman Suria, 47301 Petaling Jaya`.

### DS3v8C4j8dg

Verdict: accurate.

Ground truth:

- Osteria Mozza
- GU:UM
- Uncle Fong Hotpot
- Sushi Zushi
- The Plump Frenchman
- Vios by Blu Kouzina, Raffles City
- Bochinche

Evidence:

- Caption explicitly lists all seven dining spots.

Notes:

- Branch/address is not provided for most entries. The dataset correctly leaves those addresses empty.

### DUExJM_Ep6i

Verdict: accurate.

Ground truth:

- Uokatsu Malaysia, B-0-7, Ground Floor Plaza Damas 3, Jalan Sri Hartamas 1, Sri Hartamas, Kuala Lumpur

Evidence:

- Caption mentions `@uokatsu.malaysia`.
- Caption gives the address: `B-0-7, Ground Floor Plaza Damas 3`, `Jalan Sri Hartamas 1`, Sri Hartamas, Kuala Lumpur.

### DVYIIu-EoyO

Verdict: accurate.

Ground truth:

- Pazonia Italian Street Food @ Amoy, 49 Amoy St, Singapore 069875

Evidence:

- Caption explicitly says `Pazonia Italian Street Food @ Amoy` and `49 Amoy St, Singapore 069875`.

### DPyhLE4kqmp

Verdict: plausible and likely accurate, but full address is not fully in regenerated metadata.

Ground truth:

- Baker's Bench Bakery, 6 Bukit Pasoh Road, Singapore 089820

Evidence:

- Caption explicitly says `Baker's Bench Bakery, Bukit Pasoh Road`.
- Full street number and postal code are not present in regenerated metadata.
- Existing dataset says the full address came from official-site cross-reference.

Notes:

- Keep for product evaluation if web cross-reference is allowed.
- For metadata-only evaluation, expected address should be downgraded to `Bukit Pasoh Road` or marked as externally verified.

### DQHPIx0idZr

Verdict: plausible but not verifiable from regenerated metadata alone.

Ground truth:

- Joong San, 28 Stanley St, #01-01, Singapore 068737

Evidence:

- Caption says this is a new Korean restaurant by Um Yong Baek and lists sundubu dishes.
- Regenerated transcript is not useful.
- Current metadata does not explicitly contain `Joong San` or the Stanley Street address.
- Existing dataset says this was cross-verified from video frames and web coverage.

Notes:

- Keep this only as externally verified/manual ground truth.
- It should not be counted as metadata-derived ground truth.

### DOmzzsxEq_9

Verdict: plausible and likely accurate, but full address is not in regenerated metadata.

Ground truth:

- Fuego Mesa, 681 Race Course Rd, #01-305, Singapore 210681

Evidence:

- Caption tags `@fuegomesa` and says `Farrer Park`.
- Full address is not present in regenerated metadata.
- Existing dataset says address came from web listings.

Notes:

- Keep for product evaluation if web cross-reference is allowed.
- For metadata-only evaluation, expected address should be `Fuego Mesa, Farrer Park` with full address externally verified.

### DQwiEYlEgft

Verdict: unresolved.

Ground truth:

- None yet.

Evidence:

- Caption only says it contains must-try KL food spots.
- Public metadata does not expose the carousel image text or place list.

Notes:

- Existing `needs_manual_review` status is correct.
- Need authenticated carousel extraction, screenshot OCR, or manual browser inspection.

### DG7pUH8yICz

Verdict: accurate.

Ground truth:

- Huen Kee Claypot Chicken Rice, 59, Jln Yew, Pudu, 55100 Kuala Lumpur, Wilayah Persekutuan Kuala Lumpur, Malaysia
- Restoran Kin Kin, No. 6, Jalan Perubatan 4, Taman, Pandan Indah, 55100 Kuala Lumpur, Wilayah Persekutuan, Malaysia
- Lam Kee Wantan Noodles, Jalan Bunga Tanjung 10A, Taman Muda, 56100 Kuala Lumpur, Selangor, Malaysia
- Under The Big Tree Fried Nian Gao, Opposite Restoran Hong Sang: D22, Gerai Staik, Jalan Bunga Tanjung 10, Taman Muda, 68000 Ampang, Selangor, Malaysia
- Nasi Lemak Shop, G10, Oasis Business Center BU4, Changkat Bandar Utama, Bandar Utama, 47800 Petaling Jaya, Selangor, Malaysia
- YUAN, 40, Jalan 20/16a, Taman Paramount, 46300 Petaling Jaya, Selangor, Malaysia

Evidence:

- Caption explicitly lists all six places and addresses.

Notes:

- Current metadata extraction captured five address snippets but missed the `Nasi Lemak Shop` address in the derived address snippet list. The raw caption still contains it, so ground truth is accurate. This is an extractor issue, not a ground-truth issue.

## Recommended Dataset Interpretation

- Use all `verified_from_caption` records as high-confidence ground truth.
- Keep `DFCnSjRyk3C`, `DPyhLE4kqmp`, `DQHPIx0idZr`, and `DOmzzsxEq_9`, but evaluate them under an `externally_verified` or `manual_or_web_verified` bucket.
- Keep `DQwiEYlEgft` excluded from scoring until full carousel OCR/manual inspection is available.
- For strict metadata-only benchmarking, count 10 records as fully supported, 3 as externally supported, and 1 unresolved.
