from pathlib import Path

from services.downloader import detect_platform, is_valid_url, cleanup_files


class TestDetectPlatform:
    def test_instagram_reel_url(self):
        url = "https://www.instagram.com/reel/ABC123/"
        assert detect_platform(url) == "instagram"

    def test_instagram_post_url(self):
        url = "https://www.instagram.com/p/XYZ789/"
        assert detect_platform(url) == "instagram"

    def test_instagram_short_url(self):
        url = "https://instagr.am/reel/ABC123/"
        assert detect_platform(url) == "instagram"

    def test_tiktok_video_url(self):
        url = "https://www.tiktok.com/@user/video/1234567890"
        assert detect_platform(url) == "tiktok"

    def test_tiktok_short_url(self):
        url = "https://vm.tiktok.com/ABC123/"
        assert detect_platform(url) == "tiktok"

    def test_youtube_url(self):
        url = "https://www.youtube.com/watch?v=ABC123"
        assert detect_platform(url) is None

    def test_random_url(self):
        url = "https://example.com/page"
        assert detect_platform(url) is None

    def test_empty_string(self):
        assert detect_platform("") is None


class TestIsValidUrl:
    def test_valid_instagram(self):
        url = "https://www.instagram.com/reel/ABC123/"
        assert is_valid_url(url) is True

    def test_valid_tiktok(self):
        url = "https://www.tiktok.com/@user/video/1234567890"
        assert is_valid_url(url) is True

    def test_invalid_youtube(self):
        url = "https://www.youtube.com/watch?v=ABC123"
        assert is_valid_url(url) is False

    def test_invalid_random(self):
        url = "https://example.com/page"
        assert is_valid_url(url) is False


class TestCleanupFiles:
    def test_cleanup_existing_files(self, tmp_path: Path):
        # Create temp files
        file1 = tmp_path / "test1.txt"
        file2 = tmp_path / "test2.txt"
        file1.write_text("test content 1")
        file2.write_text("test content 2")

        assert file1.exists()
        assert file2.exists()

        cleanup_files(file1, file2)

        assert not file1.exists()
        assert not file2.exists()

    def test_cleanup_nonexistent_files(self, tmp_path: Path):
        nonexistent1 = tmp_path / "nonexistent1.txt"
        nonexistent2 = tmp_path / "nonexistent2.txt"

        # Should not raise any errors
        cleanup_files(nonexistent1, nonexistent2)

    def test_cleanup_mixed_files(self, tmp_path: Path):
        existing_file = tmp_path / "existing.txt"
        existing_file.write_text("test content")
        nonexistent_file = tmp_path / "nonexistent.txt"

        assert existing_file.exists()
        assert not nonexistent_file.exists()

        # Should delete existing and ignore nonexistent
        cleanup_files(existing_file, nonexistent_file)

        assert not existing_file.exists()

    def test_cleanup_none_path(self):
        # Should not raise any errors when None is passed
        cleanup_files(None)
        cleanup_files(None, None)
