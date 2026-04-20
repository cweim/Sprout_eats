from services.transcriber import evaluate_transcript_quality


def test_evaluate_transcript_quality_rejects_noisy_misdetected_text():
    text = (
        "Sekarang hari ini baju P micro, diambil kar met 집 dalam kar molar "
        "ll奇itated. Ini adalah hubungan celimwan selama Period, ger able "
        "Sidankan sempat bagi bumur krajah."
    )

    quality = evaluate_transcript_quality(text)

    assert quality.label == "poor"
    assert quality.looks_english is False


def test_evaluate_transcript_quality_accepts_clean_english_food_transcript():
    text = (
        "Follow me to this hidden gem in Singapore. This roadside shop is "
        "authentic and full of nostalgia. Their porridge is good and you "
        "should order the omelette too."
    )

    quality = evaluate_transcript_quality(text)

    assert quality.label == "good"
    assert quality.looks_english is True
