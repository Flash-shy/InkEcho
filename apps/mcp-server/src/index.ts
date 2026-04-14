#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getSkill, listSkills } from "./skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultSkillsDir = path.resolve(__dirname, "..", "skills");
const skillsDir = process.env.INK_ECHO_SKILLS_DIR ?? defaultSkillsDir;
const backendBase = (process.env.INK_ECHO_BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const backendToken = (process.env.INK_ECHO_MCP_BACKEND_TOKEN ?? "").trim();

async function backendFetch(pathSuffix: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (backendToken) headers.Authorization = `Bearer ${backendToken}`;
  return fetch(`${backendBase}${pathSuffix}`, { headers });
}

const server = new McpServer(
  { name: "ink-echo-mcp", version: "0.1.0" },
  {
    instructions:
      "InkEcho MCP: list_sessions / get_transcript / get_summary call the backend at INK_ECHO_BACKEND_URL; " +
      "semantic_search / rag_answer call POST /rag/search and /rag/answer (cross-session transcript RAG). " +
      "list_skills / get_skill expose Agent Skills from the skills/ tree (each folder with SKILL.md). " +
      "Add new capabilities by adding skills/<skill-id>/SKILL.md — no MCP code change required. " +
      "Optional INK_ECHO_MCP_BACKEND_TOKEN sets Authorization.",
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
    description: `List InkEcho sessions from the backend HTTP API (${backendBase}/sessions).`,
    inputSchema: z
      .object({
        limit: z.number().int().min(1).max(200).optional().describe("Max sessions (default 50)"),
      })
      .optional(),
  },
  async (args) => {
    const limit = args?.limit ?? 50;
    const r = await backendFetch(`/sessions?limit=${limit}`);
    const text = await r.text();
    if (!r.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "backend_request_failed", status: r.status, body: text }) }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text }],
    };
  },
);

server.registerTool(
  "get_transcript",
  {
    description: "Fetch transcript segments for a session (GET /sessions/{id}).",
    inputSchema: z.object({
      sessionId: z.string().uuid(),
    }),
  },
  async ({ sessionId }) => {
    const r = await backendFetch(`/sessions/${sessionId}`);
    const text = await r.text();
    if (!r.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "backend_request_failed", status: r.status, body: text }) }],
        isError: true,
      };
    }
    try {
      const body = JSON.parse(text) as {
        id: string;
        segments: unknown[];
        status: string;
        title: string | null;
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId: body.id,
                status: body.status,
                title: body.title,
                segments: body.segments,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text }] };
    }
  },
);

server.registerTool(
  "get_summary",
  {
    description: "Fetch stored AI summary fields for a session (GET /sessions/{id}).",
    inputSchema: z.object({
      sessionId: z.string().uuid(),
    }),
  },
  async ({ sessionId }) => {
    const r = await backendFetch(`/sessions/${sessionId}`);
    const text = await r.text();
    if (!r.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "backend_request_failed", status: r.status, body: text }) }],
        isError: true,
      };
    }
    try {
      const body = JSON.parse(text) as {
        id: string;
        summary_text: string | null;
        summary_status: string;
        summary_error: string | null;
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId: body.id,
                summary_status: body.summary_status,
                summary_text: body.summary_text,
                summary_error: body.summary_error,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text }] };
    }
  },
);

server.registerTool(
  "semantic_search",
  {
    description:
      "Cross-session semantic search over indexed transcript chunks (backend POST /rag/search). " +
      "Indexes are built after transcription or via POST /rag/index/{sessionId}.",
    inputSchema: z.object({
      query: z.string().describe("Natural-language query"),
      limit: z.number().int().min(1).max(50).optional().describe("Max hits (default 8)"),
      sessionIds: z.array(z.string().uuid()).optional().describe("Only search these session UUIDs"),
    }),
  },
  async ({ query, limit, sessionIds }) => {
    const r = await fetch(`${backendBase}/rag/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(backendToken ? { Authorization: `Bearer ${backendToken}` } : {}),
      },
      body: JSON.stringify({
        query,
        limit: limit ?? 8,
        session_ids: sessionIds,
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "backend_request_failed", status: r.status, body: text }) }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "rag_answer",
  {
    description:
      "Answer a question using retrieved transcript excerpts across sessions, with LLM citations (backend POST /rag/answer).",
    inputSchema: z.object({
      question: z.string(),
      limit: z.number().int().min(1).max(20).optional().describe("Chunks to retrieve (default 6)"),
      sessionIds: z.array(z.string().uuid()).optional().describe("Restrict retrieval to these sessions"),
    }),
  },
  async ({ question, limit, sessionIds }) => {
    const r = await fetch(`${backendBase}/rag/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(backendToken ? { Authorization: `Bearer ${backendToken}` } : {}),
      },
      body: JSON.stringify({ question, limit: limit ?? 6, session_ids: sessionIds }),
    });
    const text = await r.text();
    if (!r.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "backend_request_failed", status: r.status, body: text }) }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text }] };
  },
);

/** Parallel HTTP /health for platform aggregation (backend probes this). Stdio MCP is unchanged. */
function startHealthHttpIfEnabled(): void {
  const raw = process.env.INK_ECHO_MCP_HEALTH_PORT;
  const port =
    raw === "" || raw === "0" ? 0 : Number.parseInt(raw ?? "3033", 10);
  if (!Number.isFinite(port) || port <= 0) return;

  const httpServer = http.createServer((req, res) => {
    const pathOnly = req.url?.split("?")[0] ?? "";
    if (req.method === "GET" && pathOnly === "/health") {
      const payload = JSON.stringify({
        ok: true,
        service: "ink-echo-mcp",
        instances: { expected: 1, healthy: 1 },
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(payload);
      return;
    }
    res.writeHead(404).end();
  });

  httpServer.on("error", (err) => {
    console.error(`[ink-echo-mcp] health HTTP :${port} —`, err);
  });
  httpServer.listen(port, "127.0.0.1", () => {
    console.error(`[ink-echo-mcp] health OK http://127.0.0.1:${port}/health`);
  });
}

startHealthHttpIfEnabled();

const transport = new StdioServerTransport();
await server.connect(transport);
