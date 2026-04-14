import { INKECHO_API_PREFIX, parseJsonOrThrow } from "./http";
import type { RagAnswerResponse, RagSearchResponse } from "./types";

export type SemanticSearchParams = {
  query: string;
  /** Clamped 1–50; default 8 */
  limit?: number;
  /** If empty/omitted, search all indexed sessions */
  sessionIds?: string[];
};

export type RagAnswerParams = {
  question: string;
  /** Clamped 1–20; default 6 */
  limit?: number;
  sessionIds?: string[];
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * POST /rag/search — vector hits across indexed transcript chunks (same contract as MCP `semantic_search`).
 */
export async function semanticSearch(params: SemanticSearchParams): Promise<RagSearchResponse> {
  const limit = clamp(params.limit ?? 8, 1, 50);
  const r = await fetch(`${INKECHO_API_PREFIX}/rag/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: params.query,
      limit,
      session_ids: params.sessionIds?.length ? params.sessionIds : undefined,
    }),
  });
  return parseJsonOrThrow<RagSearchResponse>(r);
}

/**
 * POST /rag/answer — retrieved context + LLM answer (same contract as MCP `rag_answer`).
 */
export async function ragAnswer(params: RagAnswerParams): Promise<RagAnswerResponse> {
  const limit = clamp(params.limit ?? 6, 1, 20);
  const r = await fetch(`${INKECHO_API_PREFIX}/rag/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: params.question,
      limit,
      session_ids: params.sessionIds?.length ? params.sessionIds : undefined,
    }),
  });
  return parseJsonOrThrow<RagAnswerResponse>(r);
}

export type RagReindexResult = { chunks_indexed: number };

/**
 * POST /rag/index/{sessionId} — (re)build chunks + embeddings for one session.
 */
export async function reindexSessionForRag(sessionId: string): Promise<RagReindexResult> {
  const r = await fetch(`${INKECHO_API_PREFIX}/rag/index/${sessionId}`, { method: "POST" });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text}`);
  return JSON.parse(text) as RagReindexResult;
}
