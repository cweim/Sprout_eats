from services.public_metadata import extract_basic_meta_from_html


def test_extract_basic_meta_from_html_uses_og_tags():
    html = """
    <html>
      <head>
        <meta property="og:title" content="Tokyo Food Crawl" />
        <meta property="og:description" content="📍 Sushi Place\\nBest omakase in town #tokyo #food" />
        <meta property="og:image" content="https://example.com/thumb.jpg" />
        <meta property="og:video" content="https://example.com/video.mp4" />
        <meta name="author" content="foodhunter" />
      </head>
    </html>
    """
    candidate = extract_basic_meta_from_html(html, "https://example.com", "instagram")
    assert candidate.success is True
    assert candidate.title == "Tokyo Food Crawl"
    assert "Sushi Place" in candidate.description
    assert candidate.uploader == "foodhunter"
    assert candidate.thumbnail_url == "https://example.com/thumb.jpg"
    assert candidate.video_url == "https://example.com/video.mp4"
    assert candidate.hashtags == ["tokyo", "food"]


def test_extract_basic_meta_from_html_returns_failure_when_empty():
    candidate = extract_basic_meta_from_html("<html><head></head></html>", "https://example.com", "instagram")
    assert candidate.success is False
    assert candidate.error is not None
