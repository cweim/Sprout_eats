# Social Slot Pipeline Evaluation

This report evaluates the current bot-like slot extraction strategy against the cross-platform ground-truth dataset.

## Summary

- `records`: 29
- `total_expected_places`: 56
- `total_extracted_slots`: 54
- `total_slot_matches`: 41
- `slot_precision`: 0.759
- `slot_recall`: 0.732
- `records_with_exact_slot_count`: 21
- `total_suggested_places`: 44
- `total_suggestion_matches`: 40
- `suggestion_precision`: 0.909
- `suggestion_recall`: 0.714
- `records_with_exact_suggestion_count`: 21

## Records

### C09WEZkyfys

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Hong Chang Frog Porridge and BBQ Fish | address=2 Braddell Rd, Singapore 359895 | query=Hong Chang Frog Porridge and BBQ Fish, 2 Braddell Rd, Singapore 359895

Suggestions:

- Hong Chang Frog Porridge and BBQ Fish -> Hong Chang Frog Porridge and BBQ Fish (resolved, high)

### DGQOuG2SrnY

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: NÓMADA | address=1 Keong Saik Rd., 01-05, Singapore 089109 | query=NÓMADA, 1 Keong Saik Rd., 01-05, Singapore 089109

Suggestions:

- NÓMADA -> NÓMADA | Nomadic Spanish Gastronomy | Singapore (resolved, high)

### DTp98aACdL7

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Ganko Sushi | address=9 Penang Rd, 01-01, Singapore 238459 | query=Ganko Sushi, 9 Penang Rd, 01-01, Singapore 238459

Suggestions:

- Ganko Sushi -> Ganko Sushi (resolved, high)

### DEAN_ZMyAtl

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 12
- Extracted slots: 12
- Slot matches: 12
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 12
- Suggestion matches: 12
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: One Fattened Calf Burgers, Shang Hai La Mian Xiao Long Bao, Khao Hom, Sin Heng Kee Porridge, Common Man Coffee Roasters, Fiie’s Cafe, A Hot Hideout

Extracted slots:

- `caption_pin`: One Fattened Calf Burgers | address=Multiple locations | query=One Fattened Calf Burgers
- `caption_pin`: Shang Hai La Mian Xiao Long Bao | address=Multiple locations | query=Shang Hai La Mian Xiao Long Bao
- `caption_pin`: Meadesmoore Steakhouse | address=21A Boon Tat Street Level 2 Located near, Telok Ayer St, 069620 | query=Meadesmoore Steakhouse, 21A Boon Tat Street Level 2 Located near, Telok Ayer St, 069620
- `caption_pin`: FYP (For You People) Cafe - Orchard Central | address=181 Orchard Rd, #04-22 Orchard Central Singapore 238896 | query=FYP (For You People) Cafe - Orchard Central, 181 Orchard Rd, #04-22 Orchard Central Singapore 238896
- `caption_pin`: 千両 sen-ryo (ION Orchard) | address=2 Orchard Turn, #03 - 17/18, Singapore 238801 | query=千両 sen-ryo (ION Orchard), 2 Orchard Turn, #03 - 17/18, Singapore 238801
- `caption_pin`: Hot Duck | address=1 North Point Dr, B2-147, Southwing 768019 | query=Hot Duck, 1 North Point Dr, B2-147, Southwing 768019
- `caption_pin`: Khao Hom | address=Multiple locations | query=Khao Hom
- `caption_pin`: Sin Heng Kee Porridge | address=Multiple locations | query=Sin Heng Kee Porridge
- `caption_pin`: Common Man Coffee Roasters | address=Multiple locations | query=Common Man Coffee Roasters
- `caption_pin`: Nassim Hill Bakery Bistro Bar | address=56 Tanglin Rd, #01-03, Singapore 247964 | query=Nassim Hill Bakery Bistro Bar, 56 Tanglin Rd, #01-03, Singapore 247964
- `caption_pin`: Fiie’s Cafe | address=Multiple locations | query=Fiie’s Cafe
- `caption_pin`: A Hot Hideout | address=Multiple locations | query=A Hot Hideout

