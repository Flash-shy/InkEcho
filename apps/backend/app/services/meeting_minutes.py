import uuid

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.db import SessionLocal
from app.models import Session as InkSession
from app.models import TranscriptSegment
from app.services.summary import call_ai_chat, _format_transcript_for_prompt
from app.ws_hub import SessionWsHub


# Kept in sync with apps/mcp-server/skills/meeting-minutes/SKILL.md intent.
MEETING_MINUTES_SYSTEM_PROMPT = """You produce structured meeting minutes from a single transcript for InkEcho.

Output Markdown with these sections in order (use ## headings exactly):
## Topics discussed
## Decisions
## Open questions
## Action items

Rules:
- Use bullet lists under each section. If a section has nothing relevant, write: _(None noted.)_
- Stay faithful to the transcript. For non-obvious claims, cite segment index from the transcript lines, e.g. [seq 3] or timecodes when shown.
- Prefer a clear, professional tone. Use the same language as the transcript when it is clearly one primary language."""


async def run_meeting_minutes_job(session_id: uuid.UUID, hub: SessionWsHub) -> None:
    await hub.broadcast(str(session_id), {"type": "minutes_status", "status": "running"})

    async with SessionLocal() as db:
        q = await db.execute(
            select(InkSession)
            .options(selectinload(InkSession.segments))
            .where(InkSession.id == session_id)
        )
        row = q.scalar_one_or_none()
        if not row:
            return
        row.minutes_status = "running"
        row.minutes_error = None
        row.minutes_text = None
        await db.commit()
        segments = sorted(row.segments, key=lambda s: s.seq)

    if not segments:
        err = "No transcript segments for meeting minutes"
        async with SessionLocal() as db:
            r2 = await db.get(InkSession, session_id)
            if r2:
                r2.minutes_status = "error"
                r2.minutes_error = err
                await db.commit()
        await hub.broadcast(str(session_id), {"type": "minutes_error", "message": err})
        return

    transcript = _format_transcript_for_prompt(segments)
    messages = [
        {"role": "system", "content": MEETING_MINUTES_SYSTEM_PROMPT},
        {"role": "user", "content": f"Transcript (segments in order):\n\n{transcript}"},
    ]

    try:
        text = await call_ai_chat(messages, temperature=0.25, max_tokens=8192)
    except Exception as e:
        msg = str(e)[:2000]
        async with SessionLocal() as db:
            r2 = await db.get(InkSession, session_id)
            if r2:
                r2.minutes_status = "error"
                r2.minutes_error = msg
                r2.minutes_text = None
                await db.commit()
        await hub.broadcast(str(session_id), {"type": "minutes_error", "message": msg})
        return

    async with SessionLocal() as db:
        r2 = await db.get(InkSession, session_id)
        if r2:
            r2.minutes_text = text
            r2.minutes_error = None
            r2.minutes_status = "ready"
            await db.commit()

    await hub.broadcast(
        str(session_id),
        {"type": "minutes_done", "session_id": str(session_id), "minutes": text},
    )
