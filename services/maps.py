import asyncio
import logging

import aiohttp
from pathlib import Path
from typing import Optional
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    before_sleep_log,
)

import config

logger = logging.getLogger(__name__)

# Retry configuration
API_RETRY_ATTEMPTS = 3
API_TIMEOUT_SECONDS = 10

STATIC_MAPS_URL = "https://maps.googleapis.com/maps/api/staticmap"


@retry(
    stop=stop_after_attempt(API_RETRY_ATTEMPTS),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type((aiohttp.ClientError, asyncio.TimeoutError)),
    before_sleep=before_sleep_log(logger, logging.WARNING),
    reraise=True,
)
async def generate_map_image(
    places: list[tuple[float, float, str]],  # (lat, lng, label)
    width: int = 600,
    height: int = 400,
    zoom: Optional[int] = None,
) -> Optional[bytes]:
    if not config.GOOGLE_API_KEY:
        raise ValueError("GOOGLE_API_KEY not configured")

    if not places:
        return None

    params = {
        "size": f"{width}x{height}",
        "maptype": "roadmap",
        "key": config.GOOGLE_API_KEY,
    }

    # Add markers
    markers = []
    for i, (lat, lng, label) in enumerate(places):
        # Use different colors for markers, cycle through
        colors = ["red", "blue", "green", "purple", "orange", "yellow"]
        color = colors[i % len(colors)]
        markers.append(f"color:{color}|label:{label[0].upper() if label else str(i+1)}|{lat},{lng}")

    if zoom:
        params["zoom"] = zoom
        # Center on first place if zoom specified
        params["center"] = f"{places[0][0]},{places[0][1]}"

    timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        # Build URL with multiple markers params
        url = STATIC_MAPS_URL + "?"
        url += "&".join(f"{k}={v}" for k, v in params.items())
        for marker in markers:
            url += f"&markers={marker}"

        async with session.get(url) as response:
            if response.status == 200:
                return await response.read()
            return None


async def generate_single_place_map(
    latitude: float,
    longitude: float,
    width: int = 400,
    height: int = 300,
    zoom: int = 15,
) -> Optional[bytes]:
    return await generate_map_image(
        [(latitude, longitude, "")],
        width=width,
        height=height,
        zoom=zoom,
    )
