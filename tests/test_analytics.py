from datetime import timezone

import pytest

from api.analytics import add_period_comparison, parse_analytics_range, sanitise_event_metadata


def test_sanitise_event_metadata_allowlists_dimensions_and_bounds_strings():
    clean = sanitise_event_metadata({
        "surface": "discover",
        "google_place_id": "x" * 200,
        "url": "https://private.example/post",
        "caption": "private content",
        "nested": {"no": "objects"},
    })

    assert clean == {"surface": "discover", "google_place_id": "x" * 120}


def test_parse_analytics_range_normalises_utc_and_rejects_invalid_ranges():
    start, end = parse_analytics_range("2026-08-01", "2026-08-15T00:00:00Z")
    assert start.tzinfo == timezone.utc
    assert end.tzinfo == timezone.utc

    with pytest.raises(ValueError, match="start must be before end"):
        parse_analytics_range("2026-08-15", "2026-08-01")

    with pytest.raises(ValueError, match="366 days"):
        parse_analytics_range("2024-01-01", "2026-01-01")


def test_period_comparison_handles_growth_decline_and_zero_baseline():
    result = add_period_comparison(
        {"kpis": {"users": 15, "rate": 0.4, "new_metric": 3}},
        {"kpis": {"users": 10, "rate": 0.5, "new_metric": 0}},
    )

    assert result["comparison"]["users"]["percent"] == 50.0
    assert result["comparison"]["rate"]["absolute"] == pytest.approx(-0.1)
    assert result["comparison"]["new_metric"]["percent"] is None
