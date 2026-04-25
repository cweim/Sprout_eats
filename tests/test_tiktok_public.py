from services.tiktok_public import extract_tiktok_video_id


def test_extract_tiktok_video_id():
    assert (
        extract_tiktok_video_id("https://www.tiktok.com/@user/video/7510955290930498834")
        == "7510955290930498834"
    )


def test_extract_tiktok_video_id_missing():
    assert extract_tiktok_video_id("https://vm.tiktok.com/ZSabcdefg/") is None
