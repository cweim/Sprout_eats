from services.ocr import build_video_ocr_timestamps


def test_video_ocr_samples_one_frame_per_second_when_under_cap():
    timestamps = build_video_ocr_timestamps(
        duration_seconds=10,
        estimated_total_frames=300,
        frame_interval_seconds=1,
        max_frames=30,
    )

    assert len(timestamps) == 10
    assert timestamps[0] == 0.5
    assert timestamps[-1] < 10


def test_video_ocr_caps_large_videos():
    timestamps = build_video_ocr_timestamps(
        duration_seconds=60,
        estimated_total_frames=900,
        frame_interval_seconds=1,
        max_frames=30,
    )

    assert len(timestamps) == 30
    assert timestamps[0] == 0.5
    assert timestamps[-1] == 29.5
