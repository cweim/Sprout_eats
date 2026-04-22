import asyncio
import logging
import re

import aiohttp
from dataclasses import dataclass, field
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

DEFAULT_PLACE_RESULT_LIMIT = 12
DEFAULT_SEARCH_LOCATION_BIAS_RADIUS_METERS = 12000.0


# Words to ignore when checking word overlap (common words that don't indicate a match)
STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
    "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
    "did", "will", "would", "could", "should", "may", "might", "must", "shall", "can",
    "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they",
    "my", "your", "his", "her", "its", "our", "their", "what", "which", "who", "whom",
    "food", "restaurant", "cafe", "bar", "place", "spot", "eat", "eating", "try",
    "best", "good", "great", "amazing", "delicious", "yummy", "tasty", "nice",
    "singapore", "malaysia", "sg", "kl", "kuala", "lumpur",  # Common location words
}

GENERIC_NAME_TOKENS = {
    "restaurant",
    "cafe",
    "coffee",
    "bar",
    "bistro",
    "kitchen",
    "grill",
    "house",
    "eatery",
    "food",
    "dining",
    "bakery",
    "dessert",
    "pizza",
    "ramen",
    "sushi",
    "brunch",
    "stall",
    "shop",
}

# Only keep food/drink venue categories from Google Places results.
FOOD_PLACE_TYPES = {
    "restaurant",
    "cafe",
    "coffee_shop",
    "bakery",
    "bar",
    "pub",
    "meal_takeaway",
    "meal_delivery",
    "brunch_restaurant",
    "breakfast_restaurant",
    "lunch_restaurant",
    "diner",
    "fast_food_restaurant",
    "pizza_restaurant",
    "seafood_restaurant",
    "steak_house",
    "sushi_restaurant",
    "ramen_restaurant",
    "chinese_restaurant",
    "japanese_restaurant",
    "korean_restaurant",
    "thai_restaurant",
    "vietnamese_restaurant",
    "indian_restaurant",
    "italian_restaurant",
    "mexican_restaurant",
    "american_restaurant",
    "mediterranean_restaurant",
    "middle_eastern_restaurant",
    "hamburger_restaurant",
    "hot_pot_restaurant",
    "sandwich_shop",
    "ice_cream_shop",
    "dessert_shop",
}

# Retry configuration
API_RETRY_ATTEMPTS = 3
API_TIMEOUT_SECONDS = 10

# New Places API endpoint
PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"


def infer_location_context(text: str) -> Optional[str]:
    """Infer source location from post text without using user/device location."""
    lowered = (text or "").lower()
    if "petaling jaya" in lowered:
        return "Petaling Jaya"
    if "kuala lumpur" in lowered or re.search(r"\bkl\b", lowered):
        return "Kuala Lumpur"
    if "selangor" in lowered:
        return "Selangor"
    if "malaysia" in lowered:
        return "Malaysia"
    if "singapore" in lowered or re.search(r"\bsg\b", lowered):
        return "Singapore"
    return None


