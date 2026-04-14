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

/** True after `StdioServerTransport` has connected (Cursor / Inspector). */
let stdioTransportConnected = false;

function mcpModeLabel(): string {
  const m = (process.env.INK_ECHO_MCP_MODE ?? "stdio").trim().toLowerCase();
  return m === "health-only" ? "health-only" : "stdio";
}

function buildMcpHealthPayload(httpPort: number): string {
  const mode = mcpModeLabel();
  const stdioOn = mode === "health-only" ? false : stdioTransportConnected;
  const stdioPart = stdioOn ? "stdio=yes" : "stdio=no";
  const platformDetail = `pid=${process.pid} · ${mode} · HTTP :${httpPort} · ${stdioPart}`;
  return JSON.stringify({
    ok: true,
    service: "ink-echo-mcp",
    pid: process.pid,
    mcp_mode: mode,
    http_health_port: httpPort,
    stdio_mcp: stdioOn,
    /** Single line for Platform menu (this process only — not a cluster count). */
    platform_detail: platformDetail,
  });
}

async function backendFetch(pathSuffix: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (backendToken) headers.Authorization = `Bearer ${backendToken}`;
  return fetch(`${backendBase}${pathSuffix}`, { headers });
}

async function backendPost(pathSuffix: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (backendToken) headers.Authorization = `Bearer ${backendToken}`;
  return fetch(`${backendBase}${pathSuffix}`, { method: "POST", headers });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SessionMinutesFields = {
  id: string;
  minutes_text: string | null;
  minutes_status: string;
  minutes_error: string | null;
};

async function pollMeetingMinutesUntilDone(
  sessionId: string,
  maxWaitMs: number,
): Promise<{ ok: true; session: SessionMinutesFields } | { ok: false; error: string; status?: number; body?: string }> {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const r = await backendFetch(`/sessions/${sessionId}`);
    const text = await r.text();
    if (!r.ok) {
      return { ok: false, error: "backend_request_failed", status: r.status, body: text };
    }
    try {
      const body = JSON.parse(text) as SessionMinutesFields;
      const st = body.minutes_status ?? "idle";
      if (st === "ready" || st === "error") {
        return { ok: true, session: body };
      }
    } catch {
      return { ok: false, error: "invalid_json", body: text };
    }
    await sleepMs(450);
  }
  return { ok: false, error: "timeout", body: `Meeting minutes still running after ${maxWaitMs}ms` };
}

const server = new McpServer(
  { name: "ink-echo-mcp", version: "0.1.0" },
  {
    instructions:
      "InkEcho MCP: list_sessions / get_transcript / get_summary call the backend at INK_ECHO_BACKEND_URL; " +
      "generate_meeting_minutes starts POST /sessions/{id}/meeting-minutes and polls until structured minutes are ready. " +
      "semantic_search / rag_answer call POST /rag/search and /rag/answer (cross-session transcript RAG). " +
      "list_skills / get_skill expose Agent Skills from the skills/ tree (each folder with SKILL.md). " +
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
    description:
      "Fetch stored AI summary and meeting-minutes fields for a session (GET /sessions/{id}): summary_* and minutes_*.",
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
        minutes_text?: string | null;
        minutes_status?: string;
        minutes_error?: string | null;
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
                minutes_status: body.minutes_status ?? "idle",
                minutes_text: body.minutes_text ?? null,
                minutes_error: body.minutes_error ?? null,
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

server.registerTool(
  "generate_meeting_minutes",
  {
    description:
      "Start AI meeting minutes for a transcribed session (POST /sessions/{id}/meeting-minutes), then poll GET /sessions/{id} until minutes_status is ready or error. " +
      "Returns topics / decisions / open questions / action items as stored minutes_text. If a job is already running (409), polls until it finishes.",
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      waitForResult: z
        .boolean()
        .optional()
        .describe("If true (default), block until ready/error or timeout. If false, return immediately after POST."),
      maxWaitSeconds: z
        .number()
        .int()
        .min(10)
        .max(600)
        .optional()
        .describe("Max seconds to poll when waitForResult is true (default 120)"),
    }),
  },
  async ({ sessionId, waitForResult, maxWaitSeconds }) => {
    const maxWaitMs = (maxWaitSeconds ?? 120) * 1000;
    const post = await backendPost(`/sessions/${sessionId}/meeting-minutes`);
    const postText = await post.text();

    if (!post.ok && post.status !== 409) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "meeting_minutes_start_failed", status: post.status, body: postText },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    if (waitForResult === false) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId,
                started: post.ok || post.status === 409,
                httpStatus: post.status,
                note: "Poll get_summary or GET /sessions/{id} for minutes_status / minutes_text.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const polled = await pollMeetingMinutesUntilDone(sessionId, maxWaitMs);
    if (!polled.ok) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: polled.error,
                sessionId,
                status: polled.status,
                body: polled.body,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const s = polled.session;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionId: s.id,
              minutes_status: s.minutes_status,
              minutes_text: s.minutes_text,
              minutes_error: s.minutes_error,
            },
            null,
            2,
          ),
        },
      ],
      isError: s.minutes_status === "error",
    };
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
      const payload = buildMcpHealthPayload(port);
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

const mcpMode = (process.env.INK_ECHO_MCP_MODE ?? "stdio").trim().toLowerCase();
if (mcpMode === "health-only") {
  const raw = process.env.INK_ECHO_MCP_HEALTH_PORT ?? "3033";
  const port = raw === "" || raw === "0" ? 0 : Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    console.error(
      "[ink-echo-mcp] INK_ECHO_MCP_MODE=health-only requires INK_ECHO_MCP_HEALTH_PORT > 0 (HTTP /health for platform probe).",
    );
    process.exit(1);
  }
  console.error(
    "[ink-echo-mcp] health-only mode: no stdio MCP (Platform /health only). Use default mode for Cursor tools (list_skills, semantic_search, …).",
  );
  await new Promise<never>(() => {});
}

const transport = new StdioServerTransport();
await server.connect(transport);
stdioTransportConnected = true;
