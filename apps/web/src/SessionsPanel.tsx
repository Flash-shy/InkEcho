import { useCallback, useEffect, useState } from "react";

import { formatSegmentMeta, type TranscriptSegmentRow } from "./transcriptFormat";
import type { SessionSummaryState } from "./sessionSummary";

type SessionListItem = {
  id: string;
  status: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type SessionDetail = SessionListItem & {
  error_message?: string | null;
  summary_text?: string | null;
  summary_error?: string | null;
  summary_status?: string;
  segments: TranscriptSegmentRow[];
};

type Props = {
  active: boolean;
  sessionSummaries: Record<string, SessionSummaryState>;
  mergeSessionSummary: (sessionId: string, patch: Partial<SessionSummaryState>) => void;
};

function scrollToSummarySessions(sessionId: string): void {
  const run = () => {
    const el = document.getElementById(`summary-sessions-${sessionId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
      el.classList.add("transcript-block-targeted");
      window.setTimeout(() => el.classList.remove("transcript-block-targeted"), 1800);
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

function formatShortDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

async function downloadExport(sessionId: string, format: "md" | "txt" | "json"): Promise<void> {
  const r = await fetch(`/api/sessions/${sessionId}/export?format=${format}`);
  if (!r.ok) {
    window.alert(`${r.status} ${await r.text()}`);
    return;
  }
  const blob = await r.blob();
  const cd = r.headers.get("Content-Disposition");
  let name = `inkecho-${sessionId}.${format}`;
  const m = cd?.match(/filename="([^"]+)"/);
  if (m?.[1]) name = m[1];
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function SessionsPanel({ active, sessionSummaries, mergeSessionSummary }: Props) {
  const [list, setList] = useState<SessionListItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const r = await fetch("/api/sessions?limit=100");
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const rows = (await r.json()) as SessionListItem[];
      setList(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to load sessions");
      setList([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refreshList();
  }, [active, refreshList]);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      setDetailError(null);
      setSelectedId(id);
      try {
        const r = await fetch(`/api/sessions/${id}`);
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        const row = (await r.json()) as SessionDetail;
        setDetail(row);
        mergeSessionSummary(id, {
          summary_status: row.summary_status ?? "idle",
          summary_text: row.summary_text,
          summary_error: row.summary_error,
        });
      } catch (e) {
        setDetail(null);
        setDetailError(e instanceof Error ? e.message : "Failed to load session");
      } finally {
        setDetailLoading(false);
      }
    },
    [mergeSessionSummary],
  );

  const pollSummaryUntilDone = useCallback(
    (sessionId: string) => {
      const started = Date.now();
      const tick = async () => {
        if (Date.now() - started > 120_000) {
          mergeSessionSummary(sessionId, {
            summary_status: "error",
            summary_error: "Summary timed out — check backend and AI-API logs.",
          });
          return;
        }
        try {
          const r = await fetch(`/api/sessions/${sessionId}`);
          if (!r.ok) {
            window.setTimeout(tick, 450);
            return;
          }
          const s = (await r.json()) as SessionDetail;
          const st = s.summary_status ?? "idle";
          mergeSessionSummary(sessionId, {
            summary_status: st,
            summary_text: s.summary_text,
            summary_error: s.summary_error,
          });
          if (st === "ready" || st === "error") {
            void refreshList();
            return;
          }
        } catch {
          /* continue */
        }
        window.setTimeout(tick, 450);
      };
      void tick();
    },
    [mergeSessionSummary, refreshList],
  );

  const onSummarize = useCallback(
    async (sessionId: string) => {
      try {
        const gr = await fetch(`/api/sessions/${sessionId}`);
        if (gr.ok) {
          const s = (await gr.json()) as SessionDetail;
          if (s.summary_status === "ready" && s.summary_text?.trim()) {
            mergeSessionSummary(sessionId, {
              summary_status: "ready",
              summary_text: s.summary_text,
              summary_error: s.summary_error,
            });
            scrollToSummarySessions(sessionId);
            return;
          }
        }
      } catch {
        /* POST below */
      }

      mergeSessionSummary(sessionId, {
        summary_status: "running",
        summary_error: undefined,
      });
      try {
        const r = await fetch(`/api/sessions/${sessionId}/summarize`, { method: "POST" });
        if (!r.ok) {
          const msg = await r.text();
          mergeSessionSummary(sessionId, {
            summary_status: "error",
            summary_error: `${r.status} ${msg}`,
          });
          return;
        }
        pollSummaryUntilDone(sessionId);
      } catch (e) {
        mergeSessionSummary(sessionId, {
          summary_status: "error",
          summary_error: e instanceof Error ? e.message : "Summarize request failed",
        });
      }
    },
    [mergeSessionSummary, pollSummaryUntilDone],
  );

  const mergedSummary: SessionSummaryState | null = detail
    ? {
        summary_status:
          sessionSummaries[detail.id]?.summary_status ?? detail.summary_status ?? "idle",
        summary_text: sessionSummaries[detail.id]?.summary_text ?? detail.summary_text,
        summary_error: sessionSummaries[detail.id]?.summary_error ?? detail.summary_error,
      }
    : null;

  const sumStatus = mergedSummary?.summary_status ?? "idle";
  const summarizing = sumStatus === "running";
  const segs = detail?.segments ?? [];
  const canSummarize = detail?.status === "ready" && segs.length > 0;
  const hasSummary = sumStatus === "ready" && Boolean(mergedSummary?.summary_text?.trim());

  return (
    <div className="sessions-panel">
      <p className="muted panel-lead">Open a session to view, summarize, or export.</p>

      <div className="sessions-toolbar">
        <button type="button" className="btn btn-small" onClick={() => void refreshList()} disabled={listLoading}>
          {listLoading ? "Loading…" : "Refresh list"}
        </button>
      </div>

      {listError && (
        <div className="banner-err" role="alert">
          {listError}
        </div>
      )}

      <div className="sessions-layout">
        <aside className="sessions-list-card card-inner">
          <strong className="sessions-list-title">Recent ({list.length})</strong>
          {list.length === 0 && !listLoading && <p className="muted">No sessions yet. Run STT from Transcribe.</p>}
          <ul className="sessions-list">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`sessions-list-item ${selectedId === s.id ? "sessions-list-item-active" : ""}`}
                  onClick={() => void loadDetail(s.id)}
                >
                  <span className="sessions-list-status">{s.status}</span>
                  <span className="sessions-list-title-text">{s.title || "(untitled)"}</span>
                  <span className="sessions-list-date muted">{formatShortDate(s.created_at)}</span>
                  <code className="sessions-list-id">{s.id.slice(0, 8)}…</code>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="sessions-detail">
          {detailLoading && (
            <p className="muted">
              <span className="spinner" aria-hidden /> Loading session…
            </p>
          )}
          {detailError && (
            <div className="banner-err" role="alert">
              {detailError}
            </div>
          )}
          {!detailLoading && detail && (
            <section className="transcript-block">
              <p className="muted transcribe-meta">
                Session <code>{detail.id}</code>
                {detail.title != null && detail.title !== "" && (
                  <>
                    {" · "}
                    <span className="clip-queue-name">{detail.title}</span>
                  </>
                )}
              </p>
              <p className="muted transcribe-meta">
                Status <strong>{detail.status}</strong>
                {detail.error_message ? (
                  <>
                    {" · "}
                    <span className="sessions-err-note">{detail.error_message}</span>
                  </>
                ) : null}
              </p>

              <div className="transcript-actions">
                <button
                  type="button"
                  className={`btn btn-small ${hasSummary ? "btn-secondary" : "btn-primary"}`}
                  disabled={!canSummarize || summarizing}
                  title={
                    !canSummarize
                      ? "Need status ready and at least one segment"
                      : hasSummary
                        ? "Scroll to summary (no API call)."
                        : "Generate summary via AI-API."
                  }
                  onClick={() => {
                    if (hasSummary) scrollToSummarySessions(detail.id);
                    else void onSummarize(detail.id);
                  }}
                >
                  {summarizing ? "Summarizing…" : hasSummary ? "View summary" : "Summarize"}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={summarizing}
                  onClick={() => void downloadExport(detail.id, "md")}
                >
                  Export .md
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={summarizing}
                  onClick={() => void downloadExport(detail.id, "txt")}
                >
                  Export .txt
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={summarizing}
                  onClick={() => void downloadExport(detail.id, "json")}
                >
                  Export .json
                </button>
              </div>

              {mergedSummary?.summary_error && (
                <div className="banner-err" role="alert">
                  {mergedSummary.summary_error}
                </div>
              )}
              {mergedSummary?.summary_text && sumStatus === "ready" && (
                <div className="summary-block" id={`summary-sessions-${detail.id}`}>
                  <h4 className="summary-h">Summary</h4>
                  <pre className="summary-pre">{mergedSummary.summary_text}</pre>
                </div>
              )}

              <h3 className="transcribe-result-h">Transcript</h3>
              {segs.length === 0 ? (
                <p className="muted">No segments yet (upload audio from Transcribe or wait for STT).</p>
              ) : (
                <ol className="segment-list">
                  {segs.map((s) => (
                    <li key={s.id} className="segment-item">
                      <div className="segment-meta muted">{formatSegmentMeta(s, segs)}</div>
                      <div className="segment-text">{s.text}</div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
          {!detailLoading && !detail && !detailError && (
            <p className="muted">Select a session on the left.</p>
          )}
        </div>
      </div>
    </div>
  );
}
