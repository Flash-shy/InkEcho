from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db import SessionLocal, init_db
from app.models import Session as SessionModel
from app.routers import platform as platform_router
from app.routers import rag as rag_router
from app.routers import sessions as sessions_router
from app.ws_hub import SessionWsHub


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.ws_hub = SessionWsHub()
    await init_db()
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

app.include_router(sessions_router.router)
app.include_router(platform_router.router)
app.include_router(rag_router.router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "ink-echo-backend",
        "ai_api_base_url": settings.ai_api_base_url,
    }


@app.get("/internal/health")
def internal_health():
    return {"status": "ok"}


@app.websocket("/ws/sessions/{session_id}")
async def session_ws(websocket: WebSocket, session_id: UUID):
    async with SessionLocal() as db:
        row = await db.get(SessionModel, session_id)
        if not row:
            await websocket.close(code=4004, reason="Session not found")
            return
    hub: SessionWsHub = websocket.app.state.ws_hub
    await hub.connect(str(session_id), websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(str(session_id), websocket)
