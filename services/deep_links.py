"""Single contract for Telegram Mini App deep links."""

from urllib.parse import urlencode


SUPPORTED_TARGETS = {"review", "place", "gplace", "activity", "group"}


def build_start_param(target: str, value: object) -> str:
    """Build the compact start parameter consumed by the Mini App router."""
    if target not in SUPPORTED_TARGETS:
        raise ValueError(f"Unsupported Mini App target: {target}")
    clean_value = str(value).strip()
    if not clean_value or any(ch.isspace() for ch in clean_value):
        raise ValueError("Deep-link values must be non-empty and contain no whitespace")
    return f"{target}_{clean_value}"


def build_webapp_url(base_url: str, target: str, value: object, **params: object) -> str:
    """Build a Web App URL without hand-concatenating unescaped query values."""
    if not base_url:
        return ""
    query = {"startapp": build_start_param(target, value)}
    query.update({key: str(val) for key, val in params.items() if val is not None})
    separator = "&" if "?" in base_url else "?"
    return f"{base_url}{separator}{urlencode(query)}"
