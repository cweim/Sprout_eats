import asyncio
import logging

import aiohttp
from dataclasses import dataclass
from typing import Optional, Union, overload, Literal
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
async def search_place(
    query: str,
    region: Optional[str] = None,
    max_results: int = 1,
) -> Union[Optional[PlaceResult], list[PlaceResult]]:
    """
    Search for places using Google Places API.

    Args:
        query: Search query text
        region: Optional region code (e.g., "SG" for Singapore)
        max_results: Maximum number of results to return (default 1 for backward compat)

    Returns:
        - If max_results=1: Optional[PlaceResult] (None if no results)
        - If max_results>1: list[PlaceResult] (empty list if no results)
    """
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
                return [] if max_results > 1 else None

            places_data = data["places"][:max_results]
            results = []

            for place in places_data:
                location = place.get("location", {})
                results.append(
                    PlaceResult(
                        name=place.get("displayName", {}).get("text", ""),
                        address=place.get("formattedAddress", ""),
                        latitude=location.get("latitude", 0),
                        longitude=location.get("longitude", 0),
                        place_id=place.get("id", ""),
                    )
                )

            # Backward compatibility: return single result or None when max_results=1
            if max_results == 1:
                return results[0] if results else None

            return results


async def search_places_from_text(text: str, max_results: int = 5) -> list[PlaceResult]:
    """
    Extract potential place names from text and search for them.
    Uses Google Places API to find places from natural language.

    Args:
        text: Text to search for places in
        max_results: Maximum number of results to return (default 5)

    Returns:
        List of PlaceResult objects (up to max_results)
    """
    if not text:
        return []

    # Search the entire text as a query - Google Places API handles natural language well
    results = await search_place(text, max_results=max_results)

    # search_place returns list when max_results > 1
    if isinstance(results, list):
        return results

    # Handle backward compat case (shouldn't happen with max_results=5)
    return [results] if results else []
