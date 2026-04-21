"""Probe InkEcho mcp-server HTTP /health (parallel to stdio MCP; see apps/mcp-server)."""

from typing import Any

import httpx


async def probe_mcp_health(url: str, timeout_s: float = 2.0) -> dict[str, Any]:
    u = url.strip()
    if not u:
        return {"configured": True, "reachable": False, "error": "empty_url"}
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            r = await client.get(u)
            try:
                body = r.json()
            except Exception:
                body = {"raw": (r.text or "")[:500]}
            out: dict[str, Any] = {
                "configured": True,
                "reachable": r.is_success,
                "url": u,
                "status_code": r.status_code,
            }
            if r.is_success:
                out["detail"] = body
            else:
                out["error"] = "non_success_status"
                out["body"] = body
            return out
    except httpx.TimeoutException:
        return {"configured": True, "reachable": False, "url": u, "error": "timeout"}
    except httpx.RequestError as e:
        return {"configured": True, "reachable": False, "url": u, "error": str(e)}
