from typing import Literal
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.db import get_db
from app.models import Session as SessionModel
from app.models import SessionStatus
from app.schemas import AudioAccepted, SessionCreate, SessionOut, SessionSummary
from app.services.export_session import (
    build_export_payload,
    export_as_json,
    export_as_md,
    export_as_txt,
    export_filename,
)
from app.services.meeting_minutes import run_meeting_minutes_job
from app.services.summary import run_summary_job
from app.services.transcription import run_transcription_job

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.post("", response_model=SessionSummary)
async def create_session(body: SessionCreate = SessionCreate(), db: AsyncSession = Depends(get_db)):
    row = SessionModel(title=body.title)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.get("", response_model=list[SessionSummary])
async def list_sessions(db: AsyncSession = Depends(get_db), limit: int = 50):
    q = await db.execute(
        select(SessionModel).order_by(SessionModel.created_at.desc()).limit(min(limit, 200))
    )
    return list(q.scalars().all())


@router.get("/{session_id}", response_model=SessionOut)
async def get_session(session_id: UUID, db: AsyncSession = Depends(get_db)):
    q = await db.execute(
        select(SessionModel)
        .options(selectinload(SessionModel.segments))
        .where(SessionModel.id == session_id)
    )
    row = q.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    return row


@router.post("/{session_id}/audio", response_model=AudioAccepted)
async def upload_audio(
    request: Request,
    session_id: UUID,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(SessionModel, session_id)
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    data = await file.read()
    if len(data) > settings.max_upload_bytes:
        cap_mb = max(1, settings.max_upload_bytes // (1024 * 1024))
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(data) // (1024 * 1024)} MiB). Backend limit is {cap_mb} MiB (env MAX_UPLOAD_BYTES).",
        )
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    filename = file.filename or "audio.bin"
    content_type = file.content_type
    hub = request.app.state.ws_hub
    background_tasks.add_task(
        run_transcription_job,
        session_id,
        data,
        filename,
        content_type,
        hub,
    )
    return AudioAccepted(session_id=session_id)


@router.post("/{session_id}/summarize", response_model=SessionOut)
async def start_summarize(
    request: Request,
    session_id: UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    q = await db.execute(
        select(SessionModel)
        .options(selectinload(SessionModel.segments))
        .where(SessionModel.id == session_id)
    )
    row = q.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    if row.status != SessionStatus.ready.value:
        raise HTTPException(
            status_code=400,
            detail="Session must be transcribed (status=ready) before summarizing",
        )
    if not row.segments:
        raise HTTPException(status_code=400, detail="No transcript segments to summarize")
    if row.summary_status == "running":
        raise HTTPException(status_code=409, detail="Summary already in progress")
    row.summary_status = "running"
    row.summary_error = None
    await db.commit()
    await db.refresh(row)
    hub = request.app.state.ws_hub
    background_tasks.add_task(run_summary_job, session_id, hub)
    return row


@router.post("/{session_id}/meeting-minutes", response_model=SessionOut)
async def start_meeting_minutes(
    request: Request,
    session_id: UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    q = await db.execute(
        select(SessionModel)
        .options(selectinload(SessionModel.segments))
        .where(SessionModel.id == session_id)
    )
    row = q.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    if row.status != SessionStatus.ready.value:
        raise HTTPException(
            status_code=400,
            detail="Session must be transcribed (status=ready) before meeting minutes",
        )
    if not row.segments:
        raise HTTPException(status_code=400, detail="No transcript segments")
    if row.minutes_status == "running":
        raise HTTPException(status_code=409, detail="Meeting minutes already in progress")
    row.minutes_status = "running"
    row.minutes_error = None
    await db.commit()
    await db.refresh(row)
    hub = request.app.state.ws_hub
    background_tasks.add_task(run_meeting_minutes_job, session_id, hub)
    return row


@router.get("/{session_id}/export")
async def export_session(
    session_id: UUID,
    export_format: Literal["md", "txt", "json"] = Query("json", alias="format"),
):
    payload = await build_export_payload(session_id)
    if not payload:
        raise HTTPException(status_code=404, detail="Session not found")
    if export_format == "json":
        body = export_as_json(payload)
        media = "application/json; charset=utf-8"
        ext = "json"
    elif export_format == "txt":
        body = export_as_txt(payload)
        media = "text/plain; charset=utf-8"
        ext = "txt"
    else:
        body = export_as_md(payload)
        media = "text/markdown; charset=utf-8"
        ext = "md"
    fname = export_filename(session_id, ext)
    return Response(
        content=body,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
