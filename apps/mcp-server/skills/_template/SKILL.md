---
name: your-skill-id
description: >-
  One or two sentences: what this skill does and when an agent should load it (triggers, inputs).
# Optional — extra MCP tool for this folder (see skills/README.md):
# mcp_tool: skill_your_skill_id
# mcp_bind: instructions_only
# mcp_register: false
---

# Human-readable title

## When to use

- Bullet points: user intents or session states that map to this skill.

## Instructions

1. Steps the agent should follow. Reference data tools when needed, e.g. `list_sessions`, `get_transcript`, `get_summary`.
2. Keep secrets out of this file — only procedural guidance.

## Output

Describe the expected shape (headings, bullets, locale, citations to segment ids if applicable).

## See also

- Optional: link to other skill ids under `skills/` that compose with this one.
