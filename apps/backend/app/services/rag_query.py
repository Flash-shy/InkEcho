import json
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import joinedload

from app.db import SessionLocal
from app.models import TranscriptRagChunk
from app.services.rag_embed import embed_texts, parse_embedding_json
from app.services.summary import call_ai_chat


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        return float("-inf")
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(x * x for x in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


@dataclass
class RagHit:
    session_id: uuid.UUID
    session_title: str | None
    chunk_index: int
    score: float
    text: str
    segment_start_seq: int
    segment_end_seq: int


async def search_rag(
    query: str,
    *,
    limit: int = 8,
    session_ids: list[uuid.UUID] | None = None,
) -> tuple[list[RagHit], str]:
    """Embed query, score all matching chunks, return top `limit` and embedding model name."""
    q_vecs, model_used = await embed_texts([query.strip()])
    q_vec = q_vecs[0]
    q_dim = len(q_vec)

    async with SessionLocal() as db:
        stmt = select(TranscriptRagChunk).options(joinedload(TranscriptRagChunk.session))
        if session_ids:
            stmt = stmt.where(TranscriptRagChunk.session_id.in_(session_ids))
        q = await db.execute(stmt)
        rows = q.unique().scalars().all()

    scored: list[RagHit] = []
    for row in rows:
        try:
            vec = parse_embedding_json(row.embedding_json)
        except (json.JSONDecodeError, ValueError):
            continue
        if len(vec) != q_dim:
            continue
        score = cosine_similarity(q_vec, vec)
        title = row.session.title if row.session else None
        scored.append(
            RagHit(
                session_id=row.session_id,
                session_title=title,
                chunk_index=row.chunk_index,
                score=score,
                text=row.text,
                segment_start_seq=row.segment_start_seq,
                segment_end_seq=row.segment_end_seq,
            )
        )

    scored.sort(key=lambda h: h.score, reverse=True)
    top = scored[: max(1, min(limit, 50))]
    return top, model_used


async def answer_rag(
    question: str,
    *,
    limit: int = 6,
    session_ids: list[uuid.UUID] | None = None,
) -> tuple[str, list[RagHit]]:
    hits, _model = await search_rag(question.strip(), limit=limit, session_ids=session_ids)
    if not hits:
        return (
            "No indexed transcript chunks found. Transcribe sessions first (RAG indexes run after transcription), "
            "or call POST /rag/index/{session_id} to rebuild.",
            [],
        )

    lines: list[str] = []
    for i, h in enumerate(hits):
        title = h.session_title or "(untitled)"
        lines.append(
            f"[{i}] session_id={h.session_id} title={title!r} "
            f"seq={h.segment_start_seq}-{h.segment_end_seq} score={h.score:.4f}\n{h.text}"
        )
    context = "\n\n---\n\n".join(lines)

    system = (
        "You answer using ONLY the excerpts below from multiple InkEcho sessions. "
        "Cite sources as [n] matching the bracketed index before each excerpt. "
        "If the excerpts do not support an answer, say you do not have enough evidence. "
        "Do not invent meetings or quotes."
    )
    user = f"Question:\n{question}\n\nExcerpts:\n{context}"
    text = await call_ai_chat(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.25,
        max_tokens=4096,
    )
    return text.strip(), hits
