"""Admin authentication for the separate /admin dashboard."""

from dataclasses import dataclass
from typing import Optional

from fastapi import Depends, Header, HTTPException

from database.supabase_client import get_supabase
from database import supabase_repository as repository


@dataclass
class AdminUser:
    """Authenticated admin principal."""
    id: str
    email: str


def _extract_email(user_response) -> Optional[str]:
    """Pull the email field out of Supabase get_user() response."""
    user = getattr(user_response, "user", None)
    if not user:
        return None
    email = getattr(user, "email", None)
    if email:
        return str(email).lower()
    user_dict = getattr(user, "model_dump", None)
    if callable(user_dict):
        dumped = user.model_dump()
        if dumped.get("email"):
            return str(dumped["email"]).lower()
    return None


def _extract_id(user_response) -> Optional[str]:
    """Pull the user id field out of Supabase get_user() response."""
    user = getattr(user_response, "user", None)
    if not user:
        return None
    user_id = getattr(user, "id", None)
    if user_id:
        return str(user_id)
    user_dict = getattr(user, "model_dump", None)
    if callable(user_dict):
        dumped = user.model_dump()
        if dumped.get("id"):
            return str(dumped["id"])
    return None


async def get_current_admin(authorization: Optional[str] = Header(None)) -> AdminUser:
    """Validate a Supabase Auth bearer token and confirm the user is allowlisted."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing admin bearer token")

    access_token = authorization.split(" ", 1)[1].strip()
    if not access_token:
        raise HTTPException(status_code=401, detail="Missing admin bearer token")

    supabase = get_supabase()
    try:
        user_response = supabase.auth.get_user(access_token)
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Invalid admin session: {exc}") from exc

    email = _extract_email(user_response)
    user_id = _extract_id(user_response)
    if not email or not user_id:
        raise HTTPException(status_code=401, detail="Admin session missing user identity")

    if not repository.is_admin_email(email):
        raise HTTPException(status_code=403, detail="Not an allowlisted admin")

    return AdminUser(id=user_id, email=email)


AdminDependency = Depends(get_current_admin)
