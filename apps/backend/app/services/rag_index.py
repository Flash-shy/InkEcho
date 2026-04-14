import json
import logging
import uuid

from sqlalchemy import delete, select

from app.config import settings
from app.db import SessionLocal
from app.models import Session as InkSession
from app.models import TranscriptRagChunk, TranscriptSegment
from app.services.rag_embed import embed_texts

logger = logging.getLogger(__name__)


def build_transcript_chunks(
    segments: list[TranscriptSegment],
    max_chars: int,
) -> list[tuple[str, int, int]]:
    """Return (text, segment_start_seq, segment_end_seq) for each chunk."""
    ordered = sorted(segments, key=lambda s: s.seq)
    out: list[tuple[str, int, int]] = []
    buf: list[TranscriptSegment] = []

    def flush_buf() -> None:
        nonlocal buf
        if not buf:
            return
        text = " ".join(x.text.strip() for x in buf if x.text.strip())
        if text:
            out.append((text, buf[0].seq, buf[-1].seq))
        buf = []

    for seg in ordered:
        raw = seg.text.strip()
        if not raw:
            continue
        if len(raw) > max_chars:
            flush_buf()
            for i in range(0, len(raw), max_chars):
                chunk = raw[i : i + max_chars].strip()
                if chunk:
                    out.append((chunk, seg.seq, seg.seq))
            continue
        joined = " ".join(x.text.strip() for x in buf + [seg] if x.text.strip())
        if len(joined) > max_chars and buf:
            flush_buf()
            buf = [seg]
        else:
            buf.append(seg)
    flush_buf()
    return out


async def index_session_for_rag(session_id: uuid.UUID) -> int:
    """Rebuild RAG chunks + embeddings for one session. Returns number of chunks indexed."""
    max_chars = settings.rag_chunk_max_chars
    async with SessionLocal() as db:
        row = await db.get(InkSession, session_id)
        if not row:
            return 0
        await db.execute(delete(TranscriptRagChunk).where(TranscriptRagChunk.session_id == session_id))
        await db.commit()

        q = await db.execute(
            select(TranscriptSegment)
            .where(TranscriptSegment.session_id == session_id)
            .order_by(TranscriptSegment.seq)
        )
        segs = list(q.scalars().all())

    if not segs:
        return 0

    chunks = build_transcript_chunks(segs, max_chars)
    if not chunks:
        return 0

    texts = [c[0] for c in chunks]
    try:
        vectors, model_name = await embed_texts(texts)
    except Exception:
        logger.exception("RAG embed failed for session %s", session_id)
        raise

    if len(vectors) != len(chunks):
        raise RuntimeError("embedding count mismatch")

    async with SessionLocal() as db:
        for idx, ((text, start_seq, end_seq), vec) in enumerate(zip(chunks, vectors, strict=True)):
            db.add(
                TranscriptRagChunk(
                    session_id=session_id,
                    chunk_index=idx,
                    text=text,
                    segment_start_seq=start_seq,
                    segment_end_seq=end_seq,
                    embedding_model=model_name[:256],
                    embedding_json=json.dumps(vec),
                )
            )
        await db.commit()
    return len(chunks)
