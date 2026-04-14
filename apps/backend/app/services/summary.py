import uuid
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.config import settings
from app.db import SessionLocal
from app.models import Session as InkSession
from app.models import TranscriptSegment
from app.ws_hub import SessionWsHub


async def call_ai_chat(messages: list[dict[str, str]], temperature: float = 0.3, max_tokens: int = 4096) -> str:
    url = f"{settings.ai_api_base_url.rstrip('/')}/v1/chat"
    headers = {
        "Authorization": f"Bearer {settings.ai_api_service_token}",
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(url, headers=headers, json=payload)
        if r.status_code >= 400:
            detail: str
            try:
                body = r.json()
                d = body.get("detail")
                detail = d if isinstance(d, str) else r.text
            except Exception:
                detail = r.text or r.reason_phrase
            msg = f"AI-API {r.status_code}: {detail}"[:4000]
            raise RuntimeError(msg)
        data = r.json()
        text = str(data.get("text") or "").strip()
    if not text:
        raise RuntimeError("AI-API returned empty summary text")
    return text


def _format_transcript_for_prompt(segments: list[TranscriptSegment]) -> str:
    lines: list[str] = []
    for s in segments:
        head = f"[{s.seq}]"
        if s.start_ms is not None or s.end_ms is not None:
            head += f" ({s.start_ms},{s.end_ms} ms)"
        lines.append(f"{head} {s.text}")
    return "\n".join(lines).strip()


async def run_summary_job(session_id: uuid.UUID, hub: SessionWsHub) -> None:
    await hub.broadcast(str(session_id), {"type": "summary_status", "status": "running"})

    async with SessionLocal() as db:
        q = await db.execute(
            select(InkSession)
            .options(selectinload(InkSession.segments))
            .where(InkSession.id == session_id)
        )
        row = q.scalar_one_or_none()
        if not row:
            return
        row.summary_status = "running"
        row.summary_error = None
        row.summary_text = None
        await db.commit()
        segments = sorted(row.segments, key=lambda s: s.seq)

    if not segments:
        err = "No transcript segments to summarize"
        async with SessionLocal() as db:
            r2 = await db.get(InkSession, session_id)
            if r2:
                r2.summary_status = "error"
                r2.summary_error = err
                await db.commit()
        await hub.broadcast(str(session_id), {"type": "summary_error", "message": err})
        return

    transcript = _format_transcript_for_prompt(segments)
    messages = [
        {
            "role": "system",
            "content": (
                "You summarize meeting or lesson transcripts for a note-taking app. "
                "Respond in Markdown with: a short title (##), a tight bullet summary, "
                "then optional **Action items** as a bullet list. Stay faithful to the transcript; "
                "if audio was unclear, say so briefly."
            ),
        },
        {
            "role": "user",
            "content": f"Transcript (segments in order):\n\n{transcript}",
        },
    ]

    try:
        summary = await call_ai_chat(messages)
    except Exception as e:
        msg = str(e)[:2000]
        async with SessionLocal() as db:
            r2 = await db.get(InkSession, session_id)
            if r2:
                r2.summary_status = "error"
                r2.summary_error = msg
                r2.summary_text = None
                await db.commit()
        await hub.broadcast(str(session_id), {"type": "summary_error", "message": msg})
        return

    async with SessionLocal() as db:
        r2 = await db.get(InkSession, session_id)
        if r2:
            r2.summary_text = summary
            r2.summary_error = None
            r2.summary_status = "ready"
            await db.commit()

    await hub.broadcast(
        str(session_id),
        {"type": "summary_done", "session_id": str(session_id), "summary": summary},
    )
