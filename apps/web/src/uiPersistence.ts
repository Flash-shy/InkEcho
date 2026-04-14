import type { RagAnswerResponse, RagSearchResponse } from "./inkecho";
import type { SessionSummaryState } from "./sessionSummary";

export type MainTab = "listen" | "transcribe" | "sessions" | "rag";

const MAIN_TAB_KEY = "inkecho-main-tab";
const SESSION_SUMMARIES_KEY = "inkecho-session-summaries";
const TRANSCRIBE_COMPLETED_KEY = "inkecho-transcribe-completed";
const SESSIONS_SELECTED_KEY = "inkecho-sessions-selected";
const RAG_STATE_KEY = "inkecho-rag-ui";

export type TranscribeCompletedStub = { key: string; clipId: string; clipLabel: string };

type SummariesFile = { v: 1; summaries: Record<string, SessionSummaryState> };
type CompletedFile = { v: 1; items: TranscribeCompletedStub[] };
export type PersistedRagState = {
  scopeIds: string[];
  query: string;
  searchLimit: number;
  answerLimit: number;
  searchOut: RagSearchResponse | null;
  answerOut: RagAnswerResponse | null;
};

type RagFile = { v: 1 } & PersistedRagState;

function safeParse<T>(raw: string | null): T | null {
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function getStoredMainTab(): MainTab {
  try {
    const v = localStorage.getItem(MAIN_TAB_KEY);
    if (v === "listen" || v === "transcribe" || v === "sessions" || v === "rag") return v;
  } catch {
    /* ignore */
  }
  return "listen";
}

export function setStoredMainTab(tab: MainTab): void {
  try {
    localStorage.setItem(MAIN_TAB_KEY, tab);
  } catch {
    /* ignore */
  }
}

export function getStoredSessionSummaries(): Record<string, SessionSummaryState> {
  const parsed = safeParse<SummariesFile>(localStorage.getItem(SESSION_SUMMARIES_KEY));
  if (parsed?.v === 1 && parsed.summaries && typeof parsed.summaries === "object") {
    return parsed.summaries;
  }
  return {};
}

export function setStoredSessionSummaries(summaries: Record<string, SessionSummaryState>): void {
  try {
    const payload: SummariesFile = { v: 1, summaries };
    localStorage.setItem(SESSION_SUMMARIES_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function getStoredTranscribeCompleted(): TranscribeCompletedStub[] {
  const parsed = safeParse<CompletedFile>(localStorage.getItem(TRANSCRIBE_COMPLETED_KEY));
  if (parsed?.v !== 1 || !Array.isArray(parsed.items)) return [];
  return parsed.items.filter(
    (x) => typeof x?.key === "string" && typeof x?.clipId === "string" && typeof x?.clipLabel === "string",
  );
}

export function setStoredTranscribeCompleted(items: TranscribeCompletedStub[]): void {
  try {
    const payload: CompletedFile = { v: 1, items };
    localStorage.setItem(TRANSCRIBE_COMPLETED_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function getStoredSessionsSelected(): string | null {
  try {
    const v = localStorage.getItem(SESSIONS_SELECTED_KEY);
    if (v && v.trim()) return v;
  } catch {
    /* ignore */
  }
  return null;
}

export function setStoredSessionsSelected(id: string | null): void {
  try {
    if (id) localStorage.setItem(SESSIONS_SELECTED_KEY, id);
    else localStorage.removeItem(SESSIONS_SELECTED_KEY);
  } catch {
    /* ignore */
  }
}

export function getStoredRagState(): PersistedRagState | null {
  const parsed = safeParse<RagFile>(localStorage.getItem(RAG_STATE_KEY));
  if (parsed?.v !== 1) return null;
  const {
    scopeIds,
    query,
    searchLimit,
    answerLimit,
    searchOut,
    answerOut,
  } = parsed;
  if (!Array.isArray(scopeIds) || typeof query !== "string") return null;
  return {
    scopeIds,
    query,
    searchLimit: typeof searchLimit === "number" ? searchLimit : 8,
    answerLimit: typeof answerLimit === "number" ? answerLimit : 6,
    searchOut: searchOut ?? null,
    answerOut: answerOut ?? null,
  };
}

export function setStoredRagState(state: PersistedRagState): void {
  try {
    const payload: RagFile = { v: 1, ...state };
    localStorage.setItem(RAG_STATE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}
