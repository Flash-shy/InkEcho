from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Future: DB engine, migrations
    yield


app = FastAPI(title="InkEcho Backend", version="0.1.0", lifespan=lifespan)

_origins = [o.strip() for o in settings.backend_cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "ink-echo-backend",
        "ai_api_base_url": settings.ai_api_base_url,
    }


@app.get("/internal/health")
def internal_health():
    """Reserved for load balancers / compose healthchecks."""
    return {"status": "ok"}
