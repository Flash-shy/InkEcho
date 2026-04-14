from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.transcribe import require_service_token

router = APIRouter(tags=["chat"])


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)
    temperature: float = Field(default=0.3, ge=0, le=2)
    max_tokens: int = Field(default=4096, ge=64, le=128_000)


class ChatResponse(BaseModel):
    text: str


def _mock_chat(messages: list[ChatMessage]) -> str:
    last = messages[-1].content if messages else ""
    preview = (last[:200] + "…") if len(last) > 200 else last
    return (
        "(Mock LLM — no OPENAI_API_KEY or OPENROUTER_API_KEY on AI-API.)\n\n"
        f"Would summarize roughly {len(last)} characters of transcript. Preview: {preview or '(empty)'}"
    )


def _extract_openai_text(body: dict[str, Any]) -> str:
    try:
        choice = (body.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        raw = msg.get("content")
    except (IndexError, AttributeError, TypeError):
        return ""
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, list):
        parts: list[str] = []
        for block in raw:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts).strip()
    return str(raw).strip()


async def _openai_chat(req: ChatRequest) -> str:
    if not settings.openai_api_key and not settings.openai_chat_available_without_key():
        raise HTTPException(status_code=500, detail="OpenAI chat requires OPENAI_API_KEY when using api.openai.com")
    # Local Ollama / many OpenAI-compatible proxies accept any non-empty bearer; official OpenAI needs a real key.
    api_key = (settings.openai_api_key or "").strip() or "ollama"
    url = f"{settings.openai_base_url.rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload: dict[str, Any] = {
        "model": settings.openai_chat_model,
        "messages": [m.model_dump() for m in req.messages],
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
    }
    async with httpx.AsyncClient(timeout=120.0, trust_env=True) as client:
        r = await client.post(url, headers=headers, json=payload)
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"OpenAI chat error: {r.status_code} {r.text[:2500]}")
        body = r.json()
    text = _extract_openai_text(body)
    if not text:
        raise HTTPException(status_code=502, detail=f"OpenAI returned empty message: {str(body)[:800]}")
    return text


async def _openrouter_chat(req: ChatRequest) -> str:
    if not settings.openrouter_api_key:
        raise HTTPException(status_code=500, detail="OpenRouter chat requested but OPENROUTER_API_KEY is missing")
    url = f"{settings.openrouter_base_url.rstrip('/')}/chat/completions"
    referer = (settings.openrouter_http_referer or "").strip() or "https://openrouter.ai"
    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": settings.openrouter_x_title or "InkEcho",
    }
    payload: dict[str, Any] = {
        "model": settings.openrouter_chat_model,
        "messages": [m.model_dump() for m in req.messages],
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
    }
    async with httpx.AsyncClient(timeout=120.0, trust_env=True) as client:
        r = await client.post(url, headers=headers, json=payload)
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"OpenRouter chat error: {r.status_code} {r.text[:2500]}")
        body = r.json()
    text = _extract_openai_text(body)
    if not text:
        raise HTTPException(status_code=502, detail=f"OpenRouter returned empty message: {str(body)[:800]}")
    return text


@router.post("/v1/chat", response_model=ChatResponse)
async def chat(
    body: ChatRequest,
    _: None = Depends(require_service_token),
) -> ChatResponse:
    backend = settings.resolved_chat_backend()
    if backend == "openai":
        text = await _openai_chat(body)
    elif backend == "openrouter":
        text = await _openrouter_chat(body)
    else:
        text = _mock_chat(body.messages)
    return ChatResponse(text=text)
