from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class TranscriptSegmentOut(BaseModel):
    id: UUID
    seq: int
    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class SessionCreate(BaseModel):
    title: str | None = Field(default=None, max_length=512)


class SessionOut(BaseModel):
    id: UUID
    status: str
    title: str | None
    error_message: str | None = None
    summary_text: str | None = None
    summary_error: str | None = None
    summary_status: str = "idle"
    minutes_text: str | None = None
    minutes_error: str | None = None
    minutes_status: str = "idle"
    created_at: datetime
    updated_at: datetime
    segments: list[TranscriptSegmentOut] = []

    model_config = {"from_attributes": True}


class SessionSummary(BaseModel):
    id: UUID
    status: str
    title: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AudioAccepted(BaseModel):
    session_id: UUID
    status: str = "transcribing"
    message: str = "Transcription started; listen on WebSocket for segments."
