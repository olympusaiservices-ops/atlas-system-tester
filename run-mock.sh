#!/usr/bin/env bash
#
# run-mock.sh — run Atlas System Tester against the Atlas Core API Tester (mock backend)
# so you can open and iterate on the Verify UI without the live cluster.
#
# What it does:
#   1. Ensures the mock backend is listening on :3004 (starts just the mock's
#      Python API if not — NOT the Angular portal). If you also want the portal,
#      run the tester's own start.sh.
#   2. Starts Verify in dev mode (Vite web with HMR + the Fastify server) with all
#      five ATLAS_*_URL pointed at the mock, and admin creds so it auto-connects.
#
# Open the UI at:  http://localhost:5173
# Stop Verify (leaving the mock running) with:  ./stop-mock.sh
#
# Override any of these via env:
#   MOCK_DIR              (default /home/atlas1/atlas-core-api-tester)
#   MOCK_PORT            (default 3004)
#   VERIFY_SERVER_PORT   (default 8080)   Fastify API + SSE
#   VERIFY_ADMIN_EMAIL   (default admin@localatlas.io)   any value works on the mock
#   VERIFY_ADMIN_PASSWORD(default mock-password)
#   LOG_LEVEL            (default info)
#
# The web UI port is fixed at 5173 (Vite dev server; see web/vite.config.ts).
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
MOCK_DIR="${MOCK_DIR:-/home/atlas1/atlas-core-api-tester}"
MOCK_PORT="${MOCK_PORT:-3004}"
VERIFY_SERVER_PORT="${VERIFY_SERVER_PORT:-8080}"
VERIFY_WEB_PORT=5173   # fixed in web/vite.config.ts

# Bind the Vite dev server to all interfaces so machines on the same network can
# reach the UI. Override VERIFY_WEB_HOST=localhost to keep it host-only.
export VERIFY_WEB_HOST="${VERIFY_WEB_HOST:-true}"

# Best-effort LAN IP a same-network browser should use (source IP of the default
# route; falls back to the first `hostname -I` address).
lan_ip() {
  local ip
  ip="$(ip route get 1.1.1.1 2>/dev/null \
        | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  [[ -z "$ip" ]] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "$ip"
}

RUN_DIR="$REPO/.run"
PID_FILE="$RUN_DIR/verify.pid"
LOG_FILE="$RUN_DIR/verify.log"
DATA_DIR="$RUN_DIR/mock-data"
mkdir -p "$RUN_DIR" "$DATA_DIR"

# --- helpers ----------------------------------------------------------------
port_in_use() { lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1; }

# Wait up to $2 seconds for a TCP port ($1) to start listening.
wait_for_port() {
  local port="$1" timeout="$2" waited=0
  while ! port_in_use "$port"; do
    sleep 1; waited=$((waited + 1))
    [[ "$waited" -ge "$timeout" ]] && return 1
  done
  return 0
}

pid_alive() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

echo "=================================================="
echo "  This is the mock version of Atlas System Tester"
echo "=================================================="
echo "Atlas System Tester — mock mode"
echo "  mock backend : http://localhost:$MOCK_PORT   (Atlas Core API Tester)"
echo "  verify api   : http://localhost:$VERIFY_SERVER_PORT"
echo "  verify UI    : http://localhost:$VERIFY_WEB_PORT"
echo

# --- 0. guard: already running? --------------------------------------------
if pid_alive || port_in_use "$VERIFY_WEB_PORT"; then
  echo "Verify already appears to be running (pid file live or :$VERIFY_WEB_PORT in use)."
  echo "Stop it first with ./stop-mock.sh, then re-run."
  exit 0
fi

# --- 1. ensure the mock backend is up --------------------------------------
if port_in_use "$MOCK_PORT"; then
  echo "[mock] already listening on :$MOCK_PORT — leaving it running."
