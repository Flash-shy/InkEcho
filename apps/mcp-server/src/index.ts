#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getSkill, listSkills } from "./skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultSkillsDir = path.resolve(__dirname, "..", "skills");
const skillsDir = process.env.INK_ECHO_SKILLS_DIR ?? defaultSkillsDir;

const server = new McpServer(
  { name: "ink-echo-mcp", version: "0.1.0" },
  {
    instructions:
      "InkEcho MCP: data tools (stub) plus list_skills / get_skill for bundled Agent Skills. " +
      "Point INK_ECHO_SKILLS_DIR at a skills tree if not using the default next to this package.",
  },
);

server.registerTool(
  "list_skills",
  {
    description:
      "Lists bundled Agent Skills (SKILL.md under each folder). Non-secret instructions for agents.",
  },
  async () => {
    const skills = await listSkills(skillsDir);
    return {
      content: [{ type: "text", text: JSON.stringify({ skills }, null, 2) }],
    };
  },
);

server.registerTool(
  "get_skill",
  {
    description: "Returns one skill by folder id (e.g. meeting-minutes): frontmatter name/description and markdown body.",
    inputSchema: z.object({
      skillId: z.string().describe("Skill directory name under skills/"),
    }),
  },
  async ({ skillId }) => {
    const skill = await getSkill(skillsDir, skillId);
    if (!skill) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "not_found", skillId }) }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(skill, null, 2) }],
    };
  },
);

server.registerTool(
  "list_sessions",
  {
    description: "List InkEcho sessions (stub until backend internal API is wired).",
  },
  async () => ({
    content: [{ type: "text", text: JSON.stringify({ sessions: [], note: "stub" }) }],
  }),
);

server.registerTool(
  "get_transcript",
  {
    description: "Fetch transcript for a session (stub).",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
  },
  async ({ sessionId }) => ({
    content: [
      { type: "text", text: JSON.stringify({ error: "not_implemented", sessionId }) },
    ],
    isError: true,
  }),
);

server.registerTool(
  "get_summary",
  {
    description: "Fetch AI summary for a session (stub).",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
  },
  async ({ sessionId }) => ({
    content: [
      { type: "text", text: JSON.stringify({ error: "not_implemented", sessionId }) },
    ],
    isError: true,
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
