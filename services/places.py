import asyncio
import logging

import aiohttp
from dataclasses import dataclass
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

# New Places API endpoint
PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"


@dataclass
class PlaceResult:
    name: str
    address: str
    latitude: float
    longitude: float
    place_id: str


@retry(
    stop=stop_after_attempt(API_RETRY_ATTEMPTS),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type((aiohttp.ClientError, asyncio.TimeoutError)),
    before_sleep=before_sleep_log(logger, logging.WARNING),
    reraise=True,
)
async def search_place(query: str, region: Optional[str] = None) -> Optional[PlaceResult]:
    if not config.GOOGLE_API_KEY:
        raise ValueError("GOOGLE_API_KEY not configured")

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.GOOGLE_API_KEY,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.id",
    }

    body = {
        "textQuery": query,
    }

    if region:
        body["regionCode"] = region

    timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(PLACES_TEXT_SEARCH_URL, headers=headers, json=body) as response:
            data = await response.json()

            if "places" not in data or not data["places"]:
                return None

            place = data["places"][0]
            location = place.get("location", {})

            return PlaceResult(
                name=place.get("displayName", {}).get("text", ""),
                address=place.get("formattedAddress", ""),
                latitude=location.get("latitude", 0),
                longitude=location.get("longitude", 0),
                place_id=place.get("id", ""),
            )


async def search_places_from_text(text: str, max_results: int = 5) -> list[PlaceResult]:
    """
    Extract potential place names from text and search for them.
    This is a simple approach - looks for capitalized phrases that might be place names.
    """
    if not text:
        return []

    # Simple heuristic: search the entire text as a query
    # Google Places API is good at finding places from natural language
    result = await search_place(text)
    if result:
        return [result]

    return []