else
  if [[ ! -d "$MOCK_DIR" ]]; then
    echo "[mock] not found at $MOCK_DIR — set MOCK_DIR or start it yourself." >&2
    exit 1
  fi
  echo "[mock] starting Atlas Core API Tester (backend only)..."
  mkdir -p "$MOCK_DIR/.run" "$MOCK_DIR/logs"
  # setsid + PID file mirrors the tester's own start.sh, so its stop.sh can
  # still stop this process. Only the Python API is started here (no portal-web).
  ( cd "$MOCK_DIR" && ATLAS_TESTER_PORT="$MOCK_PORT" \
      setsid bash -c 'echo $$ > "$0"; exec python3 -m app.server' "$MOCK_DIR/.run/backend.pid" \
      >"$MOCK_DIR/logs/backend.log" 2>&1 < /dev/null & )
  if wait_for_port "$MOCK_PORT" 20; then
    echo "[mock] up (pid $(cat "$MOCK_DIR/.run/backend.pid")) — http://localhost:$MOCK_PORT"
  else
    echo "[mock] FAILED to start within 20s. Last log lines:" >&2
    tail -n 20 "$MOCK_DIR/logs/backend.log" 2>/dev/null || true
    exit 1
  fi
fi

# --- 2. start Verify in dev mode against the mock --------------------------
export ATLAS_NAMESPACE="atlas-core"
export ATLAS_IDENTITY_URL="http://localhost:$MOCK_PORT"
export ATLAS_EMAIL_URL="http://localhost:$MOCK_PORT"
export ATLAS_APPSTORE_URL="http://localhost:$MOCK_PORT"
export ATLAS_NETWORK_URL="http://localhost:$MOCK_PORT"
export ATLAS_PORTAL_API_URL="http://localhost:$MOCK_PORT"
export PORT="$VERIFY_SERVER_PORT"
export VERIFY_DATA_DIR="$DATA_DIR"
export VERIFY_API_TARGET="http://localhost:$VERIFY_SERVER_PORT"   # Vite proxy → server
export VERIFY_ADMIN_EMAIL="${VERIFY_ADMIN_EMAIL:-admin@localatlas.io}"
export VERIFY_ADMIN_PASSWORD="${VERIFY_ADMIN_PASSWORD:-mock-password}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

echo "[verify] starting dev server (Vite + Fastify)..."
# New session so the whole npm/concurrently/vite/tsx tree shares one process
# group; stop-mock.sh kills exactly that group by the leader PID recorded here.
( cd "$REPO" && \
    setsid bash -c 'echo $$ > "$0"; exec npm run dev' "$PID_FILE" \
    >"$LOG_FILE" 2>&1 < /dev/null & )

if ! wait_for_port "$VERIFY_SERVER_PORT" 60; then
  echo "[verify] server did not come up on :$VERIFY_SERVER_PORT within 60s. Last log lines:" >&2
  tail -n 30 "$LOG_FILE" 2>/dev/null || true
  exit 1
fi
if ! wait_for_port "$VERIFY_WEB_PORT" 60; then
  echo "[verify] web (Vite) did not come up on :$VERIFY_WEB_PORT within 60s. Last log lines:" >&2
  tail -n 30 "$LOG_FILE" 2>/dev/null || true
  exit 1
fi

# Give auto-connect a moment, then report connection state.
sleep 2
CONN="$(curl -sS "http://localhost:$VERIFY_SERVER_PORT/vapi/connection" 2>/dev/null || true)"

LAN_IP="$(lan_ip)"

echo
echo "=================================================="
echo "  This is the mock version of Atlas System Tester"
echo "=================================================="
echo "✅ Atlas System Tester is up in mock mode (pid $(cat "$PID_FILE"))."
echo "   UI (this machine) : http://localhost:$VERIFY_WEB_PORT"
if [[ -n "$LAN_IP" ]]; then
  echo "   UI (same network) : http://$LAN_IP:$VERIFY_WEB_PORT   ← share this address"
else
  echo "   UI (same network) : could not determine this machine's LAN IP;"
  echo "                       find it with 'hostname -I' and use http://<ip>:$VERIFY_WEB_PORT"
fi
echo "   (Vite HMR — edit web/src and it hot-reloads)"
echo "   API       : http://localhost:$VERIFY_SERVER_PORT/vapi"
echo "   Log       : .run/verify.log"
if echo "$CONN" | grep -q '"connected":true'; then
  echo "   Connected : yes (auto-connected to the mock as $VERIFY_ADMIN_EMAIL)"
else
  echo "   Connected : not yet — the UI can connect from the Connection panel."
fi
echo "   Stop Verify (mock keeps running): ./stop-mock.sh"