def extract_location_queries(text: str) -> list[tuple[str, str]]:
    """
    Extract potential location queries from text using multiple strategies.
    Returns list of (query, source_type) tuples in priority order.

    Strategies:
    1. Lines with 📍 emoji (most reliable)
    2. Place names in special brackets 《》【】
    3. Lines with address patterns (postal codes, street names)
    4. @mentions (Instagram business handles)
    """
    queries = []  # List of (query, source_type)

    if not text:
        return queries

    lines = text.split('\n')
    location_context = infer_location_context(text)

    # Strategy 1: Extract lines with 📍 emoji
    for line in lines:
        if '📍' in line:
            # Get text after 📍
            location = line.split('📍', 1)[1].strip()
            # Remove common suffixes (hours, phone numbers)
            location = re.split(r'[.!]?\s*(?:Opens?|Hours?|Tel|Phone|WhatsApp|⏰|📞)', location, flags=re.IGNORECASE)[0].strip()
            # Remove trailing hashtags
            location = re.split(r'\s*#\w+', location)[0].strip()
            # Remove leading colon/dash if present
            location = re.sub(r'^[:\-–—]\s*', '', location).strip()
            if location and len(location) > 3:
                queries.append((location, 'location_pin'))

    # Strategy 2: Extract place names in special brackets 《》【】「」
    bracket_names = re.findall(r'[《【「]([^》】」]+)[》】」]', text)
    for name in bracket_names:
        name = name.strip()
        if name and len(name) > 2:
            queries.append((name, 'bracket_name'))

    # Strategy 3: Look for address patterns (if no 📍 found)
    if not queries:
        # Singapore postal code pattern
        sg_addresses = re.findall(r'[^#\n]*(?:Singapore|SG)\s*\d{6}[^#\n]*', text, re.IGNORECASE)
        for addr in sg_addresses:
            clean = addr.strip()
            if clean and len(clean) > 10:
                queries.append((clean, 'address'))

        # Malaysia postal code pattern
        my_addresses = re.findall(r'[^#\n]*\d{5}\s+(?:Selangor|Kuala\s*Lumpur|Penang|Johor|Perak)[^#\n]*', text, re.IGNORECASE)
        for addr in my_addresses:
            clean = addr.strip()
            if clean and len(clean) > 10:
                queries.append((clean, 'address'))

    # Strategy 4: Extract @mentions (Instagram business handles)
    mentions = re.findall(r'@([\w.]+)', text)
    for mention in mentions:
        # Skip common non-business mentions
        if mention.lower() not in {'instagram', 'facebook', 'tiktok', 'youtube'}:
            # Convert handle to searchable name (replace dots/underscores with spaces)
            name = re.sub(r'[._]', ' ', mention).strip()
            if name and len(name) > 2:
                # Use only source-derived location context, never user/device location.
                context = f" {location_context}" if location_context else ""
                queries.append((f"{name}{context} restaurant", 'mention'))

    return queries


def extract_text_chunks(text: str, chunk_size: int = 150) -> list[str]:
    """
    Split text into chunks for searching, respecting sentence boundaries.
    """
    if not text:
        return []

    # Remove hashtags first
    clean_text = re.sub(r'#\w+', '', text).strip()

    # Split by sentences/newlines
    sentences = re.split(r'[.\n]+', clean_text)

    chunks = []
    current_chunk = ""

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue

        if len(current_chunk) + len(sentence) < chunk_size:
            current_chunk += " " + sentence if current_chunk else sentence
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = sentence

    if current_chunk:
        chunks.append(current_chunk.strip())

    return chunks


def has_word_overlap(source_text: str, place_name: str, min_overlap: int = 1) -> bool:
    """
    Check if a place name has meaningful word overlap with source text.

    Args:
        source_text: The original search text (caption/transcript)
        place_name: The returned place name from Google
        min_overlap: Minimum number of overlapping words required

    Returns:
        True if there's meaningful overlap, False otherwise
    """
    # Normalize texts
    source_words = set(re.findall(r'\b\w+\b', source_text.lower()))
    place_words = set(re.findall(r'\b\w+\b', place_name.lower()))

    # Remove stopwords
    source_words -= STOPWORDS
    place_words -= STOPWORDS

    # Remove short words (1-2 chars)
    source_words = {w for w in source_words if len(w) > 2}
    place_words = {w for w in place_words if len(w) > 2}

    # Check overlap
    overlap = source_words & place_words
    return len(overlap) >= min_overlap


def normalize_text(text: str) -> str:
    """Normalize text for exact phrase matching."""
    normalized = re.sub(r"[^a-z0-9]+", " ", text.lower())
    return " ".join(normalized.split())


def tokenize_meaningful_words(text: str) -> list[str]:
    """Return normalized meaningful tokens used for relevance checks."""
    tokens = re.findall(r"\b\w+\b", text.lower())
    return [
        token for token in tokens
        if token not in STOPWORDS and len(token) > 2
    ]


def get_meaningful_overlap(source_text: str, candidate_text: str) -> set[str]:
    """Return meaningful token overlap between source text and a candidate field."""
    source_words = set(tokenize_meaningful_words(source_text))
    candidate_words = set(tokenize_meaningful_words(candidate_text))
    return source_words & candidate_words


def contains_exact_phrase(source_text: str, phrase: str) -> bool:
    """Check whether a normalized phrase appears exactly in the normalized source."""
    normalized_source = normalize_text(source_text)
    normalized_phrase = normalize_text(phrase)

    if not normalized_source or not normalized_phrase:
        return False

    return f" {normalized_phrase} " in f" {normalized_source} "


