#!/usr/bin/env bash
#
# stop-mock.sh — stop the Atlas Verify dev processes started by run-mock.sh,
# WITHOUT touching the Atlas Core API Tester (mock) backend on :3004.
#
# Kills the Verify process group (npm/concurrently → Vite + Fastify) recorded in
# .run/verify.pid. The mock is left running so you can restart Verify quickly;
# stop the mock separately with the tester's own stop.sh.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$REPO/.run"
PID_FILE="$RUN_DIR/verify.pid"
VERIFY_SERVER_PORT="${VERIFY_SERVER_PORT:-8080}"
VERIFY_WEB_PORT=5173
MOCK_PORT="${MOCK_PORT:-3004}"

port_in_use() { lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1; }

if [[ ! -f "$PID_FILE" ]]; then
  echo "No .run/verify.pid — Verify does not appear to be running under run-mock.sh."
  # Best-effort: if the dev ports are up but unmanaged, point that out.
  if port_in_use "$VERIFY_WEB_PORT" || port_in_use "$VERIFY_SERVER_PORT"; then
    echo "Note: :$VERIFY_WEB_PORT/:$VERIFY_SERVER_PORT are in use but weren't started here; not touching them."
  fi
  exit 0
fi

PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "Verify process ($PID) already gone; cleaning up pid file."
  rm -f "$PID_FILE"
  exit 0
fi

echo "Stopping Verify process group (leader pid $PID)..."
# Negative PID = signal the whole process group (Vite + tsx + node children).
kill -TERM "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true

# Wait up to 10s for a graceful exit, then force.
for _ in $(seq 1 10); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  echo "Still alive — sending KILL."
  kill -KILL "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
  sleep 1
fi

rm -f "$PID_FILE"

if port_in_use "$VERIFY_WEB_PORT" || port_in_use "$VERIFY_SERVER_PORT"; then
  echo "⚠️  A Verify port is still in use; check 'lsof -i :$VERIFY_WEB_PORT -i :$VERIFY_SERVER_PORT'."
else
  echo "✅ Verify stopped."
fi

if port_in_use "$MOCK_PORT"; then
  echo "   Mock backend still running on :$MOCK_PORT (left untouched). Stop it with the tester's stop.sh."
fi
