---
name: cross-session-retrieval-answer
description: >-
  After retrieving evidence with semantic_search or rag_answer, produce answers that cite session id and excerpt index [n],
  put the direct answer first, then cited bullets, and hedge when evidence is weak. Do not invent meetings or quotes.
---

# Cross-session retrieval answer

## When to use

- The user asks questions that may span **multiple** InkEcho sessions (themes, decisions, “what did we say about X”, comparisons).
- You already have or will obtain excerpts via **`semantic_search`** or a full **`rag_answer`** from MCP.

## Workflow

1. Prefer **`rag_answer`** when the user wants a **synthesized** answer in one step; it returns `answer` plus `citations` with `session_id`, `text`, and scores.
2. Prefer **`semantic_search`** when the user wants **raw hits** to browse, or you need to filter with `sessionIds`.
3. If excerpts are thin or contradictory, say so and suggest rephrasing the query or indexing more sessions (`POST /rag/index/{sessionId}` after transcription).

## Citation shape

- Reference sources as **`[n]`** matching the hit index from `semantic_search` or the order of `citations` in `rag_answer`.
- Include **`session_id`** (and title if present) when distinguishing sessions.

## Output

1. Short **direct answer** (or refusal if evidence insufficient).
2. **Supporting bullets**, each tagged with `[n]` (and session id if helpful).
3. Optional **gaps**: what was not found in the index.

## Safety

- Skills are **non-secret** instructions only; they do not grant API access beyond what the host’s MCP tools already expose.