def has_address_pattern(text: str) -> bool:
    """Detect whether the source text contains an address-like pattern."""
    return bool(
        re.search(r"(?:Singapore|SG)\s*\d{6}", text, re.IGNORECASE)
        or re.search(
            r"\d{5}\s+(?:Selangor|Kuala\s*Lumpur|Penang|Johor|Perak)",
            text,
            re.IGNORECASE,
        )
        or re.search(r"\b(?:road|rd|street|st|avenue|ave|lane|ln|drive|dr)\b", text, re.IGNORECASE)
    )


def is_distinctive_single_token(token: str) -> bool:
    """Allow one-word venue names only when the token is specific enough."""
    return len(token) >= 4 and token not in GENERIC_NAME_TOKENS and token not in STOPWORDS


SOURCE_CONFIDENCE_BONUS = {
    "location_pin": 36,
    "bracket_name": 30,
    "address": 24,
    "mention": 18,
    "chunk": 10,
    "fallback": 6,
}


def get_confidence_label(score: int) -> str:
    """Convert a numeric score into a user-facing confidence tier."""
    if score >= 85:
        return "high"
    if score >= 60:
        return "likely"
    return "possible"


def get_confidence_reason(
    source_type: str,
    exact_name_match: bool,
    distinctive_single_word: bool,
    name_overlap_count: int,
    address_overlap_count: int,
) -> str:
    """Summarize the strongest reason this candidate was kept."""
    source_reason = {
        "location_pin": "from a pinned location line",
        "bracket_name": "from a highlighted place name",
        "address": "from an address clue",
        "mention": "from a tagged account",
        "chunk": "from transcript or caption context",
        "fallback": "from a broad text search",
    }.get(source_type, "from reel context")

    if exact_name_match:
        return f"Exact place-name match {source_reason}"
    if distinctive_single_word:
        return f"Distinctive one-word venue match {source_reason}"
    if name_overlap_count >= 2:
        return f"Strong name overlap {source_reason}"
    if name_overlap_count == 1:
        return f"Name overlap {source_reason}"
    if address_overlap_count >= 1:
        return f"Address-supported match {source_reason}"
    return f"Likely venue match {source_reason}"


@dataclass
class CandidateAssessment:
    """Structured confidence evaluation for a place candidate."""
    accepted: bool
    score: int
    confidence_label: str
    reason: str


def is_relevant_candidate(
    result,
    source_text: str,
    source_type: str = "smart",
    allow_address_match: bool = False,
) -> bool:
    """
    Validate a candidate place against the original source text.

    The validator prefers exact normalized name matches, supports distinctive
    one-word venue names, and is stricter for chunk/fallback derived matches.
    """
    if not source_text:
        return False

    if contains_exact_phrase(source_text, result.name):
        return True

    name_tokens = tokenize_meaningful_words(result.name)
    name_overlap = get_meaningful_overlap(source_text, result.name)

    if len(name_tokens) == 1 and len(name_overlap) == 1:
        token = name_tokens[0]
        if token in name_overlap and is_distinctive_single_token(token):
            return True

    required_name_overlap = 2 if source_type in {"chunk", "fallback"} else 1
    if len(name_overlap) >= required_name_overlap:
        return True

    if allow_address_match and has_address_pattern(source_text):
        address_overlap = get_meaningful_overlap(source_text, result.address)
        required_address_overlap = 2 if source_type in {"chunk", "fallback"} else 1
        if len(address_overlap) >= required_address_overlap:
            return True

    return False


