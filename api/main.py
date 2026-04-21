from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from api.routes import router
from api.admin_routes import router as admin_router
import config

app = FastAPI(title="Discovery Bot API", version="1.0.0")

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
