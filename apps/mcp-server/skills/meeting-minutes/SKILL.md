---
name: meeting-minutes
description: >-
  Produces structured meeting minutes from a single session transcript (topics, decisions, open questions).
  Use when the user wants minutes or a formal recap for one recording.
---

# Meeting minutes

## Instructions

1. Obtain the transcript (e.g. via `get_transcript` when implemented).
2. Output sections: **Topics discussed**, **Decisions**, **Open questions**, **Action items** (or reference the action-items skill).
3. When timestamps or segment ids exist, tie non-obvious claims to them.

## Output

Use clear headings and bullet lists. Prefer the user’s locale if known.
