import httpx
from fastapi import APIRouter

from app.config import settings

router = APIRouter(tags=["health"])


async def _check_frontend() -> tuple[bool, str | None]:
    url = f"{settings.frontend_public_url.rstrip('/')}/"
    try:
        async with httpx.AsyncClient(timeout=4.0, follow_redirects=True) as client:
            r = await client.get(url)
        if r.status_code < 400:
            return True, None
        return False, f"HTTP {r.status_code}: {r.text[:120]}"
    except Exception as e:
        return False, str(e)[:400]


async def _check_ai_api() -> tuple[bool, str | None]:
    url = f"{settings.ai_api_base_url.rstrip('/')}/health"
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(url)
        if r.status_code < 400:
            return True, None
        return False, f"HTTP {r.status_code}: {r.text[:200]}"
    except Exception as e:
        return False, str(e)[:400]


def _mcp_skills_catalog_url() -> str | None:
    """Derive http://host:port/skills from MCP_HEALTH_URL (…/health)."""
    u = settings.mcp_health_url.strip()
    if not u:
        return None
    u = u.rstrip("/")
    if u.endswith("/health"):
        u = u[: -len("/health")].rstrip("/")
    return u + "/skills"


async def _fetch_bundled_skills_line() -> str | None:
    """Human-facing summary from ink-echo-mcp GET /skills (bundled SKILL.md tree)."""
    url = _mcp_skills_catalog_url()
    if not url:
        return None
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(url)
        if r.status_code >= 400:
            return None
        data = r.json()
        skills = data.get("skills")
        if not isinstance(skills, list) or not skills:
            return None
        ids: list[str] = []
        for s in skills:
            if isinstance(s, dict) and isinstance(s.get("id"), str):
                ids.append(s["id"])
        if not ids:
            return None
        ids.sort()
        return f"Skills ({len(ids)}): " + ", ".join(ids)
    except Exception:
        return None


def _mcp_platform_detail(body: dict) -> str | None:
    """Prefer ink-echo-mcp `platform_detail`; else legacy `instances` x/y."""
    pd = body.get("platform_detail")
    if isinstance(pd, str) and pd.strip():
        return pd.strip()
    inst = body.get("instances") or {}
    try:
        expected = int(inst.get("expected", 1))
        healthy = int(inst.get("healthy", 0))
    except (TypeError, ValueError):
        return None
    if expected < 1:
        return None
    return f"{healthy}/{expected}"


async def _check_mcp() -> tuple[bool, str | None, str | None]:
    """Probe MCP HTTP /health; detail describes the responding process (pid, mode, port)."""
    url = settings.mcp_health_url.strip()
    if not url:
        return False, "MCP_HEALTH_URL not configured", None
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(url)
        if r.status_code >= 400:
            return False, f"HTTP {r.status_code}", None
        try:
            body = r.json()
        except Exception:
            return False, "Invalid JSON", None
        if not body.get("ok"):
            return False, "Health body ok=false", None
        detail = _mcp_platform_detail(body)
        inst = body.get("instances") or {}
        if inst:
            try:
                expected = int(inst.get("expected", 1))
                healthy = int(inst.get("healthy", 0))
            except (TypeError, ValueError):
                return False, "Invalid MCP instances in health JSON", detail
            if expected < 1:
                return False, "invalid instances.expected", detail
            if healthy != expected:
                return False, f"MCP instances {healthy}/{expected}", detail
        return True, None, detail
    except Exception as e:
        msg = str(e).strip()[:400]
        low = msg.lower()
        if any(
            s in low
            for s in (
                "disconnected",
                "refused",
                "failed to connect",
                "connecterror",
                "connection reset",
                "errno",
                "timed out",
                "timeout",
                "name or service not known",
            )
        ):
            msg = (
                f"{msg} — ink-echo-mcp must expose GET /health (see MCP_HEALTH_URL). "
                "Start `./scripts/dev-all.sh` or `npm run build:mcp && node apps/mcp-server/dist/index.js`."
            )[:600]
        return False, msg, None


@router.get("/health/platform")
async def platform_health():
    """Aggregated checks for the web status menu: Backend, Web, AI-API, MCP."""
    fe_ok, fe_err = await _check_frontend()
    ai_ok, ai_err = await _check_ai_api()
    mcp_ok, mcp_err, mcp_tech_detail = await _check_mcp()
    skills_line = await _fetch_bundled_skills_line()
    # Prefer listing bundled Agent Skills (GET /skills on mcp-server) over raw MCP /health line.
    mcp_detail: str | None = skills_line if (mcp_ok and skills_line) else mcp_tech_detail

    checks: list[dict[str, object]] = [
        {"id": "backend", "label": "Backend API", "ok": True, "error": None, "detail": None},
        {"id": "frontend", "label": "Web frontend", "ok": fe_ok, "error": fe_err, "detail": None},
        {"id": "ai_api", "label": "AI-API", "ok": ai_ok, "error": ai_err, "detail": None},
        {"id": "mcp", "label": "MCP & skills", "ok": mcp_ok, "error": mcp_err, "detail": mcp_detail},
    ]
    server_all_ok = all(bool(c["ok"]) for c in checks)
    return {"server_all_ok": server_all_ok, "checks": checks}
