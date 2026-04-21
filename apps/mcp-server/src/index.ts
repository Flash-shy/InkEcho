#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { getSkill, listSkills, listSkillsForMcpRegistration } from "./skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultSkillsDir = path.resolve(__dirname, "..", "skills");
const skillsDir = process.env.INK_ECHO_SKILLS_DIR ?? defaultSkillsDir;
const backendBase = (process.env.INK_ECHO_BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const backendToken = (process.env.INK_ECHO_MCP_BACKEND_TOKEN ?? "").trim();

const listenHost = (process.env.INK_ECHO_MCP_HOST ?? "127.0.0.1").trim();
const listenPortRaw = process.env.INK_ECHO_MCP_HTTP_PORT ?? process.env.INK_ECHO_MCP_HEALTH_PORT ?? "3033";
const listenPort =
  listenPortRaw === "" || listenPortRaw === "0" ? 0 : Number.parseInt(listenPortRaw, 10);

function buildMcpHealthPayload(httpPort: number): string {
  const platformDetail = `pid=${process.pid} · streamable-http · :${httpPort}/mcp · GET /skills · GET /health`;
  return JSON.stringify({
    ok: true,
    service: "ink-echo-mcp",
    pid: process.pid,
    mcp_mode: "streamable-http",
    http_health_port: httpPort,
    mcp_path: "/mcp",
    stdio_mcp: false,
    streamable_http_mcp: true,
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

function textContent(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

const meetingMinutesInputSchema = z.object({
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
});

const semanticSearchInputSchema = z.object({
  query: z.string().describe("Natural-language query"),
  limit: z.number().int().min(1).max(50).optional().describe("Max hits (default 8)"),
  sessionIds: z.array(z.string().uuid()).optional().describe("Only search these session UUIDs"),
});

const ragAnswerInputSchema = z.object({
  question: z.string(),
  limit: z.number().int().min(1).max(20).optional().describe("Chunks to retrieve (default 6)"),
  sessionIds: z.array(z.string().uuid()).optional().describe("Restrict retrieval to these sessions"),
});

const crossSessionRagSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("search"),
    query: z.string(),
    limit: z.number().int().min(1).max(50).optional(),
    sessionIds: z.array(z.string().uuid()).optional(),
  }),
  z.object({
    operation: z.literal("answer"),
    question: z.string(),
    limit: z.number().int().min(1).max(20).optional(),
    sessionIds: z.array(z.string().uuid()).optional(),
  }),
]);

async function execGenerateMeetingMinutes(args: z.infer<typeof meetingMinutesInputSchema>) {
  const { sessionId, waitForResult, maxWaitSeconds } = args;
  const maxWaitMs = (maxWaitSeconds ?? 120) * 1000;
  const post = await backendPost(`/sessions/${sessionId}/meeting-minutes`);
  const postText = await post.text();

  if (!post.ok && post.status !== 409) {
    return {
      content: [
        textContent(
          JSON.stringify(
            { error: "meeting_minutes_start_failed", status: post.status, body: postText },
            null,
            2,
          ),
        ),
      ],
      isError: true,
    };
  }

  if (waitForResult === false) {
    return {
      content: [
        textContent(
          JSON.stringify(
            {
              sessionId,
              started: post.ok || post.status === 409,
              httpStatus: post.status,
              note: "Poll get_summary or GET /sessions/{id} for minutes_status / minutes_text.",
            },
            null,
            2,
          ),
        ),
      ],
    };
  }

  const polled = await pollMeetingMinutesUntilDone(sessionId, maxWaitMs);
  if (!polled.ok) {
    return {
      content: [
        textContent(
          JSON.stringify(
            {
              error: polled.error,
              sessionId,
              status: polled.status,
              body: polled.body,
            },
            null,
            2,
          ),
        ),
      ],
      isError: true,
    };
  }

  const s = polled.session;
  return {
    content: [
      textContent(
        JSON.stringify(
          {
            sessionId: s.id,
            minutes_status: s.minutes_status,
            minutes_text: s.minutes_text,
            minutes_error: s.minutes_error,
          },
          null,
          2,
        ),
      ),
    ],
    isError: s.minutes_status === "error",
  };
}

async function execSemanticSearch(args: z.infer<typeof semanticSearchInputSchema>) {
  const { query, limit, sessionIds } = args;
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
      content: [textContent(JSON.stringify({ error: "backend_request_failed", status: r.status, body: text }))],
      isError: true,
    };
  }
  return { content: [textContent(text)] };
}

async function execRagAnswer(args: z.infer<typeof ragAnswerInputSchema>) {
  const { question, limit, sessionIds } = args;
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
      content: [textContent(JSON.stringify({ error: "backend_request_failed", status: r.status, body: text }))],
      isError: true,
    };
  }
  return { content: [textContent(text)] };
}

