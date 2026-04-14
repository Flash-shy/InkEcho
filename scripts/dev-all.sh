#!/usr/bin/env bash
# Start InkEcho HTTP/Web dev processes: backend (8000), ai-api (8001), web (5173).
# MCP uses stdio and is not run as a background daemon here; see printed instructions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

DO_DOCKER=false
CLEAN_PORTS=true
for arg in "$@"; do
  case "$arg" in
    --docker) DO_DOCKER=true ;;
    --no-clean) CLEAN_PORTS=false ;;
    -h|--help)
      echo "Usage: $0 [--docker] [--no-clean]"
      echo "  --docker Run 'docker compose up -d' first (Postgres + MinIO)."
      echo "  --no-clean   Do not free ports 8000/8001/5173 before starting (default is to stop them)."
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
trap cleanup EXIT INT TERM

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
  echo "Freeing dev ports 8000 / 8001 / 5173 (avoid 'Address already in use')…"
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

echo ""
echo "InkEcho dev (PIDs ${PIDS[*]}) — logs: $LOG_DIR"
echo "  Backend   http://127.0.0.1:8000/health"
echo "  AI-API    http://127.0.0.1:8001/health"
echo "  Web       http://127.0.0.1:5173/"
echo ""
echo "MCP server (stdio,4th process): not run in background."
echo "  Cursor / MCP client command:"
echo "    node $ROOT/apps/mcp-server/dist/index.js"
echo "  Or watch mode in another terminal:"
echo "    cd $ROOT && npm run dev:mcp"
echo ""
printf '%s\n' "${PIDS[@]}" >"$LOG_DIR/dev-all.pids"

echo "Tail logs: tail -f $LOG_DIR/backend.log $LOG_DIR/ai-api.log $LOG_DIR/web.log"
echo "Stop all:    Ctrl+C  or  $ROOT/scripts/stop-all.sh"
echo ""

wait "${PIDS[@]}"
