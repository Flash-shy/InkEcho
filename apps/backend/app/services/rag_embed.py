import json
from typing import Any

import httpx

from app.config import settings


async def embed_texts(texts: list[str]) -> tuple[list[list[float]], str]:
    """Call AI-API /v1/embeddings (batched)."""
    url = f"{settings.ai_api_base_url.rstrip('/')}/v1/embeddings"
    headers = {
        "Authorization": f"Bearer {settings.ai_api_service_token}",
        "Content-Type": "application/json",
    }
    batch_size = 32
    all_vectors: list[list[float]] = []
    model_name = ""
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        payload: dict[str, Any] = {"inputs": batch}
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
            raise RuntimeError(f"AI-API embeddings {r.status_code}: {detail}"[:4000])
        data = r.json()
        embs = data.get("embeddings")
        if not isinstance(embs, list) or len(embs) != len(batch):
            raise RuntimeError("AI-API embeddings: bad response shape")
        all_vectors.extend([list(map(float, row)) for row in embs])
        model_name = str(data.get("model") or model_name or "unknown")
    return all_vectors, model_name


def parse_embedding_json(raw: str) -> list[float]:
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("embedding_json must be a JSON array")
    return [float(x) for x in data]
