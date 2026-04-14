# InkEcho

InkEcho captures what you hear on your computer (meetings, lessons, calls), transcribes it in real time or near real time, and uses AI to produce summaries and structured notes. You can plug in third-party APIs or local, offline-capable models (OpenAI-compatible endpoints). Results can be exported in multiple document formats.

The long-term goal is **multi-device sync** and an **out-of-the-box** experience. Development starts as a **web-first** platform; a **desktop companion** for better system-audio capture is a later iteration.

---

## What InkEcho is (and is not)

- **In scope**: A **session** begins when you start listening/recording and ends when you stop. Heavy “create meeting” workflows are not required for v1—optional titles and tags can come later.
- **Focus**: Listen to audio that represents on-computer output, transcribe, then summarize (minutes, actions, recap).

---

## Web platform limitation: “system audio”

Browsers **cannot** silently tap global speaker output like a native loopback driver. Practical approaches:

1. **Screen or tab capture with audio** (`getDisplayMedia` with `audio: true`)—the user selects the tab, window, or screen that carries the meeting audio (common in Chromium-based browsers).
2. **File upload**—recordings from OBS, QuickTime, or other tools for offline transcription and summarization.
3. **Future desktop companion**—true loopback without repeated share prompts, using the same backend and account model.

---

## Four-service architecture

InkEcho is **four deployable services** with narrow contracts so you can scale, secure, and replace implementations without a monolith.

| Service | Role | Talks to |
|--------|------|----------|
| **Frontend** (`apps/web`) | React SPA: capture UX, transcript UI, settings, export downloads | **Backend** only (HTTP + WebSocket) |
| **Backend** (`apps/backend`) | Product API: auth, sessions, transcript storage, export jobs; **orchestrates** AI work; **does not** expose raw provider keys to the browser | PostgreSQL, object storage, **AI-API** (mTLS or signed service JWT), optional queue |
| **AI-API** (`apps/ai-api`) | Model boundary: streaming STT, chat/completions, future embeddings / RAG inference | Upstream LLM/STT (cloud or local OpenAI-compatible servers) |
| **MCP server** (`apps/mcp-server`) | MCP **data tools** for agents (sessions, transcripts, semantic search later) **plus** bundled **Agent Skills** (`SKILL.md` trees) exposed via MCP tools/resources (e.g. `list_skills`, `get_skill`) | **Backend** internal / read API (single authorization story); skills are read from the MCP bundle on disk |

**Trust boundary**: Browsers and MCP clients **do not** call AI-API directly. The backend decides when to transcribe or summarize, sends job descriptors and server-side credentials to AI-API, persists results, and streams progress to the web app. **Skills are non-secret instructional content** for agents (markdown only); API keys and private user data still flow through the backend only.

### Diagram

```mermaid
flowchart TB
  subgraph clients [Clients]
    Web[Frontend_web]
    MCPClient[MCP_clients]
    FutureDesktop[Desktop_later]
  end
  subgraph core [Core_platform]
    Backend[Backend_API_WS]
    AIAPI[AI_API]
    MCP[MCP_server]
    SkillsBundle[skills_SKILL_md_bundle]
  end
  subgraph data [Data]
    PG[(PostgreSQL)]
    OBJ[(Object_storage)]
  end
  Web -->|HTTPS_WSS| Backend
  FutureDesktop -->|HTTPS_WSS| Backend
  Backend --> PG
  Backend --> OBJ
  Backend -->|internal_HTTP| AIAPI
  MCPClient -->|MCP| MCP
  MCP -->|internal_read_API| Backend
  MCP -->|read_bundle| SkillsBundle
```

**Live transcript path**: Web → Backend (WebSocket) → AI-API (chunked HTTP or WebSocket) → Backend persists segments → Backend → Web.

---

## Suggested stack

| Piece | Choice | Notes |
|-------|--------|--------|
| Frontend | TypeScript + React (Vite) | Optional OpenAPI client codegen from the backend |
| Backend | Fastify, NestJS, or FastAPI | TS keeps product CRUD separate from ML; FastAPI for both backend and AI-API is fine if you want one Python surface |
| AI-API | Python + FastAPI (default) | Whisper / faster-whisper, streaming audio, embeddings, adapters to OpenAI-compatible APIs |
| MCP server | TypeScript (`@modelcontextprotocol/sdk`) or Python | Thin, I/O-bound |
| Data | PostgreSQL + S3-compatible storage | Backend owns persistence; AI-API stays stateless aside from ephemeral buffers |
| Real-time | WebSocket on **Backend** | Fan out partial transcripts and job status |

Provider adapters (**`TranscribeStream`**, **`ChatComplete`**, later **`Embed`**) live in **AI-API**. The **backend** stores user preferences and encrypted credentials; **prompt templates** (summary, action items, minutes) can be versioned on the backend and passed by id in jobs so copy changes do not require redeploying AI-API.

---

## Exports

- **v1**: Markdown, plain text, JSON (full session + segments).
- **Later**: DOCX, PDF via async jobs so exports do not block the API.

---

## MCP and RAG

- **MCP v1** (examples): `list_sessions`, `get_transcript`, `get_summary`—implemented against backend internal routes, not direct database access from the MCP process.
- **Later**: `semantic_search` / `rag_answer` via backend + AI-API (embed + retrieve); MCP tool names stay stable while implementations evolve.
- **RAG**: embeddings and vector storage (e.g. pgvector); ingestion triggered after transcript finalization; heavy work in AI-API or a queue worker.

Ship the MCP server as its own artifact (e.g. Docker image or `npx` / `uv run` entrypoint).

### Agent skills in MCP

