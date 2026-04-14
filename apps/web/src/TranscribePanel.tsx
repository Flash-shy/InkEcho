import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { type CaptureKind, captureKindMeta } from "./captureTypes";

export type TranscribeClip = { id: string; blob: Blob; label: string; captureKind: CaptureKind };

type WsSegment = {
  id: string;
  seq: number;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
};

function extFromBlob(blob: Blob): string {
  const t = blob.type;
  if (t.includes("webm")) return "webm";
  if (t.includes("mp4")) return "mp4";
  if (t.includes("wav")) return "wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("ogg")) return "ogg";
  return "bin";
}

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return m > 0 ? `${m}:${r.toString().padStart(2, "0")}` : `${r}s`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

type Props = {
  clips: TranscribeClip[];
  onRemoveClip: (id: string) => void;
  onClearQueue: () => void;
};

export function TranscribePanel({ clips, onRemoveClip, onClearQueue }: Props) {
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [segments, setSegments] = useState<WsSegment[]>([]);
  const [resultLabel, setResultLabel] = useState<string | null>(null);
  const [runningClipId, setRunningClipId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resultsAnchorRef = useRef<HTMLDivElement | null>(null);

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

  /** Queue emptied: reset last run UI. */
  useEffect(() => {
    if (clips.length > 0) return;
    teardownWs();
    setSegments([]);
    setSessionId(null);
    setError(null);
    setStatusLine(null);
    setPhase("idle");
    setResultLabel(null);
    setRunningClipId(null);
  }, [clips.length, teardownWs]);

  const onTranscribe = useCallback(
    async (clip: TranscribeClip) => {
      teardownWs();
      setError(null);
      setSegments([]);
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
            setPhase("done");
            setStatusLine("Done");
            setRunningClipId(null);
            requestAnimationFrame(() => {
              resultsAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
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

  const busy = phase === "running";

  return (
    <div className="transcribe">
      <p className="muted workflow-copy">
        Open a <strong>WebSocket</strong> first, then upload the clip to the backend. The backend calls the{" "}
        <strong>AI-API</strong> and streams segment events as they are stored. Use mock mode when{" "}
        <code>OPENAI_API_KEY</code> is unset on AI-API. Add several clips from <strong>Listen</strong> (including
        multi-file upload); each row runs in its own session.
      </p>

      {clips.length === 0 && (
        <p className="muted workflow-copy">
          Queue is empty. In <strong>Listen</strong>, record, share, or upload one or more files and use{" "}
          <strong>Add to transcription queue</strong>.
        </p>
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
                      className="btn btn-primary btn-small"
                      onClick={() => onTranscribe(c)}
                      disabled={busy}
                    >
                      {runningClipId === c.id && busy ? "Transcribing…" : "Transcribe"}
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

        {sessionId && (
          <p className="muted transcribe-meta">
            Session <code>{sessionId}</code>
            {resultLabel && (
              <>
                {" "}
                · <span className="clip-queue-name">{resultLabel}</span>
              </>
            )}
          </p>
        )}

        {segments.length > 0 && resultLabel && sessionId && (
          <>
            <h3 className="transcribe-result-h" id={`transcript-${sessionId}`}>
              Transcript · {resultLabel}
            </h3>
            <ol className="segment-list" aria-labelledby={`transcript-${sessionId}`}>
              {segments.map((s) => (
                <li key={s.id} className="segment-item">
                  <div className="segment-meta muted">
                    #{s.seq + 1} · {formatMs(s.start_ms)}–{formatMs(s.end_ms)}
                  </div>
                  <div className="segment-text">{s.text}</div>
                </li>
              ))}
            </ol>
          </>
        )}

        {phase === "done" && segments.length === 0 && !error && resultLabel && (
          <p className="muted">Transcription finished with no segments (empty result).</p>
        )}
      </div>
    </div>
  );
}
