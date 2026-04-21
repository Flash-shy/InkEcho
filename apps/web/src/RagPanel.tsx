import { useCallback, useEffect, useRef, useState } from "react";

import { ragAnswer, reindexSessionForRag, semanticSearch } from "./inkecho";
import type { RagAnswerResponse, RagSearchResponse } from "./inkecho";
import { getStoredRagState, setStoredRagState } from "./uiPersistence";

type SessionPick = { id: string; title: string | null; status: string };

type Props = {
  active: boolean;
};

export function RagPanel({ active }: Props) {
  const [bootRag] = useState(() => getStoredRagState());
  const [sessions, setSessions] = useState<SessionPick[]>([]);
  const [sessionsErr, setSessionsErr] = useState<string | null>(null);
  const [scopeIds, setScopeIds] = useState<Set<string>>(() => new Set(bootRag?.scopeIds ?? []));
  const [query, setQuery] = useState(() => bootRag?.query ?? "");
  const [searchLimit, setSearchLimit] = useState(() => bootRag?.searchLimit ?? 8);
  const [answerLimit, setAnswerLimit] = useState(() => bootRag?.answerLimit ?? 6);

  const [searchLoading, setSearchLoading] = useState(false);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [answerErr, setAnswerErr] = useState<string | null>(null);
  const [searchOut, setSearchOut] = useState<RagSearchResponse | null>(() => bootRag?.searchOut ?? null);
  const [answerOut, setAnswerOut] = useState<RagAnswerResponse | null>(() => bootRag?.answerOut ?? null);

  const [reindexBusy, setReindexBusy] = useState<string | null>(null);
  const [reindexMsg, setReindexMsg] = useState<string | null>(null);

  const searchOutputRef = useRef<HTMLDivElement>(null);
  const answerOutputRef = useRef<HTMLDivElement>(null);
  const prevSearchLoadingRef = useRef(false);
  const prevAnswerLoadingRef = useRef(false);

  const scrollToEl = (el: HTMLElement | null) => {
    if (!el) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
      }),
    );
  };

  const refreshSessions = useCallback(async () => {
    setSessionsErr(null);
    try {
      const r = await fetch("/api/sessions?limit=100");
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const rows = (await r.json()) as SessionPick[];
      setSessions(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setSessionsErr(e instanceof Error ? e.message : "Failed to load sessions");
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refreshSessions();
  }, [active, refreshSessions]);

  const scopeIdsSorted = [...scopeIds].sort();
  const scopeIdsKey = scopeIdsSorted.join(",");
  useEffect(() => {
    setStoredRagState({
      scopeIds: scopeIdsSorted,
      query,
      searchLimit,
      answerLimit,
      searchOut,
      answerOut,
    });
  }, [scopeIdsKey, query, searchLimit, answerLimit, searchOut, answerOut]);

  useEffect(() => {
    const finished = prevSearchLoadingRef.current && !searchLoading;
    prevSearchLoadingRef.current = searchLoading;
    if (finished && (searchOut != null || Boolean(searchErr))) {
      scrollToEl(searchOutputRef.current);
    }
  }, [searchLoading, searchOut, searchErr]);

  useEffect(() => {
    const finished = prevAnswerLoadingRef.current && !answerLoading;
    prevAnswerLoadingRef.current = answerLoading;
    if (finished && (answerOut != null || Boolean(answerErr))) {
      scrollToEl(answerOutputRef.current);
    }
  }, [answerLoading, answerOut, answerErr]);

  const toggleScope = (id: string) => {
    setScopeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearScope = () => setScopeIds(new Set());

  const sessionIdsPayload = scopeIds.size > 0 ? [...scopeIds] : undefined;

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearchLoading(true);
    setSearchErr(null);
    setSearchOut(null);
    setAnswerErr(null);
    setAnswerOut(null);
    try {
      const out = await semanticSearch({
        query: q,
        limit: searchLimit,
        sessionIds: sessionIdsPayload,
      });
      setSearchOut(out);
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearchLoading(false);
    }
  };

  const runAnswer = async () => {
    const q = query.trim();
    if (!q) return;
    setAnswerLoading(true);
    setAnswerErr(null);
    setAnswerOut(null);
    setSearchErr(null);
    setSearchOut(null);
    try {
      const out = await ragAnswer({
        question: q,
        limit: answerLimit,
        sessionIds: sessionIdsPayload,
      });
      setAnswerOut(out);
    } catch (e) {
      setAnswerErr(e instanceof Error ? e.message : "Answer failed");
    } finally {
      setAnswerLoading(false);
    }
  };

  const reindex = async (sessionId: string) => {
    setReindexBusy(sessionId);
    setReindexMsg(null);
    try {
      const body = await reindexSessionForRag(sessionId);
      setReindexMsg(`Indexed ${body.chunks_indexed} chunk(s) for session ${sessionId.slice(0, 8)}…`);
    } catch (e) {
      setReindexMsg(e instanceof Error ? e.message : "Re-index failed");
    } finally {
      setReindexBusy(null);
    }
  };

  return (
    <div className="rag-panel">
      <p className="panel-lead rag-lead">
        Search or ask across <strong>indexed</strong> transcripts. Indexing runs after transcription; use{" "}
        <strong>Re-index</strong> if you changed embedding settings or imported data. Session checkboxes scope{" "}
        <strong>both</strong> semantic search and RAG answers.
      </p>

      <div className="rag-query-block card-inner">
        <label className="rag-label" htmlFor="rag-query-input">
          Query / question
        </label>
        <textarea
          id="rag-query-input"
          className="rag-textarea"
          rows={3}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. What did we decide about the launch date?"
          disabled={searchLoading || answerLoading}
        />
        <div className="rag-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={searchLoading || !query.trim()}
            onClick={() => void runSearch()}
          >
            {searchLoading ? "Searching…" : "Semantic search"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={answerLoading || !query.trim()}
            onClick={() => void runAnswer()}
          >
            {answerLoading ? "Answering…" : "Ask (RAG + LLM)"}
          </button>
        </div>
        <div className="rag-limits">
          <label className="rag-limit-label">
            Search hits
            <input
              type="number"
              className="rag-limit-input"
              min={1}
              max={50}
              value={searchLimit}
              onChange={(e) => setSearchLimit(Number(e.target.value) || 8)}
            />
          </label>
          <label className="rag-limit-label">
            Answer context chunks
            <input
              type="number"
              className="rag-limit-input"
              min={1}
              max={20}
              value={answerLimit}
              onChange={(e) => setAnswerLimit(Number(e.target.value) || 6)}
            />
          </label>
        </div>
      </div>

      <div className="rag-scope card-inner">
        <div className="rag-scope-head">
          <span className="rag-scope-title">Limit search to sessions</span>
          <button type="button" className="btn btn-small btn-secondary" onClick={clearScope} disabled={scopeIds.size === 0}>
            Clear selection
          </button>
        </div>
        {sessionsErr && <div className="banner-err">{sessionsErr}</div>}
        <p className="muted rag-scope-hint">Leave none selected to search all indexed sessions.</p>
        <ul className="rag-session-list">
          {sessions.map((s) => (
            <li key={s.id} className="rag-session-row">
              <label className="rag-session-label">
                <input
                  type="checkbox"
                  checked={scopeIds.has(s.id)}
                  onChange={() => toggleScope(s.id)}
                  disabled={!["ready", "active"].includes(s.status)}
                />
                <span className="rag-session-title">{s.title?.trim() || "(untitled)"}</span>
                <span className="muted rag-session-meta">
                  {s.status} · {s.id.slice(0, 8)}…
                </span>
              </label>
              <button
                type="button"
                className="btn btn-small btn-secondary"
                disabled={reindexBusy === s.id || s.status !== "ready"}
                title="Rebuild RAG chunks for this session"
                onClick={() => void reindex(s.id)}
              >
                {reindexBusy === s.id ? "…" : "Re-index"}
              </button>
            </li>
          ))}
        </ul>
        {reindexMsg && <div className="banner-info rag-reindex-msg">{reindexMsg}</div>}
      </div>

      <div ref={searchOutputRef} className="rag-output-anchor" id="rag-search-output">
        {searchErr && <div className="banner-err">{searchErr}</div>}
        {searchOut && (
          <div className="rag-results card-inner">
            <h3 className="rag-results-title">Search results</h3>
            <p className="muted rag-model">Embedding model: {searchOut.model}</p>
            {searchOut.hits.length === 0 ? (
              <p className="muted">No hits. Transcribe sessions and wait for auto-index, or Re-index a ready session.</p>
            ) : (
              <ul className="rag-hit-list">
                {searchOut.hits.map((h, i) => (
                  <li key={`${h.session_id}-${h.chunk_index}-${i}`} className="rag-hit">
                    <div className="rag-hit-meta">
                      <span className="rag-hit-score" title="Cosine similarity">
                        {h.score.toFixed(4)}
                      </span>
                      <span className="rag-hit-session">{h.session_title || "Untitled"}</span>
                      <code className="rag-hit-id">{h.session_id}</code>
                      <span className="muted">
                        seq {h.segment_start_seq}–{h.segment_end_seq}
                      </span>
                    </div>
                    <p className="rag-hit-text">{h.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div ref={answerOutputRef} className="rag-output-anchor" id="rag-answer-output">
        {answerErr && <div className="banner-err">{answerErr}</div>}
        {answerOut && (
          <div className="rag-answer-block card-inner">
            <h3 className="rag-results-title">Answer</h3>
            <div className="rag-answer-body">{answerOut.answer}</div>
            {answerOut.citations.length > 0 && (
              <>
                <h4 className="rag-citations-title">Sources</h4>
                <ul className="rag-hit-list">
                  {answerOut.citations.map((h, i) => (
                    <li key={`cit-${h.session_id}-${i}`} className="rag-hit rag-hit-compact">
                      <div className="rag-hit-meta">
                        <strong className="rag-cit-idx">[{i}]</strong>
                        <span>{h.session_title || "Untitled"}</span>
                        <code className="rag-hit-id">{h.session_id}</code>
                      </div>
                      <p className="rag-hit-text">{h.text}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
