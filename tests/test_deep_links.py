from urllib.parse import parse_qs, urlparse

import pytest

from services.deep_links import build_start_param, build_webapp_url


def test_build_webapp_url_preserves_existing_query_and_encodes_params():
    url = build_webapp_url(
        "https://example.com/app?theme=dark",
        "review",
        42,
        pn="A & B Cafe",
    )
    query = parse_qs(urlparse(url).query)
    assert query == {
        "theme": ["dark"],
        "startapp": ["review_42"],
        "pn": ["A & B Cafe"],
    }


def test_google_place_ids_remain_string_targets():
    assert build_start_param("gplace", "ChIJ_ab-cd") == "gplace_ChIJ_ab-cd"


def test_rejects_unknown_target_and_whitespace_values():
    with pytest.raises(ValueError):
        build_start_param("unknown", "1")
    with pytest.raises(ValueError):
        build_start_param("place", "bad value")