def assess_candidate(
    result,
    source_text: str,
    source_type: str = "smart",
    allow_address_match: bool = False,
) -> CandidateAssessment:
    """Score a candidate place and decide whether it should be kept."""
    if not source_text:
        return CandidateAssessment(False, 0, "possible", "No source text")

    exact_name_match = contains_exact_phrase(source_text, result.name)
    name_tokens = tokenize_meaningful_words(result.name)
    name_overlap = get_meaningful_overlap(source_text, result.name)
    address_overlap = get_meaningful_overlap(source_text, result.address)

    distinctive_single_word = False
    if len(name_tokens) == 1 and len(name_overlap) == 1:
        token = name_tokens[0]
        distinctive_single_word = token in name_overlap and is_distinctive_single_token(token)

    passes = False
    if exact_name_match or distinctive_single_word:
        passes = True
    else:
        required_name_overlap = 2 if source_type in {"chunk", "fallback"} else 1
        if len(name_overlap) >= required_name_overlap:
            passes = True
        elif allow_address_match and has_address_pattern(source_text):
            required_address_overlap = 2 if source_type in {"chunk", "fallback"} else 1
            if len(address_overlap) >= required_address_overlap:
                passes = True

    if not passes:
        return CandidateAssessment(False, 0, "possible", "Weak match")

    score = SOURCE_CONFIDENCE_BONUS.get(source_type, 14)
    if exact_name_match:
        score += 44
    if distinctive_single_word:
        score += 30
    score += min(len(name_overlap), 3) * 12
    if allow_address_match and has_address_pattern(source_text):
        score += min(len(address_overlap), 2) * 6
    if result.rating:
        score += min(int(result.rating), 5)
    if result.rating_count:
        score += 3 if result.rating_count >= 50 else 1

    reason = get_confidence_reason(
        source_type,
        exact_name_match,
        distinctive_single_word,
        len(name_overlap),
        len(address_overlap),
    )
    confidence_label = get_confidence_label(score)
    return CandidateAssessment(True, score, confidence_label, reason)


def filter_results_by_relevance(
    results: list,
    source_text: str,
    require_overlap: bool = True,
    source_type: str = "smart",
    allow_address_match: bool = False,
) -> list:
    """
    Filter search results to only include relevant matches.

    Args:
        results: List of PlaceResult objects
        source_text: Original search text
        require_overlap: If True, filter out results with no word overlap

    Returns:
        Filtered list of PlaceResult objects
    """
    if not require_overlap:
        return results

    filtered = []
    for result in results:
        assessment = assess_candidate(
            result,
            source_text,
            source_type=source_type,
            allow_address_match=allow_address_match,
        )
        if assessment.accepted:
            result.confidence_score = assessment.score
            result.confidence_label = assessment.confidence_label
            result.confidence_reason = assessment.reason
            result.matched_source_type = source_type
            filtered.append(result)
            logger.debug("Kept result: %s", result.name)
        else:
            logger.debug("Filtered out: %s (not relevant to source)", result.name)

    return filtered


@dataclass
class PlaceResult:
    name: str
    address: str
    latitude: float
    longitude: float
    place_id: str
    types: list[str] = field(default_factory=list)  # e.g., ["restaurant", "food"]
    rating: Optional[float] = None  # 1.0-5.0
    rating_count: Optional[int] = None
    price_level: Optional[str] = None  # "FREE", "INEXPENSIVE", etc.
    opening_hours: Optional[str] = None  # First line of weekday descriptions
    confidence_score: int = 0
    confidence_label: str = "possible"
    confidence_reason: Optional[str] = None
    matched_query: Optional[str] = None
    matched_source_type: Optional[str] = None


