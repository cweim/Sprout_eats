"""Admin dashboard API routes."""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

import config
from api.admin_auth import get_current_admin, AdminUser
from database import supabase_repository as repository
from database.supabase_client import get_supabase
from api.analytics import add_period_comparison, parse_analytics_range


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
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
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


@router.get("/analytics/overview")
async def get_analytics_overview(
    start: Optional[str] = None,
    end: Optional[str] = None,
    source: Optional[str] = None,
    city: Optional[str] = None,
    admin: AdminUser = Depends(get_current_admin),
):
    """Return date-filtered product analytics with previous-period comparison."""
    try:
        start_dt, end_dt = parse_analytics_range(start, end)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    duration = end_dt - start_dt
    current = repository.get_admin_analytics_snapshot(start_dt, end_dt, source=source, city=city)
    previous = repository.get_admin_analytics_snapshot(start_dt - duration, start_dt, source=source, city=city)
    return add_period_comparison(current, previous)


@router.get("/analytics/retention")
async def get_analytics_retention(
    weeks: int = 8,
    admin: AdminUser = Depends(get_current_admin),
):
    return {"cohorts": repository.get_admin_retention_cohorts(max(1, min(weeks, 26)))}


@router.get("/insights/rankings")
async def get_insight_rankings(
    metric: str = "overall",
    city: Optional[str] = None,
    cuisine: Optional[str] = None,
    limit: int = 10,
    min_reviews: int = 1,
    admin: AdminUser = Depends(get_current_admin),
):
    if metric not in {"overall", "food", "vibe", "value", "loved", "saves"}:
        raise HTTPException(status_code=400, detail="Unsupported ranking metric")
    rows = repository.get_admin_restaurant_rankings(
        metric=metric,
        city=city,
        cuisine=cuisine,
        limit=max(1, min(limit, 100)),
        min_reviews=max(1, min(min_reviews, 100)),
    )
    return {
        "rankings": rows,
        "metric": metric,
        "preview_minimum": min_reviews,
        "publication_minimum": 10,
        "methodology": "Public reviews only; one latest review per diner and restaurant; Bayesian prior weight 5.",
    }