Suggestions:

- One Fattened Calf Burgers -> brand_or_multiple_locations (Source says multiple locations; not forcing one branch.)
- Shang Hai La Mian Xiao Long Bao -> brand_or_multiple_locations (Source says multiple locations; not forcing one branch.)
- Meadesmoore Steakhouse -> Meadesmoore Steakhouse (resolved, high)
- FYP (For You People) Cafe - Orchard Central -> FYP (For You People) Cafe - Orchard Central (resolved, high)
- 千両 sen-ryo (ION Orchard) -> 千両 sen-ryo (ION Orchard) (resolved, high)
- Hot Duck -> HOT DUCK (resolved, high)
- Khao Hom -> brand_or_multiple_locations (Source says multiple locations; not forcing one branch.)
- Sin Heng Kee Porridge -> brand_or_multiple_locations (Source says multiple locations; not forcing one branch.)
- Common Man Coffee Roasters -> brand_or_multiple_locations (Source says multiple locations; not forcing one branch.)
- Nassim Hill Bakery Bistro Bar -> Nassim Hill Bakery Bistro Bar (resolved, high)
- Fiie’s Cafe -> brand_or_multiple_locations (Source says multiple locations; not forcing one branch.)
- A Hot Hideout -> brand_or_multiple_locations (Source says multiple locations; not forcing one branch.)

### DFCnSjRyk3C

- Platform: `instagram`
- Ground truth status: `verified_from_video_frame`
- Checked sources: caption, image_ocr, video_ocr
- Expected places: 1
- Extracted slots: 3
- Slot matches: 0
- Missing GT from slots: Lai Heng Fried Kuay Teow & Cooked Food
- Extra slots: @ Monday & gursday Closed od, HarbourFront MRT Station (120m), A) la —
- Suggested places: 1
- Suggestion matches: 0
- Missing GT from suggestions: Lai Heng Fried Kuay Teow & Cooked Food
- Extra suggestions: Gong Yuan Ma La Tang 宫源麻辣烫 @ Century Square
- Unresolved slots: @ Monday & gursday Closed od, HarbourFront MRT Station (120m)
- Multiple-location slots: None

Extracted slots:

- `video_ocr`: @ Monday & gursday Closed od | address=None | query=@ Monday & gursday Closed od, Singapore
- `video_ocr`: HarbourFront MRT Station (120m) | address=None | query=HarbourFront MRT Station (120m), Singapore
- `video_ocr`: A) la — | address=None | query=A) la —, Singapore

Suggestions:

- @ Monday & gursday Closed od -> unresolved (No Google result passed slot validation)
- HarbourFront MRT Station (120m) -> unresolved (No Google result passed slot validation)
- A) la — -> Gong Yuan Ma La Tang 宫源麻辣烫 @ Century Square (resolved, high)

### CmEFYWzpMQc

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Yan Wo Thai | address=Jalan PJU 1/43, Aman Suria, 47301 Petaling Jaya (non-halal) | query=Yan Wo Thai, Jalan PJU 1/43, Aman Suria, 47301 Petaling Jaya (non-halal)

Suggestions:

- Yan Wo Thai -> Yan Wo Thai (resolved, high)

