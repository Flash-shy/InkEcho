/** Cross-session RAG / semantic search (backend /rag/*). */

export type RagHit = {
  session_id: string;
  session_title: string | null;
  chunk_index: number;
  score: number;
  text: string;
  segment_start_seq: number;
  segment_end_seq: number;
};

export type RagSearchResponse = {
  model: string;
  hits: RagHit[];
};

export type RagAnswerResponse = {
  answer: string;
  citations: RagHit[];
};
