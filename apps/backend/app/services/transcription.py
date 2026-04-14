import uuid
from typing import Any

import httpx
from sqlalchemy import delete, select

from app.config import settings
from app.db import SessionLocal
from app.models import Session as InkSession
from app.models import SessionStatus, TranscriptSegment
from app.ws_hub import SessionWsHub


async def call_ai_transcribe(data: bytes, filename: str, content_type: str | None) -> dict[str, Any]:
    url = f"{settings.ai_api_base_url.rstrip('/')}/v1/transcribe"
    headers = {"Authorization": f"Bearer {settings.ai_api_service_token}"}
    files = {"file": (filename, data, content_type or "application/octet-stream")}
    async with httpx.AsyncClient(timeout=600.0) as client:
        r = await client.post(url, headers=headers, files=files)
        r.raise_for_status()
        return r.json()


async def run_transcription_job(
    session_id: uuid.UUID,
    audio: bytes,
    filename: str,
    content_type: str | None,
    hub: SessionWsHub,
) -> None:
    async with SessionLocal() as db:
        row = await db.get(InkSession, session_id)
        if not row:
            return
        row.status = SessionStatus.transcribing.value
        row.error_message = None
        await db.commit()

    await hub.broadcast(str(session_id), {"type": "status", "status": "transcribing"})

    try:
        result = await call_ai_transcribe(audio, filename, content_type)
    except Exception as e:
        async with SessionLocal() as db:
            row = await db.get(InkSession, session_id)
            if row:
                row.status = SessionStatus.error.value
                row.error_message = str(e)[:2000]
                await db.commit()
        await hub.broadcast(str(session_id), {"type": "transcribe_error", "message": str(e)})
        return

    segments_raw = result.get("segments") or []
    if not segments_raw and result.get("full_text"):
        segments_raw = [{"text": str(result["full_text"]), "start_ms": None, "end_ms": None}]

    async with SessionLocal() as db:
        row = await db.get(InkSession, session_id)
        if not row:
            return
        await db.execute(delete(TranscriptSegment).where(TranscriptSegment.session_id == session_id))
        seq = 0
        for seg in segments_raw:
            text = str(seg.get("text") or "").strip()
            if not text:
                continue
            db.add(
                TranscriptSegment(
                    session_id=session_id,
                    seq=seq,
                    text=text,
                    start_ms=seg.get("start_ms"),
                    end_ms=seg.get("end_ms"),
                )
            )
            seq += 1
        row.status = SessionStatus.ready.value
        row.error_message = None
        await db.commit()

        q = await db.execute(
            select(TranscriptSegment)
            .where(TranscriptSegment.session_id == session_id)
            .order_by(TranscriptSegment.seq)
        )
        stored = q.scalars().all()

    for s in stored:
        await hub.broadcast(
            str(session_id),
            {
                "type": "segment",
                "data": {
                    "id": str(s.id),
                    "seq": s.seq,
                    "text": s.text,
                    "start_ms": s.start_ms,
                    "end_ms": s.end_ms,
                },
            },
        )

    await hub.broadcast(str(session_id), {"type": "transcribe_done", "session_id": str(session_id)})
