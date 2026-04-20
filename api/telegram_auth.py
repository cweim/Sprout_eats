"""
Telegram WebApp authentication.

Validates initData from Telegram Mini App and manages user sessions.
See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
"""

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qs, unquote

from fastapi import Header, HTTPException, Depends

import config
from database.supabase_client import get_supabase


@dataclass
class TelegramUser:
    """Telegram user data from initData."""
    id: int
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    language_code: Optional[str] = None


def validate_init_data(init_data: str, bot_token: str = None) -> dict:
    """
    Validate Telegram initData hash.

    Args:
        init_data: Raw initData string from Telegram WebApp
        bot_token: Bot token (defaults to config)

    Returns:
        Parsed data dict if valid

    Raises:
        ValueError: If validation fails
    """
    if not init_data:
        raise ValueError("Empty initData")

    bot_token = bot_token or config.TELEGRAM_BOT_TOKEN
    if not bot_token:
        raise ValueError("Bot token not configured")

    # Parse query string
    parsed = parse_qs(init_data, keep_blank_values=True)

    # Extract hash
    received_hash = parsed.get("hash", [None])[0]
    if not received_hash:
        raise ValueError("Missing hash in initData")

    # Build data-check-string (sorted key=value pairs, excluding hash)
    data_pairs = []
    for key, values in parsed.items():
        if key != "hash":
            # Use first value
            value = values[0] if values else ""
            data_pairs.append(f"{key}={value}")

    data_pairs.sort()
    data_check_string = "\n".join(data_pairs)

    # Compute expected hash
    # secret_key = HMAC_SHA256(bot_token, "WebAppData")
    secret_key = hmac.new(
        b"WebAppData",
        bot_token.encode(),
        hashlib.sha256
    ).digest()

    # hash = HMAC_SHA256(secret_key, data_check_string)
    expected_hash = hmac.new(
        secret_key,
        data_check_string.encode(),
        hashlib.sha256
    ).hexdigest()

    # Compare hashes
    if not hmac.compare_digest(received_hash, expected_hash):
        raise ValueError("Invalid hash")

    # Check auth_date (optional: reject if too old)
    auth_date = parsed.get("auth_date", [None])[0]
    if auth_date:
        auth_timestamp = int(auth_date)
        # Allow 24 hours
        if time.time() - auth_timestamp > 86400:
            raise ValueError("Auth data expired")

    return parsed


def parse_user(init_data: str) -> TelegramUser:
    """
    Parse and validate initData, extract user info.

    Args:
        init_data: Raw initData string

    Returns:
        TelegramUser object

    Raises:
        ValueError: If validation fails or user data missing
    """
    parsed = validate_init_data(init_data)

    # Extract user JSON
    user_json = parsed.get("user", [None])[0]
    if not user_json:
        raise ValueError("No user in initData")

    user_data = json.loads(unquote(user_json))

    return TelegramUser(
        id=user_data["id"],
        username=user_data.get("username"),
        first_name=user_data.get("first_name"),
        last_name=user_data.get("last_name"),
        language_code=user_data.get("language_code"),
    )


def get_or_create_user(user: TelegramUser) -> TelegramUser:
    """
    Get or create user in database.

    Args:
        user: TelegramUser from initData

    Returns:
        User (same object, database record created/updated)
    """
    supabase = get_supabase()

    # Upsert user
    supabase.table("users").upsert({
        "id": user.id,
        "username": user.username,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "language_code": user.language_code,
        "updated_at": "now()",
    }).execute()

    return user


def get_local_dev_user() -> Optional[TelegramUser]:
    """Return configured local-dev user when browser auth fallback is enabled."""
    if not config.LOCAL_DEV_AUTH:
        return None

    if not config.DEV_TELEGRAM_USER_ID:
        raise ValueError("LOCAL_DEV_AUTH is enabled but DEV_TELEGRAM_USER_ID is not set")

    try:
        user_id = int(config.DEV_TELEGRAM_USER_ID)
    except ValueError as exc:
        raise ValueError("DEV_TELEGRAM_USER_ID must be a numeric Telegram user ID") from exc

    return TelegramUser(
        id=user_id,
        username="local_dev",
        first_name="Local",
        last_name="Dev",
    )


async def get_current_user(
    x_telegram_init_data: str = Header(None, alias="X-Telegram-Init-Data")
) -> TelegramUser:
    """
    FastAPI dependency to get current authenticated user.

    Usage:
        @router.get("/places")
        async def get_places(user: TelegramUser = Depends(get_current_user)):
            ...
    """
    if not x_telegram_init_data:
        try:
            dev_user = get_local_dev_user()
            if dev_user:
                return get_or_create_user(dev_user)
        except ValueError as e:
            raise HTTPException(
                status_code=500,
                detail=f"Local dev auth misconfigured: {e}"
            )

        raise HTTPException(
            status_code=401,
            detail="Missing X-Telegram-Init-Data header"
        )

    try:
        user = parse_user(x_telegram_init_data)
        return get_or_create_user(user)
    except ValueError as e:
        raise HTTPException(
            status_code=401,
            detail=f"Invalid authentication: {e}"
        )


# For bot handlers (not web requests)
def get_user_from_telegram_id(telegram_id: int) -> TelegramUser:
    """
    Get or create user by Telegram ID (for bot handlers).

    Args:
        telegram_id: Telegram user ID

    Returns:
        TelegramUser
    """
    supabase = get_supabase()

    # Check if user exists
    result = supabase.table("users").select("*").eq("id", telegram_id).execute()

    if result.data:
        row = result.data[0]
        return TelegramUser(
            id=row["id"],
            username=row.get("username"),
            first_name=row.get("first_name"),
            last_name=row.get("last_name"),
            language_code=row.get("language_code"),
        )

    # Create minimal user record
    supabase.table("users").insert({
        "id": telegram_id,
    }).execute()

    return TelegramUser(id=telegram_id)
