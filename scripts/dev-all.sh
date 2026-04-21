#!/usr/bin/env bash
# Start InkEcho dev: backend (8000), ai-api (8001), web (5173), MCP Streamable HTTP (3033).
#
# MCP exposes POST /mcp and GET /health (Platform). Cursor: .cursor/mcp.json → streamable-http URL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

DO_DOCKER=false
CLEAN_PORTS=true
ATTACH=false
NO_MCP=false
for arg in "$@"; do
  case "$arg" in
    --docker) DO_DOCKER=true ;;
    --no-clean) CLEAN_PORTS=false ;;
    --attach | --foreground) ATTACH=true ;;
    --no-mcp) NO_MCP=true ;;
    -h | --help)
      echo "Usage: $0 [--docker] [--no-clean] [--attach] [--no-mcp]"
      echo "  --docker     Run 'docker compose up -d' first (Postgres + MinIO)."
      echo "  --no-clean   Do not free ports 8000/8001/5173/3033 before starting."
      echo "  --attach     Block this terminal and stop all on Ctrl+C (default: background)."
      echo "  --no-mcp     Do not start apps/mcp-server (Streamable HTTP on :3033)."
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

if [[ "$NO_MCP" != true ]]; then
  if [[ ! -f "$ROOT/apps/mcp-server/dist/index.js" ]]; then
    (cd "$ROOT" && npm run build:mcp)
  fi
  (
    cd "$ROOT"
    export INK_ECHO_BACKEND_URL="${INK_ECHO_BACKEND_URL:-http://127.0.0.1:8000}"
    export INK_ECHO_MCP_HTTP_PORT="${INK_ECHO_MCP_HTTP_PORT:-3033}"
    exec node apps/mcp-server/dist/index.js
  ) >>"$LOG_DIR/mcp.log" 2>&1 &
  PIDS+=($!)
fi

printf '%s\n' "${PIDS[@]}" >"$LOG_DIR/dev-all.pids"

echo ""
echo "InkEcho dev (PIDs ${PIDS[*]}) — logs: $LOG_DIR"
echo "  Backend   http://127.0.0.1:8000/health"
echo "  AI-API    http://127.0.0.1:8001/health"
echo "  Web       http://127.0.0.1:5173/"
if [[ "$NO_MCP" != true ]]; then
  echo "  MCP       Streamable HTTP POST http://127.0.0.1:3033/mcp · GET /health"
else
  echo "  MCP       (skipped: --no-mcp)"
fi
echo ""
echo "Cursor MCP: .cursor/mcp.json (streamable-http → http://127.0.0.1:3033/mcp)"
echo ""
echo "Tail logs: tail -f $LOG_DIR/backend.log $LOG_DIR/ai-api.log $LOG_DIR/web.log $LOG_DIR/mcp.log"
echo "Stop all:  $ROOT/scripts/stop-all.sh"
echo ""

if [[ "$ATTACH" == true ]]; then
  echo "Attached mode: Ctrl+C stops all started processes."
  echo ""
  trap 'cleanup; rm -f "$LOG_DIR/dev-all.pids"; exit 130' INT TERM
  wait "${PIDS[@]}"
  cleanup
  rm -f "$LOG_DIR/dev-all.pids"
else
  trap - INT TERM
  echo "Services are running in the background; this terminal is free."
  echo "Use --attach if you want to block here and stop with Ctrl+C."
  exit 0
fi
