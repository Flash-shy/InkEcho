import { useEffect, useState } from "react";

type Health = { status: string; service?: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = "/api/health";
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <h1>InkEcho</h1>
      <p>Web scaffold. Backend check via Vite proxy (<code>/api</code> → backend).</p>
      {error && <p role="alert">Backend: {error}</p>}
      {health && (
        <pre style={{ background: "#e2e8f0", padding: "1rem", borderRadius: 8 }}>
          {JSON.stringify(health, null, 2)}
        </pre>
      )}
    </>
  );
}
