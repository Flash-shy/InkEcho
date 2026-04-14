import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { type CaptureKind, captureKindMeta } from "./captureTypes";
import { formatSegmentMeta, type TranscriptSegmentRow } from "./transcriptFormat";
import type { SessionSummaryState } from "./sessionSummary";

export type TranscribeClip = { id: string; blob: Blob; label: string; captureKind: CaptureKind };

type WsSegment = TranscriptSegmentRow;

function extFromBlob(blob: Blob): string {
  const t = blob.type;
  if (t.includes("webm")) return "webm";
  if (t.includes("mp4")) return "mp4";
  if (t.includes("wav")) return "wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("ogg")) return "ogg";
  return "bin";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** One finished transcription (kept when user runs another clip). */
type CompletedTranscript = {
  key: string;
  /** Queue row id — re-transcribing the same clip replaces the previous completed block. */
  clipId: string;
  clipLabel: string;
  segments: WsSegment[];
};

type ApiSession = {
  summary_status?: string;
  summary_text?: string | null;
  summary_error?: string | null;
};

type Props = {
  clips: TranscribeClip[];
  onRemoveClip: (id: string) => void;
  onClearQueue: () => void;
  sessionSummaries: Record<string, SessionSummaryState>;
  mergeSessionSummary: (sessionId: string, patch: Partial<SessionSummaryState>) => void;
};

export function TranscribePanel({
  clips,
  onRemoveClip,
  onClearQueue,
  sessionSummaries,
  mergeSessionSummary,
}: Props) {
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [segments, setSegments] = useState<WsSegment[]>([]);
  const [resultLabel, setResultLabel] = useState<string | null>(null);
  const [runningClipId, setRunningClipId] = useState<string | null>(null);
  const [completedTranscripts, setCompletedTranscripts] = useState<CompletedTranscript[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const resultsAnchorRef = useRef<HTMLDivElement | null>(null);
  /** Latest segments for this run (updated in segment handler). Avoids nested setState on transcribe_done (Strict Mode double-invokes updaters → duplicate history rows). */
  const segmentsRef = useRef<WsSegment[]>([]);

  const scrollResultsIntoView = useCallback(() => {
    const el = resultsAnchorRef.current;
    if (!el) return;
    const run = () => el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    requestAnimationFrame(() => requestAnimationFrame(run));
  }, []);

  const teardownWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => teardownWs();
  }, [teardownWs]);

  /** After status / errors paint, keep the progress + transcript block in view (nearest often no-ops). */
  useLayoutEffect(() => {
    if (phase !== "running" || !runningClipId) return;
    scrollResultsIntoView();
  }, [phase, runningClipId, scrollResultsIntoView]);

  useLayoutEffect(() => {
    if (!error) return;
    scrollResultsIntoView();
  }, [error, scrollResultsIntoView]);

  useLayoutEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  /** Queue emptied: reset last run UI. */
  useEffect(() => {
    if (clips.length > 0) return;
    teardownWs();
    setSegments([]);
    segmentsRef.current = [];
    setCompletedTranscripts([]);
    setSessionId(null);
    setError(null);
    setStatusLine(null);
    setPhase("idle");
    setResultLabel(null);
    setRunningClipId(null);
  }, [clips.length, teardownWs]);

  const keysSig = completedTranscripts.map((t) => t.key).join(",");

  useEffect(() => {
    if (!keysSig) return;
    const keys = keysSig.split(",");
    let cancelled = false;
    void (async () => {
      const pairs = await Promise.all(
        keys.map(async (k) => {
          try {
            const r = await fetch(`/api/sessions/${k}`);
            if (!r.ok) return null;
            const s = (await r.json()) as ApiSession;
            return [
              k,
              {
                summary_status: s.summary_status ?? "idle",
                summary_text: s.summary_text,
                summary_error: s.summary_error,
              },
            ] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      for (const p of pairs) {
        if (!p) continue;
        const [k, st] = p;
        mergeSessionSummary(k, st);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keysSig, mergeSessionSummary]);

  const pollSummaryUntilDone = useCallback((sessionKey: string) => {
    const started = Date.now();
    const tick = async () => {
      if (Date.now() - started > 120_000) {
        mergeSessionSummary(sessionKey, {
          summary_status: "error",
          summary_error: "Summary timed out — check backend and AI-API logs.",
        });
        return;
      }
      try {
        const r = await fetch(`/api/sessions/${sessionKey}`);
        if (!r.ok) {
          window.setTimeout(tick, 450);
          return;
        }
        const s = (await r.json()) as ApiSession;
        const st = s.summary_status ?? "idle";
        mergeSessionSummary(sessionKey, {
          summary_status: st,
          summary_text: s.summary_text,
          summary_error: s.summary_error,
        });
        if (st === "ready" || st === "error") return;
      } catch {
        /* continue polling */
      }
      window.setTimeout(tick, 450);
    };
    void tick();
  }, [mergeSessionSummary]);

  const onSummarize = useCallback(
    async (sessionKey: string) => {
      try {
        const gr = await fetch(`/api/sessions/${sessionKey}`);
        if (gr.ok) {
          const s = (await gr.json()) as ApiSession & {
            summary_status?: string;
            summary_text?: string | null;
            summary_error?: string | null;
          };
          if (s.summary_status === "ready" && s.summary_text?.trim()) {
            mergeSessionSummary(sessionKey, {
              summary_status: "ready",
              summary_text: s.summary_text,
              summary_error: s.summary_error,
            });
            requestAnimationFrame(() => {
              const el = document.getElementById(`summary-transcribe-${sessionKey}`);
              if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
                el.classList.add("transcript-block-targeted");
                window.setTimeout(() => el.classList.remove("transcript-block-targeted"), 1800);
              }
            });
            return;
          }
        }
      } catch {
        /* fall through to POST */
      }

      mergeSessionSummary(sessionKey, {
        summary_status: "running",
        summary_error: undefined,
      });
      try {
        const r = await fetch(`/api/sessions/${sessionKey}/summarize`, { method: "POST" });
        if (!r.ok) {
          const msg = await r.text();
          mergeSessionSummary(sessionKey, {
            summary_status: "error",
            summary_error: `${r.status} ${msg}`,
          });
          return;
        }
        pollSummaryUntilDone(sessionKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Summarize request failed";
        mergeSessionSummary(sessionKey, { summary_status: "error", summary_error: msg });
      }
    },
    [pollSummaryUntilDone, mergeSessionSummary],
  );

  const onExport = useCallback(async (sessionKey: string, format: "md" | "txt" | "json") => {
    try {
      const r = await fetch(`/api/sessions/${sessionKey}/export?format=${format}`);
      if (!r.ok) {
        window.alert(`${r.status} ${await r.text()}`);
        return;
      }
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition");
      let name = `inkecho-${sessionKey}.${format}`;
      const m = cd?.match(/filename="([^"]+)"/);
      if (m?.[1]) name = m[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Export failed");
    }
  }, []);

  const onTranscribe = useCallback(
    async (clip: TranscribeClip) => {
      teardownWs();
      setError(null);
      setSegments([]);
      segmentsRef.current = [];
      setSessionId(null);
      setResultLabel(clip.label);
      setRunningClipId(clip.id);
      setPhase("running");
      setStatusLine("Creating session…");
      scrollResultsIntoView();
      window.setTimeout(scrollResultsIntoView, 150);
      window.setTimeout(scrollResultsIntoView, 400);

      let sid: string;
      try {
        const cr = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!cr.ok) throw new Error(`${cr.status} ${await cr.text()}`);
        const created = (await cr.json()) as { id: string };
        sid = created.id;
        setSessionId(sid);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not create session";
        setError(msg);
        setPhase("error");
        setStatusLine(null);
        setRunningClipId(null);
        window.setTimeout(scrollResultsIntoView, 0);
        return;
      }

      setStatusLine("Connecting live updates…");
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/api/ws/sessions/${sid}`);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as
            | { type: "segment"; data: WsSegment }
            | { type: "status"; status: string }
            | { type: "transcribe_done" }
            | { type: "transcribe_error"; message: string };
          if (msg.type === "segment") {
            setSegments((prev) => {
              const next = [...prev, msg.data];
              next.sort((a, b) => a.seq - b.seq);
              segmentsRef.current = next;
              if (prev.length === 0) {
                requestAnimationFrame(() => {
                  resultsAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
                });
              }
              return next;
            });
          } else if (msg.type === "status") {
            setStatusLine(msg.status === "transcribing" ? "Transcribing…" : msg.status);
          } else if (msg.type === "transcribe_done") {
            const finalSegs = segmentsRef.current;
            setCompletedTranscripts((prev) => {
              if (finalSegs.length === 0) return prev;
              if (prev.some((p) => p.key === sid)) return prev;
              const nextRow: CompletedTranscript = {
                key: sid,
                clipId: clip.id,
                clipLabel: clip.label,
                segments: finalSegs.map((s) => ({ ...s })),
              };
              return [...prev.filter((p) => p.clipId !== clip.id), nextRow];
            });
            setSegments([]);
            segmentsRef.current = [];
            setPhase("done");
            setStatusLine("Done");
            setRunningClipId(null);
            setSessionId(null);
            setResultLabel(null);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                document
                  .getElementById(`transcript-block-${sid}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
              });
            });
          } else if (msg.type === "transcribe_error") {
            setError(msg.message);
            setPhase("error");
            setStatusLine(null);
            setRunningClipId(null);
            requestAnimationFrame(scrollResultsIntoView);
          }
        } catch {
          /* ignore */
        }
      };

      ws.onerror = () => {
        setError((prev) => prev ?? "WebSocket error");
        setPhase("error");
        setRunningClipId(null);
        scrollResultsIntoView();
      };

      ws.onopen = () => {
        setStatusLine("Uploading audio…");
        const fd = new FormData();
        const name = `clip-${Date.now()}.${extFromBlob(clip.blob)}`;
        fd.append("file", clip.blob, name);
        void fetch(`/api/sessions/${sid}/audio`, { method: "POST", body: fd }).then(async (r) => {
          if (!r.ok) {
            setError(`${r.status} ${await r.text()}`);
            setPhase("error");
            setStatusLine(null);
            setRunningClipId(null);
            teardownWs();
            scrollResultsIntoView();
          }
        });
      };
    },
    [scrollResultsIntoView, teardownWs],
  );

  const scrollToTranscriptBlock = useCallback((sessionKey: string) => {
    const run = () => {
      const el = document.getElementById(`transcript-block-${sessionKey}`);
      el?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
      el?.classList.add("transcript-block-targeted");
      window.setTimeout(() => el?.classList.remove("transcript-block-targeted"), 1800);
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  }, []);

  const scrollToSummaryBlock = useCallback(
    (sessionKey: string) => {
      const run = () => {
        const el = document.getElementById(`summary-transcribe-${sessionKey}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
          el.classList.add("transcript-block-targeted");
          window.setTimeout(() => el.classList.remove("transcript-block-targeted"), 1800);
        } else {
          scrollToTranscriptBlock(sessionKey);
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(run));
    },
    [scrollToTranscriptBlock],
  );

  const onClipPrimaryAction = useCallback(
    (clip: TranscribeClip) => {
      const done = completedTranscripts.find((p) => p.clipId === clip.id && p.segments.length > 0);
      const thisClipRunning = phase === "running" && runningClipId === clip.id;
      if (done && !thisClipRunning) {
        scrollToTranscriptBlock(done.key);
        return;
      }
      void onTranscribe(clip);
    },
    [completedTranscripts, phase, runningClipId, onTranscribe, scrollToTranscriptBlock],
  );

  const busy = phase === "running";

  /** While re-running a clip, hide its previous completed block (still in state if the run fails). */
  const visibleCompletedTranscripts = completedTranscripts.filter(
    (run) => !(phase === "running" && runningClipId != null && run.clipId === runningClipId),
  );

  const showTimingExplainer =
    visibleCompletedTranscripts.some(
      (r) => r.segments.length > 0 && r.segments.every((x) => x.start_ms == null && x.end_ms == null),
    ) ||
    (segments.length > 0 && segments.every((x) => x.start_ms == null && x.end_ms == null));

  return (
    <div className="transcribe">
      {clips.length === 0 && (
        <p className="muted panel-lead">Add clips from Listen, then run speech-to-text per row.</p>
      )}

      {clips.length > 0 && (
        <div className="card-inner transcribe-queue">
          <div className="transcribe-queue-head">
            <strong>Queue ({clips.length})</strong>
            <button type="button" className="btn btn-danger btn-small" onClick={onClearQueue} disabled={busy}>
              Clear all
            </button>
          </div>
          <ul className="clip-queue">
            {clips.map((c) => {
              const meta = captureKindMeta(c.captureKind);
              const hasCompletedTranscript = completedTranscripts.some(
                (p) => p.clipId === c.id && p.segments.length > 0,
              );
              const thisClipRunning = busy && runningClipId === c.id;
              const primaryDisabled = thisClipRunning || (busy && !hasCompletedTranscript);
              const primaryLabel = thisClipRunning
                ? "Transcribing…"
                : hasCompletedTranscript
                  ? "View transcript"
                  : "Transcribe";
              return (
                <li key={c.id} className={`clip-queue-item clip-queue-item-${c.captureKind}`}>
                  <div className="clip-queue-meta">
                    <div className="clip-queue-badges">
                      <span className={`clip-kind-badge clip-kind-${c.captureKind}`} title={meta.hint}>
                        {meta.tag}
                      </span>
                    </div>
                    <span className="clip-queue-name">{c.label}</span>
                    <span className="clip-queue-hint muted">{meta.hint}</span>
                    <span className="muted">{formatSize(c.blob.size)}</span>
                  </div>
                  <div className="clip-queue-actions">
                    <button
                      type="button"
                      className={`btn btn-small ${hasCompletedTranscript && !thisClipRunning ? "btn-secondary" : "btn-primary"}`}
                      onClick={() => onClipPrimaryAction(c)}
                      disabled={primaryDisabled}
                      title={
                        hasCompletedTranscript
                          ? "Scroll to this clip’s transcript (no new API call). Re-run STT: remove the clip and add it again from Listen."
                          : "Run speech-to-text for this clip."
                      }
                    >
                      {primaryLabel}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => onRemoveClip(c.id)}
                      disabled={busy && runningClipId === c.id}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div
        ref={resultsAnchorRef}
        className="transcribe-results-anchor"
        tabIndex={-1}
        aria-label="Transcription progress and transcript"
      >
        {error && (
          <div className="banner-err" role="alert">
            {error}
          </div>
        )}

        {statusLine && phase === "running" && (
          <div className="rec-status" aria-live="polite">
            <div className="rec-row">
              <span className="rec-dot" aria-hidden />
              <span>{statusLine}</span>
            </div>
          </div>
        )}

        {showTimingExplainer && (
          <details className="help-details">
            <summary>Timestamps</summary>
            <p className="help-details-body">
              Segment times appear when the STT provider returns them. For per-word timing, use OpenAI Whisper (
              <code>verbose_json</code>) on the AI-API.
            </p>
          </details>
        )}

        {visibleCompletedTranscripts.map((run) => {
          const sum = sessionSummaries[run.key];
          const sumStatus = sum?.summary_status ?? "idle";
          const summarizing = sumStatus === "running";
          const hasSummary = sumStatus === "ready" && Boolean(sum?.summary_text?.trim());
          return (
            <section key={run.key} id={`transcript-block-${run.key}`} className="transcript-block">
              <p className="muted transcribe-meta">
                Session <code>{run.key}</code>
                {" · "}
                <span className="clip-queue-name">{run.clipLabel}</span>
              </p>
              <div className="transcript-actions">
                <button
                  type="button"
                  className={`btn btn-small ${hasSummary ? "btn-secondary" : "btn-primary"}`}
                  disabled={summarizing}
                  title={
                    hasSummary
                      ? "Scroll to summary below (no API call)."
                      : "Generate summary once via backend + AI-API."
                  }
                  onClick={() => {
                    if (hasSummary) scrollToSummaryBlock(run.key);
                    else void onSummarize(run.key);
                  }}
                >
                  {summarizing ? "Summarizing…" : hasSummary ? "View summary" : "Summarize"}
                </button>
                               <button
                  type="button"
                  className="btn btn-small"
                  disabled={summarizing}
                  onClick={() => void onExport(run.key, "md")}
                >
                  Export .md
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={summarizing}
                  onClick={() => void onExport(run.key, "txt")}
                >
                  Export .txt
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={summarizing}
                  onClick={() => void onExport(run.key, "json")}
                >
                  Export .json
                </button>
              </div>
              {sum?.summary_error && (
                <div className="banner-err" role="alert">
                  {sum.summary_error}
                </div>
              )}
              {sum?.summary_text && sumStatus === "ready" && (
                <div className="summary-block" id={`summary-transcribe-${run.key}`}>
                  <h4 className="summary-h">Summary</h4>
                  <pre className="summary-pre">{sum.summary_text}</pre>
                </div>
              )}
              <h3 className="transcribe-result-h" id={`transcript-${run.key}`}>
                Transcript · {run.clipLabel}
              </h3>
              <ol className="segment-list" aria-labelledby={`transcript-${run.key}`}>
                {run.segments.map((s) => {
                  const metaLine = formatSegmentMeta(s, run.segments);
                  return (
                    <li key={s.id} className="segment-item">
                      <div className="segment-meta muted">{metaLine}</div>
                      <div className="segment-text">{s.text}</div>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}

        {sessionId && (phase === "running" || phase === "error") && resultLabel && (
          <p className="muted transcribe-meta">
            Session <code>{sessionId}</code>
            {" · "}
            <span className="clip-queue-name">{resultLabel}</span>
            {phase === "running" && <span className="muted"> (in progress)</span>}
          </p>
        )}

        {segments.length > 0 && resultLabel && sessionId && (phase === "running" || phase === "error") && (
          <section className="transcript-block transcript-block-current" aria-label="Current transcription">
            <h3 className="transcribe-result-h" id={`transcript-${sessionId}-live`}>
              Transcript · {resultLabel}
            </h3>
            <ol className="segment-list" aria-labelledby={`transcript-${sessionId}-live`}>
              {segments.map((s) => {
                const metaLine = formatSegmentMeta(s, segments);
                return (
                  <li key={s.id} className="segment-item">
                    <div className="segment-meta muted">{metaLine}</div>
                    <div className="segment-text">{s.text}</div>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {phase === "done" &&
          segments.length === 0 &&
          !error &&
          visibleCompletedTranscripts.length === 0 &&
          resultLabel && (
          <p className="muted">Transcription finished with no segments (empty result).</p>
        )}
      </div>
    </div>
  );
}
