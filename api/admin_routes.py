"""Admin dashboard API routes."""

from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

import config
from api.admin_auth import get_current_admin, AdminUser
from database import supabase_repository as repository


router = APIRouter(prefix="/admin/api")


class FeedbackUpdateRequest(BaseModel):
    """Patchable admin triage fields."""
    status: Optional[str] = None
    severity: Optional[str] = None
    admin_notes: Optional[str] = None


@router.get("/config")
async def get_admin_public_config():
    """Public config needed for the admin login page."""
    return {
        "supabase_url": config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
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
