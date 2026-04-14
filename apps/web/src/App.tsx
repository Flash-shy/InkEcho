import { useEffect, useState } from "react";

type Health = { status: string; service?: string; ai_api_base_url?: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((data) => {
        setHealth(data);
        setError(null);
      })
      .catch((e: Error) => {
        setError(e.message);
        setHealth(null);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <header className="hero">
        <h1>InkEcho</h1>
        <p className="tagline">
          Capture what you hear, transcribe it, and turn it into summaries you can export—starting as a web-first
          stack.
        </p>
        <div className="pill-row" aria-hidden>
          <span className="pill">Listen</span>
          <span className="pill">Transcribe</span>
          <span className="pill">Summarize</span>
        </div>
      </header>

      <section className="card" aria-labelledby="status-heading">
        <h2 id="status-heading">Platform status</h2>
        {loading && (
          <div className="status-loading">
            <span className="spinner" aria-hidden />
            <span>Contacting backend via <code>/api</code> proxy…</span>
          </div>
        )}
        {!loading && error && (
          <div className="status-err" role="alert">
            <strong>Backend unreachable.</strong> Start it from <code>apps/backend</code> (see README), then refresh.
            <div className="muted" style={{ marginTop: "0.5rem" }}>
              Detail: {error}
            </div>
          </div>
        )}
        {!loading && health && (
          <div className="status-ok">
            <span className="status-dot" aria-hidden />
            <div>
              <div style={{ fontWeight: 600, marginBottom: "0.35rem" }}>Backend is up</div>
              <pre className="pre-json">{JSON.stringify(health, null, 2)}</pre>
            </div>
          </div>
        )}
      </section>

      <p className="muted" style={{ marginBottom: "1.25rem" }}>
        This screen is the MVP scaffold: real capture, live transcripts, and AI flows come in the next milestones.
      </p>

      <footer className="foot">
        Dev tip: <code>npm run dev:web</code> with backend on port <code>8000</code> — Vite proxies{" "}
        <code>/api</code> → <code>http://127.0.0.1:8000</code>.
      </footer>
    </>
  );
}
