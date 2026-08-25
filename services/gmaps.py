"""Google Maps URL parsing and place resolution."""

import logging
import re
from typing import Optional
from urllib.parse import parse_qs, unquote_plus, urlparse

import aiohttp

logger = logging.getLogger(__name__)

_GMAPS_PATTERNS = (
    "share.google/",
    "maps.google.com",
    "google.com/maps",
    "goo.gl/maps",
)


def is_google_maps_url(url: str) -> bool:
    return any(p in url for p in _GMAPS_PATTERNS)


async def resolve_google_maps_url(url: str) -> Optional["PlaceResult"]:  # type: ignore[name-defined]
    """Follow redirects on a Google Maps URL, extract place_id or name, return PlaceResult."""
    from services.places import fetch_place_by_id, search_place

    canonical = await _follow_redirects(url)
    logger.info("gmaps canonical url: %s", canonical[:200])

    # 1. Try place_id from query param (query_place_id=...)
    parsed = urlparse(canonical)
    qs = parse_qs(parsed.query)
    if "query_place_id" in qs:
        result = await fetch_place_by_id(qs["query_place_id"][0])
        if result:
            return result

    # 2. Try !1s{PLACE_ID} in the data segment of the path
    place_id = _extract_place_id_from_data(canonical)
    if place_id:
        result = await fetch_place_by_id(place_id)
        if result:
            return result

    # 3. Fallback: extract name + coords, use text search
    name, lat, lng = _extract_name_and_coords(canonical)
    if name:
        return await search_place(name, lat=lat, lng=lng, max_results=1)

    return None


async def _follow_redirects(url: str, timeout_s: float = 10.0) -> str:
    """Follow HTTP redirects and return the final URL."""
    headers = {"User-Agent": "Mozilla/5.0 (compatible; Sprout/1.0)"}
    timeout = aiohttp.ClientTimeout(total=timeout_s)
    try:
        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            async with session.get(url, allow_redirects=True, max_redirects=10) as resp:
                return str(resp.url)
    except Exception as exc:
        logger.warning("gmaps redirect follow failed for %s: %s", url, exc)
        return url


def _extract_place_id_from_data(url: str) -> Optional[str]:
    """Extract Google Place ID from !1s{ID} in the URL data segment."""
    m = re.search(r"!1s([A-Za-z0-9:_\-]+)", url)
    if m:
        candidate = m.group(1)
        # Valid place IDs are >10 chars and don't start with hex address markers
        if len(candidate) > 10 and not candidate.startswith("0x"):
            return candidate
    return None


def _extract_name_and_coords(
    url: str,
) -> tuple[Optional[str], Optional[float], Optional[float]]:
    """Extract place name and coordinates from a canonical Google Maps URL."""
    name: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None

    # /maps/place/NAME/@LAT,LNG,...
    m = re.search(r"/maps/place/([^/@?]+)", url)
    if m:
        name = unquote_plus(m.group(1).replace("+", " "))

    # @LAT,LNG,ZOOM
    m2 = re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", url)
    if m2:
        lat, lng = float(m2.group(1)), float(m2.group(2))

    # ?q=NAME or ?query=NAME fallback
    if not name:
        parsed = urlparse(url)
        qs = parse_qs(parsed.query)
        q = qs.get("q") or qs.get("query")
        if q:
            name = q[0]

    return name, lat, lng
