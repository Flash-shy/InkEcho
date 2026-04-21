import { useCallback, useEffect, useRef, useState } from "react";

type PlatformCheck = {
  id: string;
  label: string;
  ok: boolean;
  error?: string | null;
  /** e.g. bundled skills from AI-API, or MCP /health platform_detail fallback */
  detail?: string | null;
};

type PlatformResponse = {
  server_all_ok: boolean;
  checks: PlatformCheck[];
};

type Props = {
  /** When false, backend /api unreachable — menu still opens but shows error state */
  apiUnreachable: boolean;
};

export function PlatformStatusMenu({ apiUnreachable }: Props) {
  const [open, setOpen] = useState(false);
  /** True until the first in-flight /api/health/platform request finishes (avoids “unknown” flash). */
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<PlatformResponse | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFetchErr(null);
    try {
      const r = await fetch("/api/health/platform");
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      setData((await r.json()) as PlatformResponse);
    } catch (e) {
      setData(null);
      setFetchErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  /** Prefetch so the header pill reflects reality without opening the menu (was stuck in “pending” pulse). */
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const serverChecks = data?.checks ?? [];
  const checks: PlatformCheck[] = apiUnreachable
    ? [
        { id: "backend", label: "Backend API", ok: false, error: "Cannot reach API", detail: null },
        { id: "frontend", label: "Web frontend", ok: false, error: "—", detail: null },
        { id: "ai_api", label: "AI-API", ok: false, error: "—", detail: null },
        { id: "mcp", label: "MCP & skills", ok: false, error: "—", detail: null },
      ]
    : serverChecks;

  const allOk =
    !apiUnreachable &&
    !fetchErr &&
    data?.server_all_ok === true &&
    checks.every((c) => c.ok);

  /** Pulse only while a request is in flight — not when we simply haven’t loaded yet (closed menu). */
  const pillClass = allOk
    ? "status-pill-on"
    : loading
      ? "status-pill-pending"
      : fetchErr || apiUnreachable || data != null
        ? "status-pill-off"
        : "status-pill-muted";

  return (
    <div className="platform-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`status-pill status-pill-menu ${pillClass}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="status-pill-dot" aria-hidden />
        {allOk ? "All systems" : "Status"}
        <span className="platform-chevron" aria-hidden />
      </button>
      {open && (
        <div className="platform-dropdown" role="menu">
          <div className="platform-dropdown-head">Platform</div>
          {loading && <div className="platform-dropdown-loading muted">Loading…</div>}
          {fetchErr && !apiUnreachable && (
            <div className="platform-dropdown-err">{fetchErr}</div>
          )}
          <ul className="platform-check-list">
            {checks.map((c) => (
              <li key={c.id} className={`platform-check-row ${c.ok ? "platform-check-ok" : "platform-check-bad"}`}>
                <span className="platform-check-dot" aria-hidden />
                <span className="platform-check-label">
                  {c.label}
                  {c.detail ? <span className="platform-check-count muted"> {c.detail}</span> : null}
                </span>
                <span className="platform-check-state">{c.ok ? "OK" : "Issue"}</span>
                {c.error ? <span className="platform-check-detail muted">{c.error}</span> : null}
              </li>
            ))}
          </ul>
          <button type="button" className="platform-refresh btn btn-small" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
