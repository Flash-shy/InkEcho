#!/usr/bin/env node
/**
 * Spawns apps/mcp-server/dist/index.js over stdio and verifies listTools + list_skills + get_skill.
 * Run from repo root: node scripts/test-mcp-smoke.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = path.join(root, "apps/mcp-server/dist/index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverJs],
  cwd: root,
  stderr: "inherit",
});

const client = new Client({ name: "ink-echo-smoke", version: "0.0.1" });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log("OK listTools:", names.join(", "));

  const expected = [
    "get_skill",
    "get_summary",
    "get_transcript",
    "list_sessions",
    "list_skills",
  ];
  for (const n of expected) {
    if (!names.includes(n)) {
      throw new Error(`missing tool: ${n}`);
    }
  }

  const r1 = await client.callTool({ name: "list_skills", arguments: {} });
  const t1 = r1.content?.find((c) => c.type === "text")?.text ?? "";
  if (!t1.includes("meeting-minutes")) {
    throw new Error(`list_skills unexpected payload: ${t1.slice(0, 120)}`);
  }
  console.log("OK list_skills: contains meeting-minutes");

  const r2 = await client.callTool({
    name: "get_skill",
    arguments: { skillId: "meeting-minutes" },
  });
  const t2 = r2.content?.find((c) => c.type === "text")?.text ?? "";
  const parsed = JSON.parse(t2);
  if (parsed.id !== "meeting-minutes" || typeof parsed.body !== "string" || !parsed.body.includes("# Meeting minutes")) {
    throw new Error(`get_skill unexpected payload: ${t2.slice(0, 200)}`);
  }
  console.log("OK get_skill: meeting-minutes SKILL body present");

  console.log("\nAll MCP smoke checks passed.");
} finally {
  await transport.close();
}