def is_food_place(types: list[str]) -> bool:
    """Return True when a Google Places result is food/drink related."""
    return any(place_type in FOOD_PLACE_TYPES for place_type in types)


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
    lat: Optional[float] = None,
    lng: Optional[float] = None,
) -> Union[Optional[PlaceResult], list[PlaceResult]]:
    """
    Search for places using Google Places API.

    Args:
        query: Search query text
        region: Optional region code (e.g., "SG" for Singapore)
        max_results: Maximum number of results to return (default 1 for backward compat)
        lat: Optional latitude for Google Places location bias
        lng: Optional longitude for Google Places location bias

    Returns:
        - If max_results=1: Optional[PlaceResult] (None if no results)
        - If max_results>1: list[PlaceResult] (empty list if no results)
    """
    if not config.GOOGLE_API_KEY:
        raise ValueError("GOOGLE_API_KEY not configured")

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.GOOGLE_API_KEY,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.id,places.types,places.rating,places.userRatingCount,places.priceLevel,places.regularOpeningHours",
    }

    body = {
        "textQuery": query,
    }

    if region:
        body["regionCode"] = region

    if lat is not None and lng is not None:
        body["locationBias"] = {
            "circle": {
                "center": {
                    "latitude": lat,
                    "longitude": lng,
                },
                "radius": DEFAULT_SEARCH_LOCATION_BIAS_RADIUS_METERS,
            }
        }

    timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(PLACES_TEXT_SEARCH_URL, headers=headers, json=body) as response:
            data = await response.json()

            if "places" not in data or not data["places"]:
                return [] if max_results > 1 else None

            results = []

            for place in data["places"]:
                location = place.get("location", {})
                types = place.get("types", [])

                if not is_food_place(types):
                    logger.debug(
                        "Filtered out non-food result: %s (%s)",
                        place.get("displayName", {}).get("text", ""),
                        ",".join(types),
                    )
                    continue

                # Parse price level (remove PRICE_LEVEL_ prefix)
                raw_price = place.get("priceLevel", "")
                price_level = raw_price.replace("PRICE_LEVEL_", "") if raw_price else None

                # Parse opening hours (first line of weekday descriptions)
                hours_data = place.get("regularOpeningHours", {})
                weekday_desc = hours_data.get("weekdayDescriptions", [])
                opening_hours = weekday_desc[0] if weekday_desc else None

                results.append(
                    PlaceResult(
                        name=place.get("displayName", {}).get("text", ""),
                        address=place.get("formattedAddress", ""),
                        latitude=location.get("latitude", 0),
                        longitude=location.get("longitude", 0),
                        place_id=place.get("id", ""),
                        types=types,
                        rating=place.get("rating"),
                        rating_count=place.get("userRatingCount"),
                        price_level=price_level,
                        opening_hours=opening_hours,
                    )
                )

                if len(results) >= max_results:
                    break

            # Backward compatibility: return single result or None when max_results=1
            if max_results == 1:
                return results[0] if results else None

            return results


