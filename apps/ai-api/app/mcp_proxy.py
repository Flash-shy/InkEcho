"""Expose MCP protocol operations (list/call tools) via HTTP for trusted callers (e.g. backend)."""

from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.mcp_client_bridge import mcp_call_tool, mcp_list_tools
from app.transcribe import require_service_token

router = APIRouter(tags=["mcp-client"])


class CallToolBody(BaseModel):
    name: str = Field(min_length=1)
    arguments: dict[str, Any] = Field(default_factory=dict)


@router.get("/v1/mcp/tools")
async def http_list_mcp_tools(_: None = Depends(require_service_token)) -> dict[str, Any]:
    """List tools from ink-echo-mcp via Streamable HTTP (same as Cursor calling ``list_tools``)."""
    try:
        result = await mcp_list_tools()
        return result.model_dump(mode="json")
    except RuntimeError as e:
        if str(e) == "mcp_http_not_configured":
            raise HTTPException(
                status_code=503,
                detail="MCP HTTP URL not configured (set MCP_HEALTH_URL or MCP_HTTP_URL)",
            ) from e
        raise HTTPException(status_code=503, detail=str(e)) from e
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"mcp_http_error: {e}") from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"mcp_client_error: {e}") from e


@router.post("/v1/mcp/tools/call")
async def http_call_mcp_tool(
    body: CallToolBody,
    _: None = Depends(require_service_token),
) -> dict[str, Any]:
    """Invoke a tool on ink-echo-mcp via Streamable HTTP (same as Cursor ``call_tool``)."""
    try:
        result = await mcp_call_tool(body.name, body.arguments)
        return result.model_dump(mode="json")
    except RuntimeError as e:
        if str(e) == "mcp_http_not_configured":
            raise HTTPException(
                status_code=503,
                detail="MCP HTTP URL not configured (set MCP_HEALTH_URL or MCP_HTTP_URL)",
            ) from e
        raise HTTPException(status_code=503, detail=str(e)) from e
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"mcp_http_error: {e}") from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"mcp_client_error: {e}") from e
