import hashlib
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.transcribe import require_service_token

router = APIRouter(tags=["embeddings"])


class EmbeddingsRequest(BaseModel):
    inputs: list[str] = Field(..., min_length=1, max_length=64)
    """Texts to embed in batch (OpenAI-compatible)."""


class EmbeddingsResponse(BaseModel):
    model: str
    embeddings: list[list[float]]
    dimensions: int


def _mock_embeddings(inputs: list[str]) -> tuple[list[list[float]], str, int]:
    """Deterministic pseudo-embeddings for pipeline tests when no API keys (weak retrieval)."""
    dim = settings.mock_embed_dimensions
    model = "mock-deterministic"
    out: list[list[float]] = []
    for text in inputs:
        vec: list[float] = []
        seed = text.encode("utf-8")
        while len(vec) < dim:
            seed = hashlib.sha256(seed).digest()
            for b in seed:
                vec.append((b / 255.0) * 2.0 - 1.0)
        vec = vec[:dim]
        norm = sum(x * x for x in vec) ** 0.5 or 1.0
        out.append([x / norm for x in vec])
    return out, model, dim


async def _openai_embeddings(inputs: list[str]) -> tuple[list[list[float]], str, int]:
    if not settings.openai_api_key and not settings.openai_chat_available_without_key():
        raise HTTPException(status_code=500, detail="OpenAI embeddings require OPENAI_API_KEY when using api.openai.com")
    api_key = (settings.openai_api_key or "").strip() or "ollama"
    url = f"{settings.openai_base_normalized}/embeddings"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload: dict[str, Any] = {"model": settings.openai_embed_model, "input": inputs}
    async with httpx.AsyncClient(timeout=120.0, trust_env=True) as client:
        r = await client.post(url, headers=headers, json=payload)
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"OpenAI embeddings error: {r.status_code} {r.text[:2500]}")
        body = r.json()
    data = body.get("data") or []
    if len(data) != len(inputs):
        raise HTTPException(status_code=502, detail="OpenAI embeddings: data length mismatch")
    vectors: list[list[float]] = []
    for item in data:
        emb = item.get("embedding")
        if not isinstance(emb, list):
            raise HTTPException(status_code=502, detail="OpenAI embeddings: bad embedding shape")
        vectors.append([float(x) for x in emb])
    dim = len(vectors[0]) if vectors else 0
    used_model = str(body.get("model") or settings.openai_embed_model)
    return vectors, used_model, dim


async def _openrouter_embeddings(inputs: list[str]) -> tuple[list[list[float]], str, int]:
    if not settings.openrouter_api_key:
        raise HTTPException(status_code=500, detail="OpenRouter embeddings require OPENROUTER_API_KEY")
    url = f"{settings.openrouter_base_url.rstrip('/')}/embeddings"
    referer = (settings.openrouter_http_referer or "").strip() or "https://openrouter.ai"
    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": settings.openrouter_x_title or "InkEcho",
    }
    payload: dict[str, Any] = {"model": settings.openrouter_embed_model, "input": inputs}
    async with httpx.AsyncClient(timeout=120.0, trust_env=True) as client:
        r = await client.post(url, headers=headers, json=payload)
        if r.status_code >= 400:
            raw = r.text[:2500]
            hint = ""
            low = raw.lower()
            if r.status_code == 403 or "terms of service" in low or "violation" in low:
                hint = (
                    " — Tip: OpenRouter frequently blocks openai/* embedding models (403 ToS). "
                    "Set OPENROUTER_EMBED_MODEL=intfloat/e5-base-v2 (repo default) or another embeddings model from "
                    "https://openrouter.ai/models?output_modalities=embeddings ; or use EMBED_PROVIDER=openai with "
                    "OPENAI_API_KEY. Restart AI-API, then Re-index sessions (Ask tab)."
                )
            raise HTTPException(status_code=502, detail=f"OpenRouter embeddings error: {r.status_code} {raw}{hint}")
        body = r.json()
    data = body.get("data") or []
    if len(data) != len(inputs):
        raise HTTPException(status_code=502, detail="OpenRouter embeddings: data length mismatch")
    vectors: list[list[float]] = []
    for item in data:
        emb = item.get("embedding")
        if not isinstance(emb, list):
            raise HTTPException(status_code=502, detail="OpenRouter embeddings: bad embedding shape")
        vectors.append([float(x) for x in emb])
    dim = len(vectors[0]) if vectors else 0
    used_model = str(body.get("model") or settings.openrouter_embed_model)
    return vectors, used_model, dim


@router.post("/v1/embeddings", response_model=EmbeddingsResponse)
async def embeddings(
    body: EmbeddingsRequest,
    _: None = Depends(require_service_token),
) -> EmbeddingsResponse:
    backend = settings.resolved_embed_backend()
    if backend == "openai":
        vectors, model, dim = await _openai_embeddings(body.inputs)
    elif backend == "openrouter":
        vectors, model, dim = await _openrouter_embeddings(body.inputs)
    else:
        vectors, model, dim = _mock_embeddings(body.inputs)
    return EmbeddingsResponse(model=model, embeddings=vectors, dimensions=dim)
