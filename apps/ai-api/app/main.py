from fastapi import FastAPI

from app.config import settings
from app.chat import router as chat_router
from app.embed import router as embed_router
from app.transcribe import router as transcribe_router

app = FastAPI(title="InkEcho AI-API", version="0.1.0")
app.include_router(transcribe_router)
app.include_router(chat_router)
app.include_router(embed_router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "ink-echo-ai-api",
        "stt_backend": settings.resolved_stt_backend(),
        "chat_backend": settings.resolved_chat_backend(),
        "embed_backend": settings.resolved_embed_backend(),
    }
