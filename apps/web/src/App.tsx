import { useEffect, useId, useState } from "react";
import { ListenPanel } from "./ListenPanel";

type Health = { status: string; service?: string; ai_api_base_url?: string };
type MainTab = "listen" | "transcribe" | "summarize";

export default function App() {
  const tabIds = useId();
  const listenPanelId = `${tabIds}-panel-listen`;
  const transcribePanelId = `${tabIds}-panel-transcribe`;
  const summarizePanelId = `${tabIds}-panel-summarize`;

  const [mainTab, setMainTab] = useState<MainTab>("listen");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch("/api/health")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((data: Health) => {
        setHealth(data);
        setHealthError(null);
      })
      .catch((e: Error) => {
        setHealthError(e.message);
        setHealth(null);
      })
      .finally(() => setHealthLoading(false));
  }, []);

  return (
    <>
      <header className="hero">
        <h1>InkEcho</h1>
        <p className="tagline">
          Capture what you hear, transcribe it, and turn it into summaries you can export—starting as a web-first
          stack.
        </p>
        <div className="tablist" role="tablist" aria-label="Main workflow">
          <button
            type="button"
            role="tab"
            id={`${tabIds}-tab-listen`}
            aria-selected={mainTab === "listen"}
            aria-controls={listenPanelId}
            tabIndex={mainTab === "listen" ? 0 : -1}
            className={`tab-pill ${mainTab === "listen" ? "tab-pill-active" : ""}`}
            onClick={() => setMainTab("listen")}
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
            onClick={() => setMainTab("transcribe")}
          >
            Transcribe
          </button>
          <button
            type="button"
            role="tab"
            id={`${tabIds}-tab-summarize`}
            aria-selected={mainTab === "summarize"}
            aria-controls={summarizePanelId}
            tabIndex={mainTab === "summarize" ? 0 : -1}
            className={`tab-pill ${mainTab === "summarize" ? "tab-pill-active" : ""}`}
            onClick={() => setMainTab("summarize")}
          >
            Summarize
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
          <ListenPanel />
        </div>
        <div
          id={transcribePanelId}
          role="tabpanel"
          aria-labelledby={`${tabIds}-tab-transcribe`}
          hidden={mainTab !== "transcribe"}
        >
          <h2 className="workflow-title">Transcribe</h2>
          <p className="muted workflow-copy">
            Streaming speech-to-text will run through the <strong>backend</strong> and <strong>AI-API</strong> (not from
            the browser), with partial segments pushed over WebSocket. This milestone wires the <strong>Listen</strong>{" "}
            path first; hooking MediaRecorder output and uploads to STT is the next backend step.
          </p>
          <ul className="workflow-list muted">
            <li>
              Record or upload a clip in <strong>Listen</strong>, then you will send it to a session here.
            </li>
            <li>Live tab capture: choose a tab and enable “share audio” when the browser prompts.</li>
          </ul>
        </div>
        <div
          id={summarizePanelId}
          role="tabpanel"
          aria-labelledby={`${tabIds}-tab-summarize`}
          hidden={mainTab !== "summarize"}
        >
          <h2 className="workflow-title">Summarize</h2>
          <p className="muted workflow-copy">
            Once transcripts exist, the backend will orchestrate summary jobs (minutes, actions, recap) via the AI-API
            using server-side credentials. Export to Markdown, plain text, and JSON is planned for the MVP slice after
            STT.
          </p>
          <ul className="workflow-list muted">
            <li>No transcript yet—complete capture + STT integration first.</li>
            <li>Prompt templates and provider choice stay on the backend for a single trust boundary.</li>
          </ul>
        </div>
      </section>

      {import.meta.env.DEV && (
        <>
          <details className="details-platform">
            <summary>Platform status</summary>
            {healthLoading && (
              <div className="status-loading">
                <span className="spinner" aria-hidden />
                <span>
                  Contacting backend via <code>/api</code> proxy…
                </span>
              </div>
            )}
            {!healthLoading && healthError && (
              <div className="status-err" role="alert">
                <strong>Backend unreachable.</strong> Start it from <code>apps/backend</code> (see README), then refresh.
                <div className="muted" style={{ marginTop: "0.5rem" }}>
                  Detail: {healthError}
                </div>
              </div>
            )}
            {!healthLoading && health && (
              <div className="status-ok">
                <span className="status-dot" aria-hidden />
                <div>
                  <div style={{ fontWeight: 600, marginBottom: "0.35rem" }}>Backend is up</div>
                  <pre className="pre-json">{JSON.stringify(health, null, 2)}</pre>
                </div>
              </div>
            )}
          </details>

          <footer className="foot">
            Dev tip: <code>npm run dev:web</code> with backend on port <code>8000</code> — Vite proxies{" "}
            <code>/api</code> → <code>http://127.0.0.1:8000</code>.
          </footer>
        </>
      )}
    </>
  );
}
