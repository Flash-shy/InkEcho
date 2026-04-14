from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/rag", tags=["rag"])


class RagIndexOut(BaseModel):
    session_id: UUID
    chunks_indexed: int


@router.post("/index/{session_id}", response_model=RagIndexOut)
async def rag_index_session(session_id: UUID) -> RagIndexOut:
    from app.services.rag_index import index_session_for_rag

    try:
        n = await index_session_for_rag(session_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)[:2000]) from e
    return RagIndexOut(session_id=session_id, chunks_indexed=n)


class RagSearchBody(BaseModel):
    query: str = Field(..., min_length=1, max_length=4000)
    limit: int = Field(default=8, ge=1, le=50)
    session_ids: list[UUID] | None = None


class RagSearchHitOut(BaseModel):
    session_id: UUID
    session_title: str | None = None
    chunk_index: int
    score: float
    text: str
    segment_start_seq: int
    segment_end_seq: int


class RagSearchOut(BaseModel):
    model: str
    hits: list[RagSearchHitOut]


@router.post("/search", response_model=RagSearchOut)
async def rag_search(body: RagSearchBody) -> RagSearchOut:
    from app.services.rag_query import search_rag

    try:
        hits, model = await search_rag(body.query, limit=body.limit, session_ids=body.session_ids)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)[:2000]) from e
    return RagSearchOut(
        model=model,
        hits=[
            RagSearchHitOut(
                session_id=h.session_id,
                session_title=h.session_title,
                chunk_index=h.chunk_index,
                score=h.score,
                text=h.text,
                segment_start_seq=h.segment_start_seq,
                segment_end_seq=h.segment_end_seq,
            )
            for h in hits
        ],
    )


class RagAnswerBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=8000)
    limit: int = Field(default=6, ge=1, le=20)
    session_ids: list[UUID] | None = None


class RagAnswerOut(BaseModel):
    answer: str
    citations: list[RagSearchHitOut]


@router.post("/answer", response_model=RagAnswerOut)
async def rag_answer(body: RagAnswerBody) -> RagAnswerOut:
    from app.services.rag_query import answer_rag

    try:
        answer_text, hits = await answer_rag(body.question, limit=body.limit, session_ids=body.session_ids)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)[:2000]) from e
    return RagAnswerOut(
        answer=answer_text,
        citations=[
            RagSearchHitOut(
                session_id=h.session_id,
                session_title=h.session_title,
                chunk_index=h.chunk_index,
                score=h.score,
                text=h.text,
                segment_start_seq=h.segment_start_seq,
                segment_end_seq=h.segment_end_seq,
            )
            for h in hits
        ],
    )
