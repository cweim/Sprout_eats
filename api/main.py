import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from api.routes import router
from api.admin_routes import router as admin_router
from api.limiter import limiter
import config

logger = logging.getLogger(__name__)

if config.LOCAL_DEV_AUTH and config.SUPABASE_URL and "supabase.co" in config.SUPABASE_URL:
    logger.warning(
        "WARNING: LOCAL_DEV_AUTH is enabled against a production Supabase instance. "
        "This bypasses authentication — disable it before deploying."
    )

app = FastAPI(title="Discovery Bot API", version="1.0.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Build allowed origins - NEVER fall back to wildcard
allowed_origins = []
if config.WEBAPP_URL:
    allowed_origins.append(config.WEBAPP_URL)
if config.LOCAL_DEV_AUTH:
    allowed_origins.extend(["http://localhost:8000", "http://127.0.0.1:8000"])

if not allowed_origins:
    import logging
    logging.warning("No CORS origins configured. Set WEBAPP_URL or LOCAL_DEV_AUTH.")

# CORS middleware - empty list rejects all cross-origin if misconfigured
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,  # No wildcard fallback
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    allow_headers=["*"],
)

# Include API routes
app.include_router(router)
app.include_router(admin_router)

# Serve admin dashboard static files (must be before root mount)
admin_path = Path(__file__).parent.parent / "admin"
if admin_path.exists():
    app.mount("/admin", StaticFiles(directory=admin_path, html=True), name="admin")

# Serve webapp static files (must be after API routes)
webapp_path = Path(__file__).parent.parent / "webapp"
if webapp_path.exists():
    app.mount("/", StaticFiles(directory=webapp_path, html=True), name="webapp")