async def search_places_from_text(
    text: str,
    max_results: int = DEFAULT_PLACE_RESULT_LIMIT,
    use_smart_extraction: bool = True,
    validate_results: bool = True,
) -> list[PlaceResult]:
    """
    Extract potential place names from text and search for them.
    Uses smart extraction strategies for better accuracy.

    Args:
        text: Text to search for places in
        max_results: Maximum number of results to return (default 5)
        use_smart_extraction: Use 📍/address/mention extraction (default True)
        validate_results: Filter results by word overlap (default True)

    Returns:
        List of PlaceResult objects (up to max_results)
    """
    if not text:
        return []

    all_results_by_place_id: dict[str, PlaceResult] = {}

    def keep_candidate(candidate: PlaceResult) -> None:
        existing = all_results_by_place_id.get(candidate.place_id)
        if existing is None or candidate.confidence_score > existing.confidence_score:
            all_results_by_place_id[candidate.place_id] = candidate

    if use_smart_extraction:
        # Strategy 1: Try extracted location queries first (📍, addresses, @mentions)
        location_queries = extract_location_queries(text)
        query_strs = [q[0] for q in location_queries[:3]]  # For logging
        logger.info(f"Extracted {len(location_queries)} location queries: {query_strs}")

        per_query_limit = max(5, min(max_results, 12))

        for query, source_type in location_queries[:8]:  # Limit noisy fan-out
            results = await search_place(query, max_results=per_query_limit)

            # For @mentions, don't require validation (business name may differ from handle)
            skip_validation = source_type == 'mention'
            allow_address_match = source_type == "address"

            if isinstance(results, list):
                for r in results:
                    if skip_validation or not validate_results:
                        r.confidence_score = 90 if skip_validation else 70
                        r.confidence_label = get_confidence_label(r.confidence_score)
                        r.confidence_reason = (
                            "Matched from a tagged account"
                            if skip_validation else "Accepted without strict validation"
                        )
                        r.matched_query = query
                        r.matched_source_type = source_type
                        keep_candidate(r)
                    else:
                        assessment = assess_candidate(
                            r,
                            text,
                            source_type=source_type,
                            allow_address_match=allow_address_match,
                        )
                        if assessment.accepted:
                            r.confidence_score = assessment.score
                            r.confidence_label = assessment.confidence_label
                            r.confidence_reason = assessment.reason
                            r.matched_query = query
                            r.matched_source_type = source_type
                            keep_candidate(r)
            elif results:
                if skip_validation or not validate_results:
                    results.confidence_score = 90 if skip_validation else 70
                    results.confidence_label = get_confidence_label(results.confidence_score)
                    results.confidence_reason = (
                        "Matched from a tagged account"
                        if skip_validation else "Accepted without strict validation"
                    )
                    results.matched_query = query
                    results.matched_source_type = source_type
                    keep_candidate(results)
                else:
                    assessment = assess_candidate(
                        results,
                        text,
                        source_type=source_type,
                        allow_address_match=allow_address_match,
                    )
                    if assessment.accepted:
                        results.confidence_score = assessment.score
                        results.confidence_label = assessment.confidence_label
                        results.confidence_reason = assessment.reason
                        results.matched_query = query
                        results.matched_source_type = source_type
                        keep_candidate(results)

            # Stop if we have enough results
            if len(all_results_by_place_id) >= max_results:
                break

        # If smart extraction found results, return them
        if all_results_by_place_id:
            ranked = sorted(
                all_results_by_place_id.values(),
                key=lambda r: (r.confidence_score, r.rating or 0, r.rating_count or 0),
                reverse=True,
            )
            return ranked[:max_results]

        # Strategy 2: Try text chunks if no location queries found results
        chunks = extract_text_chunks(text, chunk_size=150)
        logger.info(f"Trying {len(chunks)} text chunks")

        for chunk in chunks[:4]:
            results = await search_place(chunk, max_results=per_query_limit)
            if isinstance(results, list):
                for r in results:
                    if not validate_results:
                        r.confidence_score = 55
                        r.confidence_label = get_confidence_label(r.confidence_score)
                        r.confidence_reason = "Accepted from transcript or caption context"
                        r.matched_query = chunk
                        r.matched_source_type = "chunk"
                        keep_candidate(r)
                    else:
                        assessment = assess_candidate(
                            r,
                            text,
                            source_type="chunk",
                            allow_address_match=False,
                        )
                        if assessment.accepted:
                            r.confidence_score = assessment.score
                            r.confidence_label = assessment.confidence_label
                            r.confidence_reason = assessment.reason
                            r.matched_query = chunk
                            r.matched_source_type = "chunk"
                            keep_candidate(r)
            elif results:
                if not validate_results:
                    results.confidence_score = 55
                    results.confidence_label = get_confidence_label(results.confidence_score)
                    results.confidence_reason = "Accepted from transcript or caption context"
                    results.matched_query = chunk
                    results.matched_source_type = "chunk"
                    keep_candidate(results)
                else:
                    assessment = assess_candidate(
                        results,
                        text,
                        source_type="chunk",
                        allow_address_match=False,
                    )
                    if assessment.accepted:
                        results.confidence_score = assessment.score
                        results.confidence_label = assessment.confidence_label
                        results.confidence_reason = assessment.reason
                        results.matched_query = chunk
                        results.matched_source_type = "chunk"
                        keep_candidate(results)

            if len(all_results_by_place_id) >= max_results:
                break

        if all_results_by_place_id:
            ranked = sorted(
                all_results_by_place_id.values(),
                key=lambda r: (r.confidence_score, r.rating or 0, r.rating_count or 0),
                reverse=True,
            )
            return ranked[:max_results]

    # Fallback: Search the entire text as a query (strict validation)
    logger.info("Falling back to full text search")
    results = await search_place(text[:500], max_results=max_results)  # Limit text length

    if isinstance(results, list):
        fallback_results = results
    elif results:
        fallback_results = [results]
    else:
        fallback_results = []

    # Strict validation for fallback results
    if validate_results and fallback_results:
        fallback_results = filter_results_by_relevance(
            fallback_results,
            text,
            require_overlap=True,
            source_type="fallback",
            allow_address_match=False,
        )

    if not validate_results:
        for result in fallback_results:
            result.confidence_score = 45
            result.confidence_label = get_confidence_label(result.confidence_score)
            result.confidence_reason = "Accepted from a broad text search"
            result.matched_query = text[:500]
            result.matched_source_type = "fallback"
    else:
        for result in fallback_results:
            result.matched_query = text[:500]

    ranked = sorted(
        fallback_results,
        key=lambda r: (r.confidence_score, r.rating or 0, r.rating_count or 0),
        reverse=True,
    )
    return ranked[:max_results]
