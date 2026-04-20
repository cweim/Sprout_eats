from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from api.routes import router
import config

app = FastAPI(title="Discovery Bot API", version="1.0.0")

# Build allowed origins
allowed_origins = []
if config.WEBAPP_URL:
    allowed_origins.append(config.WEBAPP_URL)
if config.LOCAL_DEV_AUTH:
    allowed_origins.extend(["http://localhost:8000", "http://127.0.0.1:8000"])

# CORS middleware - locked to WEBAPP_URL in production
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins if allowed_origins else ["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    allow_headers=["*"],
)

# Include API routes
app.include_router(router)

# Serve webapp static files (must be after API routes)
webapp_path = Path(__file__).parent.parent / "webapp"
if webapp_path.exists():
    app.mount("/", StaticFiles(directory=webapp_path, html=True), name="webapp")