The MCP server ships a **bundled skill tree** (Cursor-style: `apps/mcp-server/skills/<skill-name>/SKILL.md` with YAML `name` and `description`, plus optional `reference.md` / scripts). Agents **discover** skills through MCP—recommended v1 tools: **`list_skills`** and **`get_skill`** (by skill id); **resources** (e.g. `ink-echo://skills/{name}`) are optional for hosts that prefer URI-based reads. Skills are **instructions only**; they do not replace backend auth or hold secrets.

**Bundled skills (target catalog)** — retrieval and embeddings remain in **backend + AI-API**; each skill tells the agent *how* to use tool outputs.

| Skill id | One-line purpose |
|----------|------------------|
| `meeting-minutes` | Structured minutes from one transcript: topics, decisions, open questions; link claims to timecodes/segment ids when available. |
| `action-items` | Extract who / what / by when; flag uncertainty; output task-friendly lists. |
| `summary-and-titles` | Short summary, one-line title, optional sections for UI and search snippets. |
| `export-prep` | Normalize content for Markdown, plain text, or JSON exports and downstream DOCX/PDF. |
| `quality-and-consistency` | Optional polish: glossary, name normalization, redaction rules (instructions only—no secrets in the file). |
| `cross-session-retrieval-answer` | After **RAG** tools (e.g. `semantic_search`, `rag_answer`, transcript chunks): cite sources (session id + chunk/span or quote + timestamp), structure the answer (direct answer first, then cited bullets), hedge or refuse when evidence is weak; do not invent meetings or quotes. |

**`cross-session-retrieval-answer`**: Vector search, reranking, and model calls live in **backend** (orchestration) and **AI-API** (embed / generate). The skill must **not** duplicate retrieval logic—it only standardizes **citation format**, **answer shape**, and **safe hedging** across MCP clients. Until semantic tools ship, this skill may ship as a **stub** or state in its `description` that it applies once `semantic_search` (or equivalent) is available—keep skill text in sync when tool response shapes change.

---

## Repository layout (monorepo)

- `apps/web` — Frontend  
- `apps/backend` — Product API + WebSocket  
- `apps/ai-api` — STT / LLM / embeddings  
- `apps/mcp-server` — MCP process  
- `apps/mcp-server/skills/` — Bundled Agent Skills (`SKILL.md` per skill)  
- `packages/shared-types` — Shared DTOs / generated types (optional)  

---

## Roadmap (phased)

1. **MVP**: Run **web + backend + ai-api + mcp-server** locally (e.g. Compose); sessions and transcripts on the backend; web capture or upload; STT/LLM via AI-API; minimal MCP data tools **and** `list_skills` / `get_skill` over the bundled skill tree; export MD / TXT / JSON.
2. **Sync**: Real auth, multi-device session list, provider secrets only on the backend.
3. **Exports**: DOCX / PDF async on the backend.
4. **RAG**: Vectors in Postgres; semantic MCP tools.
5. **Desktop companion**: Loopback capture; still uses **backend** only.

---

## Risks and mitigations

- **Capture UX**: Onboarding for “share the tab with audio”; file upload fallback.
- **Latency**: Stream partial STT; optional fast draft model vs. final pass.
- **Privacy**: Local STT/LLM options and clear retention controls in later milestones.

---

## Status

Monorepo **scaffold** is in place: `apps/web`, `apps/backend`, `apps/ai-api`, `apps/mcp-server`, plus Docker Compose for Postgres and MinIO. Session/STT/WebSocket work is **not** implemented yet (next roadmap steps).

## Local development (scaffold)

**One-shot (three HTTP/Web processes + MCP instructions):** from the repo root,

```bash
./scripts/dev-all.sh # frees 8000 / 8001 / 5173 first, then backend + ai-api + web
./scripts/dev-all.sh --docker # same, after docker compose up -d
./scripts/dev-all.sh --no-clean # skip port cleanup (only if you know nothing else needs those ports)
./scripts/stop-all.sh        # stop listeners on 8000 / 8001 / 5173 (+ recorded PIDs)
./scripts/stop-all.sh --force # if SIGTERM was not enough (SIGKILL)
```

If `dev-all.sh` still returns immediately, check `logs/*.log` (e.g. `pip` or Vite errors). **Docker Desktop** or other tools sometimes bind **8000**; either stop that container or change the backend port in code and env.

MCP uses **stdio**; the script prints the `node …/dist/index.js` command for Cursor (or run `npm run dev:mcp` in another terminal). See script header comments.

1. **Infra (optional for hello-world):** from the repo root, `cp .env.example .env` and run `docker compose up -d` for Postgres (`5432`) and MinIO (`9000` / console `9001`).
2. **Backend** (`apps/backend`): `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`, then `uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`. Settings read from the environment; you can place a `.env` in `apps/backend/` or export vars from the root `.env` (see `.env.example`).
3. **AI-API** (`apps/ai-api`): same pattern, `uvicorn app.main:app --reload --host 127.0.0.1 --port 8001`.
4. **Web** (`apps/web`): from repo root, `npm install` then `npm run dev:web` (uses `apps/web/vite.config.ts` so the root is always `apps/web`, even from the monorepo root). The dev server proxies `/api` → backend (default `http://127.0.0.1:8000`); open **http://127.0.0.1:5173/**. Alternative: `cd apps/web && npm run dev`.
5. **MCP server** (`apps/mcp-server`): `npm run dev:mcp` (stdio) or `npm run build:mcp && node apps/mcp-server/dist/index.js`. Bundled skills live under `apps/mcp-server/skills/`. Override the directory with `INK_ECHO_SKILLS_DIR` if needed.

Root **npm** workspaces: `@ink-echo/web` and `@ink-echo/mcp-server`. Python apps keep their own `requirements.txt`.

## License

See [LICENSE](LICENSE).
