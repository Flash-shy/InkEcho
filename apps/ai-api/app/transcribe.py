import hmac
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile

from app.config import settings

router = APIRouter(tags=["transcribe"])


async def require_service_token(authorization: str | None = Header(default=None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(token.encode("utf-8"), settings.service_token.encode("utf-8")):
        raise HTTPException(status_code=403, detail="Invalid service token")


def _mock_transcribe(filename: str, data: bytes) -> dict[str, Any]:
    size_kb = max(1, len(data) // 1024)
    lines = [
        "(Mock transcription — no OPENAI_API_KEY on AI-API; end-to-end pipeline check only.)",
        f"Received about {size_kb} KB from “{filename}”.",
        "Set OPENAI_API_KEY in the environment for real Whisper output.",
    ]
    segments = [
        {"text": line, "start_ms": i * 1500, "end_ms": (i + 1) * 1500} for i, line in enumerate(lines)
    ]
    return {"segments": segments, "full_text": " ".join(lines)}


async def _openai_transcribe(filename: str, content_type: str | None, data: bytes) -> dict[str, Any]:
    url = f"{settings.openai_base_url.rstrip('/')}/audio/transcriptions"
    headers = {"Authorization": f"Bearer {settings.openai_api_key}"}
    files = {"file": (filename, data, content_type or "application/octet-stream")}
    form = {"model": "whisper-1", "response_format": "verbose_json"}
    async with httpx.AsyncClient(timeout=600.0) as client:
        r = await client.post(url, headers=headers, files=files, data=form)
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"OpenAI error: {r.status_code} {r.text[:500]}")
        body = r.json()
    segments: list[dict[str, Any]] = []
    for s in body.get("segments") or []:
        text = str(s.get("text") or "").strip()
        if not text:
            continue
        start = s.get("start")
        end = s.get("end")
        segments.append(
            {
                "text": text,
                "start_ms": int(float(start) * 1000) if start is not None else None,
                "end_ms": int(float(end) * 1000) if end is not None else None,
            }
        )
    full = str(body.get("text") or "").strip()
    if not segments and full:
        segments = [{"text": full, "start_ms": None, "end_ms": None}]
    return {"segments": segments, "full_text": full or None}


@router.post("/v1/transcribe")
async def transcribe(
    _: None = Depends(require_service_token),
    file: UploadFile = File(...),
):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    filename = file.filename or "audio.bin"
    content_type = file.content_type
    if settings.openai_api_key:
        return await _openai_transcribe(filename, content_type, data)
    return _mock_transcribe(filename, data)
