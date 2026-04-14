# Agent Skills (bundled in MCP)

These folders are **instructions for agents**, not executable code. The MCP server exposes them with:

- **`list_skills`** — ids, `name`, `description` (from YAML frontmatter)
- **`get_skill`** — full markdown body plus metadata for one `skillId`

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
