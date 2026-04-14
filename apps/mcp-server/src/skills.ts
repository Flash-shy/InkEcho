import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
};

export type SkillDetail = SkillSummary & { body: string };

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