### DS3v8C4j8dg

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 7
- Extracted slots: 7
- Slot matches: 7
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 7
- Suggestion matches: 7
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_list`: Osteria Mozza | address=None | query=Osteria Mozza, Singapore
- `caption_list`: GU:UM | address=None | query=GU:UM, Singapore
- `caption_list`: Uncle Fong Hotpot | address=None | query=Uncle Fong Hotpot, Singapore
- `caption_list`: Sushi Zushi | address=None | query=Sushi Zushi, Singapore
- `caption_list`: The Plump Frenchman | address=None | query=The Plump Frenchman, Singapore
- `caption_list`: Vios by Blu Kouzina | address=None | query=Vios by Blu Kouzina, Singapore
- `caption_list`: Bochinche | address=None | query=Bochinche, Singapore

Suggestions:

- Osteria Mozza -> Osteria Mozza (resolved, high)
- GU:UM -> GUUM Contemporary Grill (resolved, high)
- Uncle Fong Hotpot -> Uncle Fong Hotpot Restaurant (Suntec City) 方叔叔重庆老火锅 (resolved, high)
- Sushi Zushi -> Sushi Zushi @ Funan (resolved, high)
- The Plump Frenchman -> The Plump Frenchman (resolved, high)
- Vios by Blu Kouzina -> VIOS by Blu Kouzina (resolved, high)
- Bochinche -> Bochinche (resolved, high)

### DUExJM_Ep6i

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Uokatsu Malaysia | address=Malaysia Federal Territory of Kuala Lumpur, Kuala Lumpur, Sri Hartamas, Jalan Sri Hartamas 1, B-0-7, Ground Floor Plaza Damas 3 | query=Uokatsu Malaysia, Malaysia Federal Territory of Kuala Lumpur, Kuala Lumpur, Sri Hartamas, Jalan Sri Hartamas 1, B-0-7, Ground Floor Plaza Damas 3

Suggestions:

- Uokatsu Malaysia -> Uokatsu (resolved, high)

### DVYIIu-EoyO

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Pazonia Italian Street Food @ Amoy | address=49 Amoy St, Singapore 069875 | query=Pazonia Italian Street Food @ Amoy, 49 Amoy St, Singapore 069875

Suggestions:

- Pazonia Italian Street Food @ Amoy -> Pazonia Italian Street Food - Amoy Street (resolved, high)

### DPyhLE4kqmp

- Platform: `instagram`
- Ground truth status: `verified_from_caption_and_web`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Baker’s Bench Bakery | address=Bukit Pasoh Road | query=Baker’s Bench Bakery, Bukit Pasoh Road

Suggestions:

- Baker’s Bench Bakery -> Baker's Bench Bakery (resolved, high)

### DQHPIx0idZr

- Platform: `instagram`
- Ground truth status: `verified_from_caption_video_and_web`
- Checked sources: caption, image_ocr, video_ocr, transcription
- Expected places: 1
- Extracted slots: 0
- Slot matches: 0
- Missing GT from slots: Joong San
- Extra slots: None
- Suggested places: 0
- Suggestion matches: 0
- Missing GT from suggestions: Joong San
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- None

### DOmzzsxEq_9

- Platform: `instagram`
- Ground truth status: `verified_from_caption_and_web`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `mention`: Fuegomesa | address=None | query=Fuegomesa, Farrer Park

Suggestions:

- Fuegomesa -> Fuego Mesa (resolved, high)

### DQwiEYlEgft

- Platform: `instagram`
- Ground truth status: `needs_manual_review`
- Checked sources: caption, image_ocr, video_ocr, transcription
- Expected places: 0
- Extracted slots: 0
- Slot matches: 0
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 0
- Suggestion matches: 0
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- None

### DG7pUH8yICz

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 6
- Extracted slots: 6
- Slot matches: 6
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 6
- Suggestion matches: 6
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Huen Kee Claypot Chicken Rice | address=59, Jln Yew, Pudu, 55100 Kuala Lumpur, Wilayah Persekutuan Kuala Lumpur, Malaysia | query=Huen Kee Claypot Chicken Rice, 59, Jln Yew, Pudu, 55100 Kuala Lumpur, Wilayah Persekutuan Kuala Lumpur, Malaysia
- `caption_pin`: Restoran Kin Kin - famous KL Chilli Pan Mee 🌶️ | address=No. 6, Jalan Perubatan 4, Taman, Pandan Indah, 55100 Kuala Lumpur, Wilayah Persekutuan, Malaysia | query=Restoran Kin Kin - famous KL Chilli Pan Mee 🌶️, No. 6, Jalan Perubatan 4, Taman, Pandan Indah, 55100 Kuala Lumpur, Wilayah Persekutuan, Malaysia
- `caption_pin`: Lam Kee Wantan Noodles - Char Siu & Char Siu Pork Rib Wantan Noodles 🍜 | address=Jalan Bunga Tanjung 10A, Taman Muda, 56100 Kuala Lumpur, Selangor, Malaysia | query=Lam Kee Wantan Noodles - Char Siu & Char Siu Pork Rib Wantan Noodles 🍜, Jalan Bunga Tanjung 10A, Taman Muda, 56100 Kuala Lumpur, Selangor, Malaysia
- `caption_pin`: 大树下炸年糕 Under The Big Tree Fried Nian Gao (not on Google maps) | address=Opposite Restoran Hong Sang: D22, Gerai Staik, Jalan Bunga Tanjung 10, Taman Muda, 68000 Ampang, Selangor, Malaysia | query=大树下炸年糕 Under The Big Tree Fried Nian Gao (not on Google maps), Opposite Restoran Hong Sang: D22, Gerai Staik, Jalan Bunga Tanjung 10, Taman Muda, 68000 Ampang, Selangor, Malaysia
- `caption_pin`: Nasi Lemak Shop | address=G10, Oasis Business Center BU4, Changkat Bandar Utama, Bandar Utama, 47800 Petaling Jaya, Selangor, Malaysia | query=Nasi Lemak Shop, G10, Oasis Business Center BU4, Changkat Bandar Utama, Bandar Utama, 47800 Petaling Jaya, Selangor, Malaysia
- `caption_pin`: 汤圆坊 YUAN (巴生港口汤圆 • 麻薯 @ Taman Paramount) | address=40, Jalan 20/16a, Taman Paramount, 46300 Petaling Jaya, Selangor, Malaysia | query=汤圆坊 YUAN (巴生港口汤圆 • 麻薯 @ Taman Paramount), 40, Jalan 20/16a, Taman Paramount, 46300 Petaling Jaya, Selangor, Malaysia

Suggestions:

- Huen Kee Claypot Chicken Rice -> Heun Kee Claypot Chicken Rice (resolved, high)
- Restoran Kin Kin - famous KL Chilli Pan Mee 🌶️ -> Restoran Kin Kin (resolved, high)
- Lam Kee Wantan Noodles - Char Siu & Char Siu Pork Rib Wantan Noodles 🍜 -> Lam Kee Wantan Noodles (resolved, high)
- 大树下炸年糕 Under The Big Tree Fried Nian Gao (not on Google maps) -> 大树下炸年糕 (Kuantan) Nian Gao Under The Tree (resolved, likely)
- Nasi Lemak Shop -> nasi lemak shop @ BU4 (resolved, high)
- 汤圆坊 YUAN (巴生港口汤圆 • 麻薯 @ Taman Paramount) -> TANG YUAN FANG 汤圆坊 (巴生港口汤圆 • 麻薯 @ Taman Paramount) (resolved, likely)

### DGanTwny0za

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Ingleside | address=49 Tras Street | query=Ingleside, 49 Tras Street

Suggestions:

- Ingleside -> Ingleside (resolved, high)

### C8mQS7aS2lT

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Cenzo Restaurant | address=81 Club St, Singapore 069449 | query=Cenzo Restaurant, 81 Club St, Singapore 069449

Suggestions:

- Cenzo Restaurant -> Cenzo: Australian Italian Restaurant & Bar (Club st) (resolved, likely)

### DNR_3IeSIAE

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption, image_ocr, video_ocr
- Expected places: 1
- Extracted slots: 4
- Slot matches: 0
- Missing GT from slots: Ah Fai Dry Laksa
- Extra slots: his store inyGeylang ae if, IVeS oneJofsthelbestichy aa, After changing WED=MON| 4iawker Converts Japanese, 3:00am)
- Suggested places: 0
- Suggestion matches: 0
- Missing GT from suggestions: Ah Fai Dry Laksa
- Extra suggestions: None
- Unresolved slots: his store inyGeylang ae if, IVeS oneJofsthelbestichy aa, After changing WED=MON| 4iawker Converts Japanese, 3:00am)
- Multiple-location slots: None

Extracted slots:

- `video_ocr`: his store inyGeylang ae if | address=None | query=his store inyGeylang ae if
- `video_ocr`: IVeS oneJofsthelbestichy aa | address=None | query=IVeS oneJofsthelbestichy aa
- `video_ocr`: After changing WED=MON| 4iawker Converts Japanese | address=None | query=After changing WED=MON| 4iawker Converts Japanese
- `video_ocr`: 3:00am) | address=None | query=3:00am)

Suggestions:

- his store inyGeylang ae if -> unresolved (No Google result passed slot validation)
- IVeS oneJofsthelbestichy aa -> unresolved (No Google result passed slot validation)
- After changing WED=MON| 4iawker Converts Japanese -> unresolved (No Google result passed slot validation)
- 3:00am) -> unresolved (No Google result passed slot validation)

### DSPJ3DIgUza

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Cloudfields | address=None | query=Cloudfields, Singapore

Suggestions:

- Cloudfields -> Cloudfields (resolved, high)

### DCsxHAqSIby

- Platform: `instagram`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 0
- Suggestion matches: 0
- Missing GT from suggestions: Huevos
- Extra suggestions: None
- Unresolved slots: @huevossg New Bahru TQ 4 BLESSING MY BELLY U GUYS R AMAZING 🤝 @newbahru
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: @huevossg New Bahru TQ 4 BLESSING MY BELLY U GUYS R AMAZING 🤝 @newbahru | address=None | query=@huevossg New Bahru TQ 4 BLESSING MY BELLY U GUYS R AMAZING 🤝 @newbahru, Singapore

Suggestions:

- @huevossg New Bahru TQ 4 BLESSING MY BELLY U GUYS R AMAZING 🤝 @newbahru -> unresolved (No Google result passed slot validation)

### ZS9JMgdjP

- Platform: `tiktok`
- Ground truth status: `verified_from_title_and_video_ocr`
- Checked sources: caption, image_ocr, video_ocr, transcription
- Expected places: 1
- Extracted slots: 0
- Slot matches: 0
- Missing GT from slots: Sushi Muni Surry Hills
- Extra slots: None
- Suggested places: 0
- Suggestion matches: 0
- Missing GT from suggestions: Sushi Muni Surry Hills
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- None

### ZS9JMT48Y

- Platform: `tiktok`
- Ground truth status: `needs_manual_review`
- Checked sources: caption, image_ocr, video_ocr, transcription
- Expected places: 0
- Extracted slots: 0
- Slot matches: 0
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 0
- Suggestion matches: 0
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- None

### ZS9JrUgd7

- Platform: `tiktok`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 2
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: Kong Madam 콩마담 20 Tan Quee Lan St
- Suggested places: 2
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: Kong Madam 콩마담
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Kong Madam 콩마담 20 Tan Quee Lan St, #01-... | address=BEST KOREAN FOOD IN SG!! 💯💯💯 📍Kong Madam 콩마담 20 Tan Quee Lan St, #01-02/03 Guoco Midtown II, Singapore 188107 Opening hours as per Google: Mon-Sat: 11 am–3 pm, 5–10 pm Sun: 11am-10pm | query=Kong Madam 콩마담 20 Tan Quee Lan St, #01-..., BEST KOREAN FOOD IN SG!! 💯💯💯 📍Kong Madam 콩마담 20 Tan Quee Lan St, #01-02/03 Guoco Midtown II, Singapore 188107 Opening hours as per Google: Mon-Sat: 11 am–3 pm, 5–10 pm Sun: 11am-10pm
- `caption_pin`: Kong Madam 콩마담 20 Tan Quee Lan St | address=#01-02/03 Guoco Midtown II, Singapore 188107 Opening hours as per Google: Mon-Sat: 11 am–3 pm, 5–10 pm Sun: 11am-10pm | query=Kong Madam 콩마담 20 Tan Quee Lan St, #01-02/03 Guoco Midtown II, Singapore 188107 Opening hours as per Google: Mon-Sat: 11 am–3 pm, 5–10 pm Sun: 11am-10pm

Suggestions:

- Kong Madam 콩마담 20 Tan Quee Lan St, #01-... -> Kong Madam 콩마담 (resolved, high)
- Kong Madam 콩마담 20 Tan Quee Lan St -> Kong Madam 콩마담 (resolved, high)

### ZS9JfsvpD

- Platform: `tiktok`
- Ground truth status: `needs_manual_review`
- Checked sources: caption, image_ocr, video_ocr, transcription
- Expected places: 0
- Extracted slots: 0
- Slot matches: 0
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 0
- Suggestion matches: 0
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- None

### ZS9Jfwkb4

- Platform: `tiktok`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 2
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: Kong Madam 콩마담 20 Tan Quee Lan St
- Suggested places: 2
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: Kong Madam 콩마담
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Kong Madam 콩마담 20 Tan Quee Lan St, #01-... | address=BEST KOREAN FOOD IN SG!! 💯💯💯 📍Kong Madam 콩마담 20 Tan Quee Lan St, #01-02/03 Guoco Midtown II, Singapore 188107 Opening hours as per Google: Mon-Sat: 11 am–3 pm, 5–10 pm Sun: 11am-10pm | query=Kong Madam 콩마담 20 Tan Quee Lan St, #01-..., BEST KOREAN FOOD IN SG!! 💯💯💯 📍Kong Madam 콩마담 20 Tan Quee Lan St, #01-02/03 Guoco Midtown II, Singapore 188107 Opening hours as per Google: Mon-Sat: 11 am–3 pm, 5–10 pm Sun: 11am-10pm
- `caption_pin`: Kong Madam 콩마담 20 Tan Quee Lan St | address=#01-02/03 Guoco Midtown II, Singapore 188107 Opening hours as per Google: Mon-Sat: 11 am–3 pm, 5–10 pm Sun: 11am-10pm | query=Kong Madam 콩마담 20 Tan Quee Lan St, #01-02/03 Guoco Midtown II, Singapore 188107 Opening hours as per Google: Mon-Sat: 11 am–3 pm, 5–10 pm Sun: 11am-10pm

Suggestions:

- Kong Madam 콩마담 20 Tan Quee Lan St, #01-... -> Kong Madam 콩마담 (resolved, high)
- Kong Madam 콩마담 20 Tan Quee Lan St -> Kong Madam 콩마담 (resolved, high)

### ZS9JftuDa

- Platform: `tiktok`
- Ground truth status: `verified_from_caption_and_video_ocr`
- Checked sources: caption
- Expected places: 10
- Extracted slots: 1
- Slot matches: 0
- Missing GT from slots: Umai, Sweedy, Bao Er Cafe, Kobashi, Dawn, Syip, Wang Lee Cafe, Scramble Egg Rice Keisuke, Frying Fish Club, A Beautiful Day Cafe Tea
- Extra slots: ✨ No specific ranking
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: Sweedy, Bao Er Cafe, Kobashi, Dawn, Syip, Wang Lee Cafe, Scramble Egg Rice Keisuke, Frying Fish Club, A Beautiful Day Cafe Tea
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: ✨ No specific ranking | address=just the best of the best! 💖 1. Umai 📍128 Beach Road #01-05, Guoco Midtown, Market, 189771 2. Sweedy 📍377 Hougang St. 32, #01-32, Singapore 530377 3. Bao Er Cafe 📍400 Balestier Rd, #02-01, Singapore 329802 4. Kobashi 📍79 South Bridge Rd, #01-00, Singapore 058709 5. Dawn 📍78 South Bridge Rd, Singapore 058708 6. Syip 📍79 Owen Rd, Singapore 218895 7. Wang Lee Cafe 📍92 Lor 4 Toa Payoh, #01-274, Singapore 310092 8. Scramble Egg Rice Keisuke 📍201 Victoria St, #04-01 Bugis+, Singapore 188067 9. Frying Fish Club 📍140 Owen Rd, Singapore 218940 10. A beautiful cafe 📍 2 Paya Lebar Rd, #01-09 PLQ PARKSIDE below, Parkplace Residences, Singapore 409053 | query=✨ No specific ranking, just the best of the best! 💖 1. Umai 📍128 Beach Road #01-05, Guoco Midtown, Market, 189771 2. Sweedy 📍377 Hougang St. 32, #01-32, Singapore 530377 3. Bao Er Cafe 📍400 Balestier Rd, #02-01, Singapore 329802 4. Kobashi 📍79 South Bridge Rd, #01-00, Singapore 058709 5. Dawn 📍78 South Bridge Rd, Singapore 058708 6. Syip 📍79 Owen Rd, Singapore 218895 7. Wang Lee Cafe 📍92 Lor 4 Toa Payoh, #01-274, Singapore 310092 8. Scramble Egg Rice Keisuke 📍201 Victoria St, #04-01 Bugis+, Singapore 188067 9. Frying Fish Club 📍140 Owen Rd, Singapore 218940 10. A beautiful cafe 📍 2 Paya Lebar Rd, #01-09 PLQ PARKSIDE below, Parkplace Residences, Singapore 409053

Suggestions:

- ✨ No specific ranking -> Umai Artisanal Udon Bar (resolved, likely)

### ZS9JPRm49

- Platform: `tiktok`
- Ground truth status: `verified_from_video_ocr_and_caption`
- Checked sources: caption, image_ocr, video_ocr
- Expected places: 1
- Extracted slots: 3
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: nM, BEEF CHEEK
- Suggested places: 1
- Suggestion matches: 0
- Missing GT from suggestions: Bronzo Pasta Bar
- Extra suggestions: Sippysip.s
- Unresolved slots: nM, BEEF CHEEK
- Multiple-location slots: None

Extracted slots:

- `video_ocr`: S | address=None | query=S
- `video_ocr`: nM | address=None | query=nM
- `video_ocr`: BEEF CHEEK | address=None | query=BEEF CHEEK

Suggestions:

- S -> Sippysip.s (resolved, high)
- nM -> unresolved (No Google result passed slot validation)
- BEEF CHEEK -> unresolved (No Google result passed slot validation)

### ZS9JfqUr5

- Platform: `tiktok`
- Ground truth status: `needs_manual_review`
- Checked sources: caption, image_ocr, video_ocr, transcription
- Expected places: 0
- Extracted slots: 0
- Slot matches: 0
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 0
- Suggestion matches: 0
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- None

### ZS9JP9BAA

- Platform: `tiktok`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 1
- Missing GT from slots: None
- Extra slots: None
- Suggested places: 1
- Suggestion matches: 1
- Missing GT from suggestions: None
- Extra suggestions: None
- Unresolved slots: None
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: Hankang Pocha 991 Serangoon Rd | address=Singapore 328149 . . | query=Hankang Pocha 991 Serangoon Rd, Singapore 328149 . .

Suggestions:

- Hankang Pocha 991 Serangoon Rd -> HANKANG POCHA 한강포차 (Serangoon Rd) (resolved, likely)

### ZS9JP2pjV

- Platform: `tiktok`
- Ground truth status: `verified_from_caption`
- Checked sources: caption
- Expected places: 1
- Extracted slots: 1
- Slot matches: 0
- Missing GT from slots: Lavi Taco Maxwell
- Extra slots: 5 Kadayanallur St
- Suggested places: 0
- Suggestion matches: 0
- Missing GT from suggestions: Lavi Taco Maxwell
- Extra suggestions: None
- Unresolved slots: 5 Kadayanallur St
- Multiple-location slots: None

Extracted slots:

- `caption_pin`: 5 Kadayanallur St | address=01-09, Singapore 069183 ... | query=5 Kadayanallur St, 01-09, Singapore 069183 ...

Suggestions:

- 5 Kadayanallur St -> unresolved (No Google result passed slot validation)
