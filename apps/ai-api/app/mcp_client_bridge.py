"""AI-API as MCP client: Streamable HTTP to ink-echo-mcp (POST /mcp)."""

from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult, ListToolsResult

from app.config import settings

T = TypeVar("T")


async def run_mcp_session(fn: Callable[[ClientSession], Awaitable[T]]) -> T:
    """Connect to ``resolved_mcp_http_url``, initialize, and run ``fn`` (one short-lived session)."""
    url = settings.resolved_mcp_http_url
    if not url:
        raise RuntimeError("mcp_http_not_configured")

    timeout = httpx.Timeout(30.0, read=300.0)
    async with httpx.AsyncClient(timeout=timeout, trust_env=True) as http_client:
        async with streamable_http_client(url, http_client=http_client) as transport:
            read_stream, write_stream, _get_session_id = transport
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                return await fn(session)


async def mcp_list_tools() -> ListToolsResult:
    async def _go(session: ClientSession) -> ListToolsResult:
        return await session.list_tools()

    return await run_mcp_session(_go)


async def mcp_call_tool(name: str, arguments: dict[str, Any] | None) -> CallToolResult:
    args = arguments if arguments is not None else {}

    async def _go(session: ClientSession) -> CallToolResult:
        return await session.call_tool(name, args)

    return await run_mcp_session(_go)
