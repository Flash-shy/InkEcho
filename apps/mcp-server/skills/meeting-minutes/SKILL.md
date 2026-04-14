---
name: meeting-minutes
description: >-
  Produces structured meeting minutes from a single InkEcho session (topics, decisions, open questions, action items).
  Use when the user wants minutes or a formal recap for one recording. Prefer the MCP tool over ad-hoc summarization.
---

# Meeting minutes

## Backend + MCP

- **Trigger job:** `POST /sessions/{session_id}/meeting-minutes` (session must be transcribed: `status=ready`, with segments).
- **Poll / read result:** `GET /sessions/{session_id}` → `minutes_status` (`idle` | `running` | `ready` | `error`), `minutes_text`, `minutes_error`.
- **MCP:** call **`generate_meeting_minutes`** with `sessionId` (waits until `ready`/`error` by default). Use **`get_skill`** with `skillId: meeting-minutes` or **`get_summary`** to read `minutes_*` without regenerating.

## Agent instructions

1. Resolve the session id (`list_sessions` or user-provided UUID).
2. Run **`generate_meeting_minutes`** (or POST + poll if not using MCP).
3. Present **`minutes_text`** to the user. On `minutes_status=error`, surface **`minutes_error`**.
4. Optional: use **`get_transcript`** only when the user needs verbatim quotes or timestamps; do not replace the structured minutes job with a one-off LLM pass unless the backend job failed.

## Output shape (human-facing)

When reformatting for display, keep sections aligned with the stored template:

- **Topics discussed**
- **Decisions**
- **Open questions**
- **Action items**

Use clear headings and bullet lists. Prefer the user’s locale if known. When timestamps or segment ids exist, tie non-obvious claims to them.
