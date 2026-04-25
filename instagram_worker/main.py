from __future__ import annotations

from dataclasses import asdict
import logging
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import config
from services.instagram_pipeline import extract_instagram_metadata_no_cookie_direct


logger = logging.getLogger(__name__)

app = FastAPI(title="Instagram Extraction Worker", version="1.0.0")


class InstagramExtractRequest(BaseModel):
    url: str


class InstagramExtractResponse(BaseModel):
    success: bool
    source: str
    title: str = ""
    description: str = ""
    uploader: Optional[str] = None
    duration: Optional[float] = None
    hashtags: list[str] = []
    content_type: Optional[str] = None
    thumbnail_url: Optional[str] = None
    video_url: Optional[str] = None
    image_urls: list[str] = []
    raw_fields: dict = {}
    error: Optional[str] = None


def _check_auth(auth_header: str | None) -> None:
    if not config.INSTAGRAM_WORKER_TOKEN:
        return
    expected = f"Bearer {config.INSTAGRAM_WORKER_TOKEN}"
    if auth_header != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/extract/instagram", response_model=InstagramExtractResponse)
async def extract_instagram(
    request: InstagramExtractRequest,
    authorization: str | None = Header(None),
) -> InstagramExtractResponse:
    _check_auth(authorization)
    result = await extract_instagram_metadata_no_cookie_direct(request.url)
    candidate = result.get("metadata_candidate")
    if not candidate:
        return InstagramExtractResponse(
            success=False,
            source="instagram_worker",
            error=result.get("error"),
        )
    return InstagramExtractResponse(
        success=True,
        source=candidate.source,
        title=candidate.title,
        description=candidate.description,
        uploader=candidate.uploader,
        duration=candidate.duration,
        hashtags=candidate.hashtags,
        content_type=candidate.content_type,
        thumbnail_url=candidate.thumbnail_url,
        video_url=candidate.video_url,
        image_urls=candidate.image_urls,
        raw_fields=candidate.raw_fields,
        error=candidate.error,
    )
