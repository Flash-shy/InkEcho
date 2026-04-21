#!/usr/bin/env node
/**
 * Starts apps/mcp-server on a free port, connects via Streamable HTTP, verifies tools.
 * Run from repo root: node scripts/test-mcp-smoke.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = path.join(root, "apps/mcp-server/dist/index.js");

const port = Number(process.env.MCP_SMOKE_PORT ?? "3034");
const base = `http://127.0.0.1:${port}`;

function waitForHealth(maxMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(`${base}/health`);
        if (r.ok) {
          resolve();
          return;
        }
      } catch {
        /* retry */
      }
      if (Date.now() - started > maxMs) {
        reject(new Error(`MCP /health not ready on ${base} within ${maxMs}ms`));
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}

const child = spawn(process.execPath, [serverJs], {
  cwd: root,
  env: {
    ...process.env,
    INK_ECHO_MCP_HTTP_PORT: String(port),
    INK_ECHO_BACKEND_URL: process.env.INK_ECHO_BACKEND_URL ?? "http://127.0.0.1:8000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
const client = new Client({ name: "ink-echo-smoke", version: "0.0.1" });

try {
  await waitForHealth();
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log("OK listTools:", names.join(", "));

  const expected = ["get_skill", "get_summary", "get_transcript", "list_sessions", "list_skills"];
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
  await transport.close().catch(() => {});
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
}
