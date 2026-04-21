# Agent Skills (bundled in MCP)

These folders are **instructions for agents**, not executable code. The MCP server exposes them with:

- **`list_skills`** — ids, `name`, `description` (from YAML frontmatter)
- **`get_skill`** — full markdown body plus metadata for one `skillId`
- **`skill_<folder_id_with_underscores>`** (and optional renames) — one extra tool per skill, registered at startup from `skills/` (see below)

## MCP tool per skill (bundled registration)

On startup, the server scans each public skill folder and registers a **first-class MCP tool** whose name defaults to `skill_` + folder id with hyphens replaced by underscores (e.g. `meeting-minutes` → `skill_meeting_minutes`).

Optional YAML frontmatter on `SKILL.md`:

- **`mcp_tool`** — override tool name (letters, digits, underscore only; must not collide with built-in tools like `list_sessions`).
- **`mcp_bind`** — how the tool behaves:
  - `generate_meeting_minutes` — same as core `generate_meeting_minutes`
  - `semantic_search` — same as core `semantic_search`
  - `rag_answer` — same as core `rag_answer`
  - `rag_bundle` — one tool with `operation: "search" | "answer"` (maps to search / RAG answer)
  - `instructions_only` — returns the skill JSON (like `get_skill`), for skills that are guidance-only
- **`mcp_register: false`** — skip registering an extra tool for this folder (still listed via `list_skills` / `get_skill`).

If `mcp_bind` is omitted, a small built-in map applies for known ids (e.g. `meeting-minutes` → `generate_meeting_minutes`, `cross-session-retrieval-answer` → `rag_bundle`); otherwise the default is `instructions_only`.

## Add a new skill

1. Copy `skills/_template/SKILL.md` to `skills/<skill-id>/SKILL.md`  
   - Use a **kebab-case** `skill-id` (folder name = id in `get_skill`).
2. Edit the frontmatter:
   - **`name`** — short display name (can match id)
   - **`description`** — used in `list_skills`; be explicit about *when* to use this skill
3. Write the markdown body: workflows, output format, and which MCP tools to call (`get_transcript`, etc.).
4. Restart or keep running MCP — skills are read from disk on each `list_skills` / `get_skill` call (no rebuild for markdown-only changes).

Directories whose names start with `.` or `_` are **ignored** (e.g. `_template` is not listed).

## Optional files

You may add `reference.md`, examples, or small assets **next to** `SKILL.md` for human maintainers.  
Only `SKILL.md` is loaded by MCP today; mention other files in the skill body if agents should know they exist.

## Override skills root

Set **`INK_ECHO_SKILLS_DIR`** to point at another directory with the same layout (`<id>/SKILL.md`).
