from fastapi import FastAPI

from app.config import settings
from app.chat import router as chat_router
from app.embed import router as embed_router
from app.mcp_health import probe_mcp_health
from app.mcp_proxy import router as mcp_proxy_router
from app.transcribe import router as transcribe_router

app = FastAPI(title="InkEcho AI-API", version="0.1.0")
app.include_router(transcribe_router)
app.include_router(chat_router)
app.include_router(embed_router)
app.include_router(mcp_proxy_router)


@app.get("/health")
async def health():
    out = {
        "status": "ok",
        "service": "ink-echo-ai-api",
        "stt_backend": settings.resolved_stt_backend(),
        "chat_backend": settings.resolved_chat_backend(),
        "embed_backend": settings.resolved_embed_backend(),
    }
    if settings.mcp_health_url:
        out["mcp"] = await probe_mcp_health(settings.mcp_health_url)
    else:
        out["mcp"] = {"configured": False}
    mcp_http = settings.resolved_mcp_http_url
    out["mcp_client"] = {
        "configured": bool(mcp_http),
        "endpoint": mcp_http,
        "note": "Use GET/POST /v1/mcp/tools* with service token to run Streamable HTTP MCP client",
    }
    return out
