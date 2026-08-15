import asyncio

import pytest

from services.tiktok_pipeline import run_tiktok_place_pipeline


@pytest.mark.asyncio
async def test_run_tiktok_place_pipeline_times_out_metadata(monkeypatch):
    async def never_finishes(url: str):
        await asyncio.Event().wait()

    monkeypatch.setattr(
        "services.tiktok_pipeline.config.BOT_METADATA_TIMEOUT_SECONDS",
        0.01,
    )
    for extractor in (
        "extract_tiktok_public_html",
        "extract_tiktok_oembed",
        "extract_tiktok_api",
        "extract_tiktok_ytdlp",
    ):
        monkeypatch.setattr(f"services.tiktok_pipeline.{extractor}", never_finishes)

    result = await run_tiktok_place_pipeline("https://www.tiktok.com/@user/video/123")

    assert result["status"] == "timed_out"
    assert result["timed_out_stage"] == "metadata"
    assert result["places"] == []
