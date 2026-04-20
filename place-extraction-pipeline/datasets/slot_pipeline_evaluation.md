# Slot Pipeline Evaluation

This report evaluates the slot-based extraction strategy against the current ground-truth dataset.

## Summary

- `records`: 14
- `resolve_google`: True
- `total_expected_places`: 35
- `total_extracted_slots`: 33
- `total_slot_matches`: 33
- `slot_precision`: 1.0
- `slot_recall`: 0.943
- `records_with_exact_slot_count`: 12
- `total_suggested_places`: 33
- `total_suggestion_matches`: 33
- `suggestion_precision`: 1.0
- `suggestion_recall`: 0.943
- `records_with_exact_suggestion_count`: 11

## Records

### C09WEZkyfys

- Ground truth status: `verified_from_caption`
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

Selected suggestions:

- Hong Chang Frog Porridge and BBQ Fish -> Hong Chang Frog Porridge and BBQ Fish (resolved, high)

### DGQOuG2SrnY

- Ground truth status: `verified_from_caption`
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

Selected suggestions:

- NÓMADA -> NÓMADA | Nomadic Spanish Gastronomy | Singapore (resolved, high)

### DTp98aACdL7

- Ground truth status: `verified_from_caption`
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

Selected suggestions:

- Ganko Sushi -> Ganko Sushi (resolved, high)

### DEAN_ZMyAtl

- Ground truth status: `verified_from_caption`
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

Selected suggestions:

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

- Ground truth status: `verified_from_video_frame`
- Expected places: 1
- Extracted slots: 0
- Slot matches: 0
- Missing GT from slots: Lai Heng Fried Kuay Teow & Cooked Food
- Extra slots: None

Extracted slots:

- None

### CmEFYWzpMQc

- Ground truth status: `verified_from_caption`
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

Selected suggestions:

- Yan Wo Thai -> Yan Wo Thai (resolved, high)

### DS3v8C4j8dg

- Ground truth status: `verified_from_caption`
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

Selected suggestions:

- Osteria Mozza -> Osteria Mozza (resolved, high)
- GU:UM -> GUUM Contemporary Grill (resolved, high)
- Uncle Fong Hotpot -> Uncle Fong Hotpot Restaurant (Suntec City) 方叔叔重庆老火锅 (resolved, high)
- Sushi Zushi -> Sushi Zushi @ Funan (resolved, high)
- The Plump Frenchman -> The Plump Frenchman (resolved, high)
- Vios by Blu Kouzina -> VIOS by Blu Kouzina (resolved, high)
- Bochinche -> Bochinche (resolved, high)

### DUExJM_Ep6i

- Ground truth status: `verified_from_caption`
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

Selected suggestions:

- Uokatsu Malaysia -> Uokatsu (resolved, high)

### DVYIIu-EoyO

- Ground truth status: `verified_from_caption`
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

Selected suggestions:

- Pazonia Italian Street Food @ Amoy -> Pazonia Italian Street Food - Amoy Street (resolved, high)

### DPyhLE4kqmp

- Ground truth status: `verified_from_caption_and_web`
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

Selected suggestions:

- Baker’s Bench Bakery -> Baker's Bench Bakery (resolved, high)

### DQHPIx0idZr

- Ground truth status: `verified_from_caption_video_and_web`
- Expected places: 1
- Extracted slots: 0
- Slot matches: 0
- Missing GT from slots: Joong San
- Extra slots: None

Extracted slots:

- None

### DOmzzsxEq_9

- Ground truth status: `verified_from_caption_and_web`
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

Selected suggestions:

- Fuegomesa -> Fuego Mesa (resolved, high)

### DQwiEYlEgft

- Ground truth status: `needs_manual_review`
- Expected places: 0
- Extracted slots: 0
- Slot matches: 0
- Missing GT from slots: None
- Extra slots: None

Extracted slots:

- None

### DG7pUH8yICz

- Ground truth status: `verified_from_caption`
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

Selected suggestions:

- Huen Kee Claypot Chicken Rice -> Heun Kee Claypot Chicken Rice (resolved, high)
- Restoran Kin Kin - famous KL Chilli Pan Mee 🌶️ -> Restoran Kin Kin (resolved, high)
- Lam Kee Wantan Noodles - Char Siu & Char Siu Pork Rib Wantan Noodles 🍜 -> Lam Kee Wantan Noodles (resolved, high)
- 大树下炸年糕 Under The Big Tree Fried Nian Gao (not on Google maps) -> 大树下炸年糕 (Kuantan) Nian Gao Under The Tree (resolved, likely)
- Nasi Lemak Shop -> nasi lemak shop @ BU4 (resolved, high)
- 汤圆坊 YUAN (巴生港口汤圆 • 麻薯 @ Taman Paramount) -> TANG YUAN FANG 汤圆坊 (巴生港口汤圆 • 麻薯 @ Taman Paramount) (resolved, likely)
