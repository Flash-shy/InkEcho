import { useCallback, useEffect, useId, useState } from "react";
import { type CaptureKind } from "./captureTypes";
import { ListenPanel } from "./ListenPanel";
import { PlatformStatusMenu } from "./PlatformStatusMenu";
import type { SessionSummaryState } from "./sessionSummary";
import { SessionsPanel } from "./SessionsPanel";
import {
  applyThemeToDocument,
  getStoredThemePreference,
  resolveTheme,
  setStoredThemePreference,
  type ThemePreference,
} from "./theme";
import { RagPanel } from "./RagPanel";
import { TranscribePanel, type TranscribeClip } from "./TranscribePanel";
import {
  getStoredMainTab,
  getStoredSessionSummaries,
  setStoredMainTab,
  setStoredSessionSummaries,
  type MainTab,
} from "./uiPersistence";

export default function App() {
  const tabIds = useId();
  const listenPanelId = `${tabIds}-panel-listen`;
  const transcribePanelId = `${tabIds}-panel-transcribe`;
  const sessionsPanelId = `${tabIds}-panel-sessions`;
  const ragPanelId = `${tabIds}-panel-rag`;

  const [mainTab, setMainTab] = useState<MainTab>(() => getStoredMainTab());
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [transcribeQueue, setTranscribeQueue] = useState<TranscribeClip[]>([]);
  const [sessionSummaries, setSessionSummaries] = useState<Record<string, SessionSummaryState>>(
    () => getStoredSessionSummaries(),
  );
  const [themePref, setThemePref] = useState<ThemePreference>(() => getStoredThemePreference());

  const mergeSessionSummary = useCallback((sessionId: string, patch: Partial<SessionSummaryState>) => {
    setSessionSummaries((prev) => {
      const base = prev[sessionId] ?? { summary_status: "idle", minutes_status: "idle" };
      return { ...prev, [sessionId]: { ...base, ...patch } };
    });
  }, []);

  const setMainTabPersist = useCallback((tab: MainTab) => {
    setMainTab(tab);
    setStoredMainTab(tab);
  }, []);

  useEffect(() => {
    setStoredSessionSummaries(sessionSummaries);
  }, [sessionSummaries]);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(() => {
        setHealthError(null);
      })
      .catch((e: Error) => {
        setHealthError(e.message);
      })
      .finally(() => setHealthLoading(false));
  }, []);

  useEffect(() => {
    applyThemeToDocument(resolveTheme(themePref));
  }, [themePref]);

  useEffect(() => {
    if (themePref !== "auto") return;
    const t = window.setInterval(() => {
      applyThemeToDocument(resolveTheme("auto"));
    }, 60_000);
    return () => window.clearInterval(t);
  }, [themePref]);

  const onThemeChange = (next: ThemePreference) => {
    setThemePref(next);
    setStoredThemePreference(next);
    applyThemeToDocument(resolveTheme(next));
  };

  return (
    <>
      <header className="hero">
        <div className="hero-top">
          <div className="hero-brand">
            <h1>InkEcho</h1>
            <p className="tagline">Capture · Transcribe · Summarize · Ask</p>
          </div>
          <div className="hero-controls">
            <label className="theme-control">
              <span className="visually-hidden">Theme</span>
              <select
                className="theme-select"
                value={themePref}
                onChange={(e) => onThemeChange(e.target.value as ThemePreference)}
                aria-label="Theme: Auto follows Asia/Shanghai 06:00–18:00 light, else dark"
              >
                <option value="auto">Auto (Shanghai)</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <PlatformStatusMenu apiUnreachable={!healthLoading && !!healthError} />
          </div>
        </div>
        <div className="tablist" role="tablist" aria-label="Main workflow">
          <button
            type="button"
            role="tab"
            id={`${tabIds}-tab-listen`}
            aria-selected={mainTab === "listen"}
            aria-controls={listenPanelId}
            tabIndex={mainTab === "listen" ? 0 : -1}
            className={`tab-pill ${mainTab === "listen" ? "tab-pill-active" : ""}`}
            onClick={() => setMainTabPersist("listen")}
          >
            Listen
          </button>
          <button
            type="button"
            role="tab"
            id={`${tabIds}-tab-transcribe`}
            aria-selected={mainTab === "transcribe"}
            aria-controls={transcribePanelId}
            tabIndex={mainTab === "transcribe" ? 0 : -1}
            className={`tab-pill ${mainTab === "transcribe" ? "tab-pill-active" : ""}`}
            onClick={() => setMainTabPersist("transcribe")}
          >
            Transcribe
          </button>
          <button
            type="button"
            role="tab"
            id={`${tabIds}-tab-sessions`}
            aria-selected={mainTab === "sessions"}
            aria-controls={sessionsPanelId}
            tabIndex={mainTab === "sessions" ? 0 : -1}
            className={`tab-pill ${mainTab === "sessions" ? "tab-pill-active" : ""}`}
            onClick={() => setMainTabPersist("sessions")}
          >
            Sessions
          </button>
          <button
            type="button"
            role="tab"
            id={`${tabIds}-tab-rag`}
            aria-selected={mainTab === "rag"}
            aria-controls={ragPanelId}
            tabIndex={mainTab === "rag" ? 0 : -1}
            className={`tab-pill ${mainTab === "rag" ? "tab-pill-active" : ""}`}
            onClick={() => setMainTabPersist("rag")}
          >
            Ask
          </button>
        </div>
      </header>

      <section className="card workflow-card" aria-label="Workflow">
        {/* Keep panels mounted so Listen (upload / recording state) survives tab switches */}
        <div
          id={listenPanelId}
          role="tabpanel"
          aria-labelledby={`${tabIds}-tab-listen`}
          hidden={mainTab !== "listen"}
        >
          <h2 className="workflow-title">Listen</h2>
          <ListenPanel
            onClipReady={(blob, label, options) => {
              const captureKind: CaptureKind = options?.captureKind ?? "upload";
              setTranscribeQueue((q) => [...q, { id: crypto.randomUUID(), blob, label, captureKind }]);
              if (options?.focusTranscribe !== false) {
                setMainTabPersist("transcribe");
              }
            }}
          />
        </div>
        <div
          id={transcribePanelId}
          role="tabpanel"
          aria-labelledby={`${tabIds}-tab-transcribe`}
          hidden={mainTab !== "transcribe"}
        >
          <h2 className="workflow-title">Transcribe</h2>
          <TranscribePanel
            clips={transcribeQueue}
            onRemoveClip={(id) => setTranscribeQueue((q) => q.filter((c) => c.id !== id))}
            onClearQueue={() => setTranscribeQueue([])}
            onSetClipLabel={(id, label) =>
              setTranscribeQueue((q) => q.map((c) => (c.id === id ? { ...c, label } : c)))
            }
            sessionSummaries={sessionSummaries}
            mergeSessionSummary={mergeSessionSummary}
          />
        </div>
        <div
          id={sessionsPanelId}
          role="tabpanel"
          aria-labelledby={`${tabIds}-tab-sessions`}
          hidden={mainTab !== "sessions"}
        >
          <h2 className="workflow-title">Sessions</h2>
          <SessionsPanel
            active={mainTab === "sessions"}
            sessionSummaries={sessionSummaries}
            mergeSessionSummary={mergeSessionSummary}
          />
        </div>
        <div
          id={ragPanelId}
          role="tabpanel"
          aria-labelledby={`${tabIds}-tab-rag`}
          hidden={mainTab !== "rag"}
        >
          <h2 className="workflow-title">Ask across sessions</h2>
          <RagPanel active={mainTab === "rag"} />
        </div>
      </section>

      {!healthLoading && healthError && (
        <div className="connect-banner" role="alert">
          <span className="connect-banner-title">API unreachable</span>
          <span className="connect-banner-detail">{healthError}</span>
        </div>
      )}
    </>
  );
}
