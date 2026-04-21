import base64
import hmac
import os
import shutil
import subprocess
import tempfile
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
        "(Mock transcription — no STT API key on AI-API; end-to-end pipeline check only.)",
        f"Received about {size_kb} KB from “{filename}”.",
        "Set OPENAI_API_KEY (Whisper) or OPENROUTER_API_KEY (see STT_PROVIDER), or STT_PROVIDER=openrouter.",
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
    async with httpx.AsyncClient(timeout=600.0, trust_env=True) as client:
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


def _openrouter_audio_format(filename: str, content_type: str | None) -> str:
    """Label for OpenRouter input_audio.format (supported set varies by model; see OpenRouter audio docs)."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    by_ext = {
        "wav": "wav",
        "mp3": "mp3",
        "mp4": "mp4",
        "m4a": "m4a",
        "mpeg": "mp3",
        "webm": "webm",
        "ogg": "ogg",
        "aac": "aac",
        "aiff": "aiff",
        "flac": "flac",
    }
    if ext in by_ext:
        return by_ext[ext]
    if content_type:
        ct = content_type.lower()
        if "wav" in ct:
            return "wav"
        if "mpeg" in ct or "mp3" in ct:
            return "mp3"
        if "webm" in ct:
            return "webm"
        if "ogg" in ct:
            return "ogg"
        if "mp4" in ct or "m4a" in ct:
            return "mp4"
    return "wav"


def _ffmpeg_input_suffix(filename: str, content_type: str | None) -> str:
    if "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        if ext and len(ext) <= 8 and ext.isalnum():
            return f".{ext}"
    if content_type:
        ct = content_type.lower()
        if "mp4" in ct or "quicktime" in ct:
            return ".mp4"
        if "webm" in ct:
            return ".webm"
        if "mpeg" in ct or "mp3" in ct:
            return ".mp3"
        if "wav" in ct:
            return ".wav"
    return ".bin"


def _ffmpeg_bytes_to_wav_pcm16_mono(data: bytes, filename: str = "", content_type: str | None = None) -> bytes:
    """Demux/decode arbitrary audio or video-with-audio to 16 kHz mono WAV (anything ffmpeg understands)."""
    if not shutil.which("ffmpeg"):
        raise HTTPException(
            status_code=502,
            detail=(
                "OpenRouter STT uses ffmpeg to normalize uploads to WAV. Install ffmpeg (e.g. brew install ffmpeg) "
                "and ensure it is on PATH, or set STT_PROVIDER=openai with OPENAI_API_KEY."
            ),
        )
    # MP4/MOV and many containers need seekable input; stdin often yields "partial file" / no streams.
    suffix = _ffmpeg_input_suffix(filename or "upload", content_type)
    fd: int | None = None
    in_path: str | None = None
    try:
        fd, in_path = tempfile.mkstemp(suffix=suffix, prefix="inkecho-audio-")
        os.write(fd, data)
        os.close(fd)
        fd = None
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                in_path,
                "-ar",
                "16000",
                "-ac",
                "1",
                "-f",
                "wav",
                "pipe:1",
            ],
            capture_output=True,
            timeout=600,
        )
        if proc.returncode != 0 or not proc.stdout:
            err = (proc.stderr or b"").decode("utf-8", errors="replace")[:800]
            raise HTTPException(
                status_code=502,
                detail=f"ffmpeg could not decode this file for transcription: {err or proc.returncode}",
            )
        return proc.stdout
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if in_path:
            try:
                os.unlink(in_path)
            except OSError:
                pass


async def _openrouter_transcribe(filename: str, content_type: str | None, data: bytes) -> dict[str, Any]:
    """STT via OpenRouter chat/completions + input_audio (see OpenRouter multimodal audio docs)."""
    if not settings.openrouter_api_key:
        raise HTTPException(status_code=500, detail="OpenRouter requested but OPENROUTER_API_KEY is missing")
    # With ffmpeg: normalize all uploads/recording formats to WAV so OpenRouter sees a supported container.
    if shutil.which("ffmpeg"):
        data = _ffmpeg_bytes_to_wav_pcm16_mono(data, filename, content_type)
        fmt = "wav"
    else:
        fmt = _openrouter_audio_format(filename, content_type)
        if fmt == "webm" or (content_type and "webm" in content_type.lower()):
            data = _ffmpeg_bytes_to_wav_pcm16_mono(data, filename, content_type)
            fmt = "wav"

    b64 = base64.b64encode(data).decode("ascii")
    url = f"{settings.openrouter_base_url.rstrip('/')}/chat/completions"
    referer = (settings.openrouter_http_referer or "").strip() or "https://openrouter.ai"
    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": settings.openrouter_x_title or "InkEcho",
    }

    # Short neutral prompt; some providers moderate long or emphatic instructions. Audio is always WAV after ffmpeg.
    payload: dict[str, Any] = {
        "model": settings.openrouter_transcribe_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Write a verbatim transcript of the speech. Output only the words spoken."},
                    {"type": "input_audio", "input_audio": {"data": b64, "format": fmt}},
                ],
            }
        ],
    }

    async with httpx.AsyncClient(timeout=600.0, trust_env=True) as client:
        r = await client.post(url, headers=headers, json=payload)
        if r.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"OpenRouter error: {r.status_code} {r.text[:2500]}",
            )
        body = r.json()

    def _message_text(message: dict[str, Any]) -> str:
        raw = message.get("content")
        if raw is None:
            return ""
        if isinstance(raw, str):
            return raw.strip()
        if isinstance(raw, list):
            parts: list[str] = []
            for block in raw:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
                elif isinstance(block, str):
                    parts.append(block)
            return "".join(parts).strip()
        return str(raw).strip()

    try:
        msg = (body.get("choices") or [{}])[0].get("message") or {}
        text = _message_text(msg if isinstance(msg, dict) else {})
    except (IndexError, AttributeError, TypeError):
        text = ""
    if not text:
        raise HTTPException(status_code=502, detail=f"OpenRouter returned empty transcript: {str(body)[:500]}")
    segments = [{"text": text, "start_ms": None, "end_ms": None}]
    return {"segments": segments, "full_text": text}


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
    backend = settings.resolved_stt_backend()
    if backend == "openai":
        return await _openai_transcribe(filename, content_type, data)
    if backend == "openrouter":
        return await _openrouter_transcribe(filename, content_type, data)
    return _mock_transcribe(filename, data)