async function createInkEchoMcpServer(): Promise<McpServer> {
  const server = new McpServer(
    { name: "ink-echo-mcp", version: "0.1.0" },
    {
      instructions:
        "InkEcho MCP (Streamable HTTP): connect to this server's POST /mcp endpoint. " +
        "list_sessions / get_transcript / get_summary call the backend at INK_ECHO_BACKEND_URL; " +
        "generate_meeting_minutes starts POST /sessions/{id}/meeting-minutes and polls until structured minutes are ready. " +
        "semantic_search / rag_answer call POST /rag/search and /rag/answer (cross-session transcript RAG). " +
        "list_skills / get_skill expose Agent Skills from the skills/ tree (each folder with SKILL.md). " +
        "Bundled skills also register skill_* tools (see list_skills). " +
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
    inputSchema: semanticSearchInputSchema,
  },
  execSemanticSearch,
);

server.registerTool(
  "rag_answer",
  {
    description:
      "Answer a question using retrieved transcript excerpts across sessions, with LLM citations (backend POST /rag/answer).",
    inputSchema: ragAnswerInputSchema,
  },
  execRagAnswer,
);

server.registerTool(
  "generate_meeting_minutes",
  {
    description:
      "Start AI meeting minutes for a transcribed session (POST /sessions/{id}/meeting-minutes), then poll GET /sessions/{id} until minutes_status is ready or error. " +
      "Returns topics / decisions / open questions / action items as stored minutes_text. If a job is already running (409), polls until it finishes.",
    inputSchema: meetingMinutesInputSchema,
  },
  execGenerateMeetingMinutes,
);

  await registerBundledSkillMcpTools(server);
  return server;
}

async function registerBundledSkillMcpTools(server: McpServer): Promise<void> {
  const entries = await listSkillsForMcpRegistration(skillsDir);
  const used = new Set<string>();
  for (const s of entries) {
    if (used.has(s.mcpToolName)) {
      console.error(`[ink-echo-mcp] skip skill "${s.id}": duplicate MCP tool name "${s.mcpToolName}"`);
      continue;
    }
    used.add(s.mcpToolName);

    const equiv =
      s.mcpBind === "generate_meeting_minutes"
        ? "generate_meeting_minutes"
        : s.mcpBind === "semantic_search"
          ? "semantic_search"
          : s.mcpBind === "rag_answer"
            ? "rag_answer"
            : s.mcpBind === "rag_bundle"
              ? "semantic_search | rag_answer"
              : "instructions (JSON body only)";
    const description = `${s.description.trim()} [Bundled skill: ${s.id}; same behavior as ${equiv}.]`;

    switch (s.mcpBind) {
      case "generate_meeting_minutes":
        server.registerTool(s.mcpToolName, { description, inputSchema: meetingMinutesInputSchema }, execGenerateMeetingMinutes);
        break;
      case "semantic_search":
        server.registerTool(s.mcpToolName, { description, inputSchema: semanticSearchInputSchema }, execSemanticSearch);
        break;
      case "rag_answer":
        server.registerTool(s.mcpToolName, { description, inputSchema: ragAnswerInputSchema }, execRagAnswer);
        break;
      case "rag_bundle":
        server.registerTool(
          s.mcpToolName,
          {
            description,
            inputSchema: crossSessionRagSchema,
          },
          async (args) => {
            if (args.operation === "search") {
              return execSemanticSearch({
                query: args.query,
                limit: args.limit,
                sessionIds: args.sessionIds,
              });
            }
            return execRagAnswer({
              question: args.question,
              limit: args.limit,
              sessionIds: args.sessionIds,
            });
          },
        );
        break;
      case "instructions_only":
        server.registerTool(s.mcpToolName, { description }, async () => {
          const skill = await getSkill(skillsDir, s.id);
          if (!skill) {
            return {
              content: [textContent(JSON.stringify({ error: "not_found", skillId: s.id }))],
              isError: true,
            };
          }
          return {
            content: [
              textContent(
                JSON.stringify(
                  {
                    ...skill,
                    note: "Instructions only — use other MCP tools (e.g. list_sessions) as described in body.",
                  },
                  null,
                  2,
                ),
              ),
            ],
          };
        });
        break;
    }
  }
}

if (!Number.isFinite(listenPort) || listenPort <= 0) {
  console.error(
    "[ink-echo-mcp] Set INK_ECHO_MCP_HTTP_PORT or INK_ECHO_MCP_HEALTH_PORT to a positive port (default 3033). Use 0 only to disable; HTTP MCP requires a port.",
  );
  process.exit(1);
}

const app = createMcpExpressApp({ host: listenHost });

app.get("/health", (_req: ExpressRequest, res: ExpressResponse) => {
  res.type("application/json; charset=utf-8").send(buildMcpHealthPayload(listenPort));
});

/** Read-only HTTP catalog (same data as MCP tools list_skills / get_skill). */
app.get("/skills", async (_req: ExpressRequest, res: ExpressResponse) => {
  try {
    const skills = await listSkills(skillsDir);
    res.json({ skills });
  } catch (err) {
    console.error("[ink-echo-mcp] GET /skills:", err);
    res.status(500).json({ error: "skills_list_failed" });
  }
});

app.get("/skills/:skillId", async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const raw = req.params.skillId;
    const skillId = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
    const skill = await getSkill(skillsDir, skillId);
    if (!skill) {
      res.status(404).json({ error: "skill_not_found", skillId });
      return;
    }
    res.json(skill);
  } catch (err) {
    console.error("[ink-echo-mcp] GET /skills/:skillId:", err);
    res.status(500).json({ error: "skill_read_failed" });
  }
});

app.all("/mcp", async (req: ExpressRequest, res: ExpressResponse) => {
  const server = await createInkEchoMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (err) {
    console.error("[ink-echo-mcp] /mcp error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.listen(listenPort, listenHost, () => {
  console.error(
    `[ink-echo-mcp] MCP http://${listenHost}:${listenPort}/mcp · skills http://${listenHost}:${listenPort}/skills · health http://${listenHost}:${listenPort}/health`,
  );
});