@router.get("/content/posts")
async def get_content_posts(
    platform: Optional[str] = None, account: Optional[str] = None,
    city: Optional[str] = None, cuisine: Optional[str] = None,
    start: Optional[datetime] = None, end: Optional[datetime] = None,
    sort: str = "saves", limit: int = 50, offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    if sort not in {"saves", "visits", "reviews", "score", "recent"}:
        raise HTTPException(status_code=400, detail="Unsupported content sort")
    if start and end and start >= end:
        raise HTTPException(status_code=400, detail="start must be before end")
    page_size, page_offset = max(1, min(limit, 100)), max(0, offset)
    rows, total = repository.get_admin_content_posts(
        platform=platform, account=account, city=city, cuisine=cuisine,
        start=start, end=end, sort=sort, limit=page_size, offset=page_offset,
    )
    return {"posts": rows, "total": total, "limit": page_size, "offset": page_offset}


@router.get("/content/accounts")
async def get_content_accounts(
    platform: Optional[str] = None, search: Optional[str] = None,
    start: Optional[datetime] = None, end: Optional[datetime] = None,
    sort: str = "saves", limit: int = 50, offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    if sort not in {"saves", "visits", "reviews", "score"}:
        raise HTTPException(status_code=400, detail="Unsupported account sort")
    if start and end and start >= end:
        raise HTTPException(status_code=400, detail="start must be before end")
    page_size, page_offset = max(1, min(limit, 100)), max(0, offset)
    rows, total = repository.get_admin_source_accounts(
        platform=platform, search=search, start=start, end=end,
        sort=sort, limit=page_size, offset=page_offset,
    )
    return {"accounts": rows, "total": total, "limit": page_size, "offset": page_offset}


@router.get("/content/posts/{content_source_id}")
async def get_content_post_detail(
    content_source_id: int,
    admin: AdminUser = Depends(get_current_admin),
):
    detail = repository.get_admin_content_post_detail(content_source_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Content post not found")
    return {"post": detail}


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


@router.get("/users")
async def get_users(
    limit: int = 100,
    offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    """List all users with place/review counts."""
    users = repository.list_users_with_stats(limit=limit, offset=offset)
    return {"users": users, "limit": limit, "offset": offset}


@router.get("/places")
async def get_places(
    platform: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    """List recently saved places across all users."""
    places = repository.list_recent_places(platform=platform, limit=limit, offset=offset)
    total = repository.get_recent_places_count(platform=platform)
    return {"places": places, "total": total, "limit": limit, "offset": offset}


@router.get("/save-activity")
async def get_save_activity(
    platform: Optional[str] = None,
    city: Optional[str] = None,
    search: Optional[str] = None,
    user_id: Optional[int] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    limit: int = 100,
    offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    """Return the chronological save feed across every Sprout user."""
    if start and end and start >= end:
        raise HTTPException(status_code=400, detail="start must be before end")
    page_size = max(1, min(limit, 100))
    page_offset = max(0, offset)
    rows, total = repository.get_admin_save_activity(
        platform=platform,
        city=city,
        search=search,
        user_id=user_id,
        start=start,
        end=end,
        limit=page_size,
        offset=page_offset,
    )
    return {"places": rows, "total": total, "limit": page_size, "offset": page_offset}


@router.get("/users/{user_id}/places")
async def get_user_places(
    user_id: int,
    limit: int = 100,
    offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    """Return active places for a specific user."""
    places = repository.get_user_places(user_id, limit=limit, offset=offset)
    return {"places": places, "user_id": user_id}


@router.get("/restaurants")
async def get_restaurants(
    platform: Optional[str] = None,
    city: Optional[str] = None,
    search: Optional[str] = None,
    sort: str = "saves",
    limit: int = 50,
    offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    """List database-aggregated restaurant stats across all users."""
    allowed_sorts = {"saves", "savers", "visits", "reviews", "score", "latest"}
    if sort not in allowed_sorts:
        raise HTTPException(status_code=400, detail="Unsupported restaurant sort")
    page_size = max(1, min(limit, 100))
    page_offset = max(0, offset)
    groups, total = repository.get_admin_restaurant_directory(
        platform=platform,
        city=city,
        search=search,
        sort=sort,
        limit=page_size,
        offset=page_offset,
    )
    return {"restaurants": groups, "total": total, "limit": page_size, "offset": page_offset}


@router.get("/restaurants/{restaurant_key}/reviews")
async def get_restaurant_reviews(
    restaurant_key: str,
    limit: int = 20,
    offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    """Return the paginated public review feed for one restaurant."""
    page_size = max(1, min(limit, 100))
    page_offset = max(0, offset)
    reviews, total = repository.get_admin_restaurant_reviews(
        restaurant_key, limit=page_size, offset=page_offset
    )
    return {"reviews": reviews, "total": total, "limit": page_size, "offset": page_offset}


@router.get("/restaurants/{restaurant_key}/sources")
async def get_restaurant_sources(
    restaurant_key: str, limit: int = 20, offset: int = 0,
    admin: AdminUser = Depends(get_current_admin),
):
    page_size, page_offset = max(1, min(limit, 100)), max(0, offset)
    rows, total = repository.get_admin_restaurant_content_sources(
        restaurant_key, limit=page_size, offset=page_offset
    )
    return {"sources": rows, "total": total, "limit": page_size, "offset": page_offset}


@router.get("/restaurants/{restaurant_key}")
async def get_restaurant_detail(
    restaurant_key: str,
    admin: AdminUser = Depends(get_current_admin),
):
    """Return the cross-user aggregate story for one restaurant."""
    detail = repository.get_admin_restaurant_detail(restaurant_key)
    if not detail:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    return {"restaurant": detail}


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
