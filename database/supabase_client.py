"""Supabase client initialization and helpers."""

from pathlib import Path
from typing import Optional
import uuid
from supabase import create_client, Client

import config


_supabase_client: Optional[Client] = None


def get_supabase() -> Client:
    """Get the Supabase client (singleton pattern)."""
    global _supabase_client

    if _supabase_client is None:
        if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
            raise ValueError(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment"
            )

        _supabase_client = create_client(
            config.SUPABASE_URL,
            config.SUPABASE_SERVICE_KEY  # Use service key to bypass RLS
        )

    return _supabase_client


def set_user_context(user_id: int) -> None:
    """
    Set the current user context for RLS policies.

    Note: When using service role key, RLS is bypassed.
    This function is kept for reference if switching to anon key.
    """
    # With service role key, we manually filter by user_id in queries
    # instead of relying on RLS. This is simpler and more explicit.
    pass


def get_storage_bucket():
    """Get the review-photos storage bucket."""
    return get_supabase().storage.from_("review-photos")


def get_feedback_bucket():
    """Get the feedback-attachments storage bucket."""
    return get_supabase().storage.from_("feedback-attachments")


def _upload_bucket_file(bucket, path_prefix: str, file_content: bytes, filename: str) -> tuple[str, str]:
    """Upload bytes to a storage bucket and return public URL and path."""
    ext = Path(filename).suffix or ".jpg"
    unique_name = f"{uuid.uuid4()}{ext}"
    path = f"{path_prefix}/{unique_name}"
    content_type = "image/jpeg"
    if ext.lower() == ".png":
        content_type = "image/png"
    elif ext.lower() == ".webp":
        content_type = "image/webp"

    bucket.upload(
        path=path,
        file=file_content,
        file_options={"content-type": content_type}
    )
    public_url = bucket.get_public_url(path)
    return public_url, path


def upload_photo(user_id: int, review_id: int, file_content: bytes, filename: str) -> str:
    """
    Upload a photo to Supabase Storage.

    Args:
        user_id: Telegram user ID (for path organization)
        review_id: Review ID
        file_content: Raw file bytes
        filename: Original filename

    Returns:
        Public URL of the uploaded photo
    """
    bucket = get_storage_bucket()
    return _upload_bucket_file(bucket, f"{user_id}/{review_id}", file_content, filename)


def upload_feedback_attachment(user_id: int, report_id: int, file_content: bytes, filename: str) -> tuple[str, str]:
    """Upload a feedback attachment to Supabase Storage."""
    bucket = get_feedback_bucket()
    return _upload_bucket_file(bucket, f"feedback/{user_id}/{report_id}", file_content, filename)


def delete_photo(storage_path: str) -> bool:
    """
    Delete a photo from Supabase Storage.

    Args:
        storage_path: Path in the storage bucket

    Returns:
        True if deleted successfully
    """
    if not storage_path:
        return False

    try:
        bucket = get_storage_bucket()
        bucket.remove([storage_path])
        return True
    except Exception:
        return False


def delete_feedback_attachment(storage_path: str) -> bool:
    """Delete a feedback attachment from Supabase Storage."""
    if not storage_path:
        return False

    try:
        bucket = get_feedback_bucket()
        bucket.remove([storage_path])
        return True
    except Exception:
        return False
