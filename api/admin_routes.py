"""Admin dashboard API routes."""

from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

import config
from api.admin_auth import get_current_admin, AdminUser
from database import supabase_repository as repository
from database.supabase_client import get_supabase


router = APIRouter(prefix="/admin/api")


class FeedbackUpdateRequest(BaseModel):
    """Patchable admin triage fields."""
    status: Optional[str] = None
    severity: Optional[str] = None
    admin_notes: Optional[str] = None


class TokenRefreshRequest(BaseModel):
    refresh_token: str


@router.get("/config")
async def get_admin_public_config():
    """Public config needed for the admin login page."""
    return {
        "supabase_url": config.SUPABASE_URL,
    }


@router.post("/refresh")
async def refresh_admin_token(request: TokenRefreshRequest):
    """Exchange a Supabase refresh token for a new access token."""
    supabase = get_supabase()
    try:
        session = supabase.auth.refresh_session(request.refresh_token)
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Token refresh failed: {exc}") from exc

    session_data = getattr(session, "session", None)
    if not session_data:
        raise HTTPException(status_code=401, detail="Token refresh returned no session")

    access_token = getattr(session_data, "access_token", None)
    new_refresh_token = getattr(session_data, "refresh_token", None)
    if not access_token:
        raise HTTPException(status_code=401, detail="Token refresh returned no access token")

    return {
        "access_token": access_token,
        "refresh_token": new_refresh_token,
    }


@router.get("/session")
async def get_admin_session(admin: AdminUser = Depends(get_current_admin)):
    """Validate the current admin session."""
    return {
        "admin": {
            "id": admin.id,
            "email": admin.email,
        }
    }


@router.get("/dashboard/overview")
async def get_dashboard_overview(admin: AdminUser = Depends(get_current_admin)):
    """Return overview metrics for the admin dashboard."""
    return repository.get_dashboard_overview()


@router.get("/feedback")
async def get_feedback_reports(
    status: Optional[str] = None,
    category: Optional[str] = None,
    source: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    """List feedback reports with filters."""
    reports = repository.list_feedback_reports(
        status=status,
        category=category,
        source=source,
        search=search,
        limit=limit,
        offset=offset,
    )
    total = repository.get_feedback_report_count(status=status, category=category, source=source)
    return {
        "reports": reports,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/failed-extractions")
async def get_failed_extractions(
    platform: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    """List links where the bot found 0 places, newest first."""
    rows = repository.get_failed_extractions(platform=platform, limit=limit, offset=offset)
    total = repository.get_failed_extraction_count(platform=platform)
    return {"rows": rows, "total": total, "limit": limit, "offset": offset}


@router.get("/feedback/{report_id}")
async def get_feedback_report(report_id: int, admin: AdminUser = Depends(get_current_admin)):
    """Get a single feedback report with attachments."""
    report = repository.get_feedback_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Feedback report not found")
    return {"report": report}


@router.patch("/feedback/{report_id}")
async def patch_feedback_report(
    report_id: int,
    request: FeedbackUpdateRequest,
    admin: AdminUser = Depends(get_current_admin),
):
    """Update admin triage fields for a feedback report."""
    update_data = {}
    if request.status is not None:
        update_data["status"] = request.status
        if request.status == "resolved":
            from datetime import datetime
            update_data["resolved_at"] = datetime.utcnow().isoformat()
    if request.severity is not None:
        update_data["severity"] = request.severity
    if request.admin_notes is not None:
        update_data["admin_notes"] = request.admin_notes

    report = repository.update_feedback_report(report_id, **update_data)
    if not report:
        raise HTTPException(status_code=404, detail="Feedback report not found")

    repository.create_app_event(
        user_id=None,
        event_name="admin_feedback_updated",
        event_source="admin",
        entity_type="feedback_report",
        entity_id=str(report_id),
        metadata={"admin_email": admin.email, "fields": list(update_data.keys())},
    )
    return {"report": repository.get_feedback_report(report_id)}
