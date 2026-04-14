import json
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.db import SessionLocal
from app.models import Session as InkSession
from app.models import TranscriptSegment


def _segment_dict(s: TranscriptSegment) -> dict[str, Any]:
    return {
        "id": str(s.id),
        "seq": s.seq,
        "text": s.text,
        "start_ms": s.start_ms,
        "end_ms": s.end_ms,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


async def build_export_payload(session_id: UUID) -> dict[str, Any] | None:
    async with SessionLocal() as db:
        q = await db.execute(
            select(InkSession)
            .options(selectinload(InkSession.segments))
            .where(InkSession.id == session_id)
        )
        row = q.scalar_one_or_none()
        if not row:
            return None
        segs = sorted(row.segments, key=lambda s: s.seq)
        return {
            "session": {
                "id": str(row.id),
                "status": row.status,
                "title": row.title,
                "error_message": row.error_message,
                "summary_text": row.summary_text,
                "summary_status": row.summary_status,
                "summary_error": row.summary_error,
                "minutes_text": row.minutes_text,
                "minutes_status": row.minutes_status,
                "minutes_error": row.minutes_error,
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            },
            "segments": [_segment_dict(s) for s in segs],
        }


def export_as_json(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def export_as_txt(data: dict[str, Any]) -> str:
    sess = data["session"]
    lines: list[str] = []
    title = sess.get("title") or "InkEcho session"
    lines.append(title)
    lines.append(f"Session id: {sess['id']}")
    lines.append(f"Status: {sess['status']}")
    lines.append("")
    lines.append("--- Transcript ---")
    for s in data["segments"]:
        lines.append(f"[{s['seq']}] {s['text']}")
    if sess.get("summary_text"):
        lines.append("")
        lines.append("--- Summary ---")
        lines.append(sess["summary_text"])
    if sess.get("minutes_text"):
        lines.append("")
        lines.append("--- Meeting minutes ---")
        lines.append(sess["minutes_text"])
    return "\n".join(lines).strip() + "\n"


def export_as_md(data: dict[str, Any]) -> str:
    sess = data["session"]
    title = sess.get("title") or "InkEcho session"
    parts: list[str] = [f"# {title}", "", f"- **Session id:** `{sess['id']}`", f"- **Status:** {sess['status']}", ""]
    parts.append("## Transcript")
    parts.append("")
    for s in data["segments"]:
        t0 = s.get("start_ms")
        t1 = s.get("end_ms")
        meta = ""
        if t0 is not None or t1 is not None:
            meta = f" *({t0}–{t1} ms)*"
        parts.append(f"{s['seq'] + 1}. {s['text']}{meta}")
        parts.append("")
    if sess.get("summary_text"):
        parts.append("## Summary")
        parts.append("")
        parts.append(sess["summary_text"])
        parts.append("")
    if sess.get("minutes_text"):
        parts.append("## Meeting minutes")
        parts.append("")
        parts.append(sess["minutes_text"])
        parts.append("")
    return "\n".join(parts).strip() + "\n"


def export_filename(session_id: UUID, ext: str, stamp: datetime | None = None) -> str:
    ts = (stamp or datetime.now(timezone.utc)).strftime("%Y%m%d-%H%M%S")
    return f"inkecho-{session_id}-{ts}.{ext}"
