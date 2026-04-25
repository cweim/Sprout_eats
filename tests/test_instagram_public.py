from services.instagram_public import extract_instagram_shortcode


def test_extract_instagram_shortcode_from_reel():
    assert extract_instagram_shortcode("https://www.instagram.com/reel/ABC123/?igsh=1") == "ABC123"


def test_extract_instagram_shortcode_from_post():
    assert extract_instagram_shortcode("https://www.instagram.com/p/XYZ789/") == "XYZ789"
