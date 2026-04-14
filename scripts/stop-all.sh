#!/usr/bin/env bash
# Stop InkEcho dev processes: listeners on backend 8000, ai-api 8001, web 5173.
# Also kills PIDs recorded by ./scripts/dev-all.sh in logs/dev-all.pids (if present).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
PID_FILE="$LOG_DIR/dev-all.pids"
PORTS=(8000 8001 5173)

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE=true
      ;;
    -h | --help)
      echo "Usage: $0 [--force]"
      echo "  Stops TCP listeners on ports 8000 (backend), 8001 (ai-api), 5173 (Vite)."
      echo "  Also sends SIGTERM to PIDs listed in $PID_FILE from dev-all.sh."
      echo "  --force  send SIGKILL if something is still listening after ~1s."
      echo ""
      echo "Note: if Docker or another app uses these ports, they may be stopped too."
      exit 0
      ;;
  esac
done

pids_listening_on_port() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    echo "lsof not found; install it or stop processes manually." >&2
    exit 1
  fi
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true
}

kill_pids_term() {
  local pid
  for pid in "$@"; do
    [[ -n "${pid:-}" ]] || continue
    kill "$pid" 2>/dev/null || true
  done
}

kill_pids_kill() {
  local pid
  for pid in "$@"; do
    [[ -n "${pid:-}" ]] || continue
    kill -9 "$pid" 2>/dev/null || true
  done
}

echo "Stopping InkEcho dev services (ports ${PORTS[*]})…"

for port in "${PORTS[@]}"; do
  _plist="$(pids_listening_on_port "$port")"
  if [[ -n "$_plist" ]]; then
    echo "  port $port: $(echo "$_plist" | tr '\n' ' ')"
    for pid in $_plist; do
      kill_pids_term "$pid"
    done
  fi
done

if [[ -f "$PID_FILE" ]]; then
  while read -r line; do
    [[ "$line" =~ ^[0-9]+$ ]] || continue
    echo "  dev-all.pid: $line"
    kill_pids_term "$line"
  done <"$PID_FILE"
fi

sleep 1

if [[ "$FORCE" == true ]]; then
  for port in "${PORTS[@]}"; do
    _plist="$(pids_listening_on_port "$port")"
    if [[ -n "$_plist" ]]; then
      echo "  force port $port: $(echo "$_plist" | tr '\n' ' ')"
      for pid in $_plist; do
        kill_pids_kill "$pid"
      done
    fi
  done
fi

rm -f "$PID_FILE"

echo "Done. Verify with: lsof -nP -iTCP:8000 -sTCP:LISTEN && lsof -nP -iTCP:8001 -sTCP:LISTEN && lsof -nP -iTCP:5173 -sTCP:LISTEN"
