from services.metadata_normalizer import metadata_candidate_to_runtime_record
from services.public_metadata import MetadataCandidate


def test_metadata_candidate_to_runtime_record_maps_core_fields():
    candidate = MetadataCandidate(
        source="public_html",
        platform="instagram",
        url="https://www.instagram.com/reel/ABC123/",
        success=True,
        title="Best ramen",
        description="📍 Ramen House",
        uploader="alice",
        hashtags=["ramen"],
        content_type="video",
        thumbnail_url="https://example.com/thumb.jpg",
    )

    record = metadata_candidate_to_runtime_record(candidate, source_url=candidate.url)

    assert record["input"]["url"] == candidate.url
    assert record["input"]["platform"] == "instagram"
    assert record["yt_dlp_core"]["title"] == "Best ramen"
    assert record["yt_dlp_core"]["description"] == "📍 Ramen House"
    assert record["yt_dlp_core"]["uploader"] == "alice"
    assert record["yt_dlp_core"]["content_type"] == "video"
    assert record["debug"]["metadata_source"] == "public_html"
