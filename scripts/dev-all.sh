#!/usr/bin/env bash
# Start InkEcho HTTP/Web dev processes: backend (8000), ai-api (8001), web (5173),
# plus MCP HTTP /health on 3033 (health-only) so GET /health/platform shows MCP OK.
# Full stdio MCP for Cursor is still configured separately in the IDE; see printed instructions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

DO_DOCKER=false
CLEAN_PORTS=true
ATTACH=false
for arg in "$@"; do
  case "$arg" in
    --docker) DO_DOCKER=true ;;
    --no-clean) CLEAN_PORTS=false ;;
    --attach | --foreground) ATTACH=true ;;
    -h | --help)
      echo "Usage: $0 [--docker] [--no-clean] [--attach]"
      echo "  --docker     Run 'docker compose up -d' first (Postgres + MinIO)."
      echo "  --no-clean   Do not free ports 8000/8001/5173 before starting."
      echo "  --attach     Block this terminal and stop all on Ctrl+C (default: background)."
      exit 0
      ;;
  esac
done

PIDS=()

cleanup() {
  local p
  for p in "${PIDS[@]:-}"; do
    kill "$p" 2>/dev/null || true
  done
}

# During setup, Ctrl+C stops anything we already started.
trap 'cleanup; exit 130' INT TERM

ensure_venv() (
  set -e
  cd "$1"
  if [[ ! -x .venv/bin/python ]]; then
    python3 -m venv .venv
  fi
  .venv/bin/pip install -q -r requirements.txt
)

if [[ "$DO_DOCKER" == true ]]; then
  (cd "$ROOT" && docker compose up -d)
fi

if [[ "$CLEAN_PORTS" == true ]]; then
  echo "Freeing dev ports 8000 / 8001 / 5173 / 3033 (avoid 'Address already in use')…"
  bash "$ROOT/scripts/stop-all.sh"
  echo ""
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  (cd "$ROOT" && npm install)
fi

ensure_venv "$ROOT/apps/backend"
ensure_venv "$ROOT/apps/ai-api"

(
  cd "$ROOT/apps/backend"
  exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
) >>"$LOG_DIR/backend.log" 2>&1 &
PIDS+=($!)

(
  cd "$ROOT/apps/ai-api"
  exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
) >>"$LOG_DIR/ai-api.log" 2>&1 &
PIDS+=($!)

(
  cd "$ROOT"
  exec npm run dev:web
) >>"$LOG_DIR/web.log" 2>&1 &
PIDS+=($!)

if [[ ! -f "$ROOT/apps/mcp-server/dist/index.js" ]]; then
  (cd "$ROOT" && npm run build:mcp)
fi

(
  cd "$ROOT"
  export INK_ECHO_MCP_MODE=health-only
  export INK_ECHO_MCP_HEALTH_PORT=3033
  exec node apps/mcp-server/dist/index.js
) >>"$LOG_DIR/mcp-health.log" 2>&1 &
PIDS+=($!)

printf '%s\n' "${PIDS[@]}" >"$LOG_DIR/dev-all.pids"

echo ""
echo "InkEcho dev (PIDs ${PIDS[*]}) — logs: $LOG_DIR"
echo "  Backend   http://127.0.0.1:8000/health"
echo "  AI-API    http://127.0.0.1:8001/health"
echo "  Web       http://127.0.0.1:5173/"
echo "  MCP /health (platform only)  http://127.0.0.1:3033/health"
echo ""
echo "Bundled Agent Skills (not in Cursor Settings → Skills): under apps/mcp-server/skills/"
echo "  • cross-session-retrieval-answer  • meeting-minutes"
echo "  In chat, use InkEcho MCP tools list_skills / get_skill, or semantic_search / rag_answer / generate_meeting_minutes."
echo ""
echo "Cursor MCP (full stdio tools): add ink-echo-mcp in Cursor; if port 3033 is in use by dev-all, set in that config:"
echo "  INK_ECHO_MCP_HEALTH_PORT=0"
echo "  Or stop dev-all’s health process and run one combined process:"
echo "    node $ROOT/apps/mcp-server/dist/index.js"
echo ""
echo "Tail logs: tail -f $LOG_DIR/backend.log $LOG_DIR/ai-api.log $LOG_DIR/web.log $LOG_DIR/mcp-health.log"
echo "Stop all:  $ROOT/scripts/stop-all.sh"
echo ""

if [[ "$ATTACH" == true ]]; then
  echo "Attached mode: Ctrl+C stops backend, ai-api, and web."
  echo ""
  trap 'cleanup; rm -f "$LOG_DIR/dev-all.pids"; exit 130' INT TERM
  wait "${PIDS[@]}"
  cleanup
  rm -f "$LOG_DIR/dev-all.pids"
else
  # Do not kill children when this script exits (no EXIT trap).
  trap - INT TERM
  echo "Services are running in the background; this terminal is free."
  echo "Use --attach if you want to block here and stop with Ctrl+C."
  exit 0
fi
