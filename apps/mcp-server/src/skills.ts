import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
};

export type SkillDetail = SkillSummary & { body: string };

/** How a bundled skill maps to an MCP tool (see listSkillsForMcpRegistration). */
export type SkillMcpBind =
  | "generate_meeting_minutes"
  | "semantic_search"
  | "rag_answer"
  | "rag_bundle"
  | "instructions_only";

export type SkillRegistryEntry = SkillSummary & {
  mcpToolName: string;
  mcpBind: SkillMcpBind;
};

/** Names already registered by ink-echo-mcp core; skill tools must not collide. */
export const INKECHO_BUILTIN_TOOL_NAMES = new Set([
  "list_skills",
  "get_skill",
  "list_sessions",
  "get_transcript",
  "get_summary",
  "semantic_search",
  "rag_answer",
  "generate_meeting_minutes",
]);

const DEFAULT_BIND_BY_ID: Record<string, SkillMcpBind> = {
  "meeting-minutes": "generate_meeting_minutes",
  "cross-session-retrieval-answer": "rag_bundle",
};

const MCP_TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/i;

function parseSkillFile(raw: string): { name: string; description: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { name: "", description: "", body: raw.trim() };
  }
  const front = YAML.parse(match[1]) as Record<string, unknown> | null;
  const body = match[2].trim();
  const name = typeof front?.name === "string" ? front.name : "";
  const description = typeof front?.description === "string" ? front.description : "";
  return { name, description, body };
}

function parseFrontmatterRecord(raw: string): Record<string, unknown> | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  return YAML.parse(match[1]) as Record<string, unknown> | null;
}

function validBind(v: unknown): SkillMcpBind | null {
  if (typeof v !== "string") return null;
  const x = v.trim();
  if (
    x === "generate_meeting_minutes" ||
    x === "semantic_search" ||
    x === "rag_answer" ||
    x === "rag_bundle" ||
    x === "instructions_only"
  ) {
    return x;
  }
  return null;
}

function defaultMcpToolName(id: string): string {
  return `skill_${id.replace(/-/g, "_")}`;
}

function resolveMcpToolName(raw: unknown, id: string): string {
  let candidate = defaultMcpToolName(id);
  if (typeof raw === "string" && raw.trim()) {
    const t = raw.trim();
    if (MCP_TOOL_NAME_RE.test(t)) candidate = t;
  }
  if (INKECHO_BUILTIN_TOOL_NAMES.has(candidate)) candidate = defaultMcpToolName(id);
  return candidate;
}

export async function listSkills(skillsRoot: string): Promise<SkillSummary[]> {
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SkillSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    if (id.startsWith(".") || id.startsWith("_")) continue;
    const skillPath = path.join(skillsRoot, id, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(skillPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillFile(raw);
    out.push({
      id,
      name: parsed.name || id,
      description: parsed.description,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Skills that get a first-class MCP tool (in addition to list_skills / get_skill).
 * Optional SKILL.md frontmatter: mcp_tool (name), mcp_bind (kind), mcp_register: false to skip.
 */
export async function listSkillsForMcpRegistration(skillsRoot: string): Promise<SkillRegistryEntry[]> {
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SkillRegistryEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    if (id.startsWith(".") || id.startsWith("_")) continue;
    const skillPath = path.join(skillsRoot, id, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(skillPath, "utf8");
    } catch {
      continue;
    }
    const front = parseFrontmatterRecord(raw);
    if (front?.mcp_register === false || front?.mcp_register === "false") continue;

    const parsed = parseSkillFile(raw);
    const mcpBind = validBind(front?.mcp_bind) ?? DEFAULT_BIND_BY_ID[id] ?? "instructions_only";
    const mcpToolName = resolveMcpToolName(front?.mcp_tool, id);

    out.push({
      id,
      name: parsed.name || id,
      description: parsed.description,
      mcpToolName,
      mcpBind,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getSkill(skillsRoot: string, skillId: string): Promise<SkillDetail | null> {
  if (skillId.startsWith(".") || skillId.startsWith("_")) return null;
  const skillPath = path.join(skillsRoot, skillId, "SKILL.md");
  let raw: string;
  try {
    raw = await readFile(skillPath, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSkillFile(raw);
  return {
    id: skillId,
    name: parsed.name || skillId,
    description: parsed.description,
    body: parsed.body,
  };
}
