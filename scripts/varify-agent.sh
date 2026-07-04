#!/usr/bin/env bash
#
# varify-agent.sh — drive the atlas-varify tester headlessly from this host.
#
# Intended for a Claude instance (or a human) on a machine with kubectl access
# to the atlas-core cluster. It talks to the tester's /agent API over a local
# kubectl port-forward, so the tester can run in-cluster while you drive it here.
#
# Typical loop:
#   scripts/varify-agent.sh forward &          # port-forward svc/atlas-varify -> :8080
#   scripts/varify-agent.sh info               # orientation
#   scripts/varify-agent.sh run --service email --safety write-isolated --failures
#   ... edit atlas core code, redeploy that service ...
#   scripts/varify-agent.sh run --service email --safety write-isolated --failures
#
# Env:
#   VARIFY_URL           Base URL of the tester (default http://localhost:8080)
#   VARIFY_AGENT_TOKEN   Bearer token if the /agent API is guarded
#   VARIFY_NAMESPACE     Cluster namespace (default atlas-core)
#   VARIFY_ADMIN_EMAIL   Admin email for `connect` / `create-admin`
#   VARIFY_ADMIN_PASSWORD
#   IDENTITY_URL         Identity base URL for `create-admin` (default http://localhost:8001)
#
# Dependencies: bash, curl, jq, kubectl.
set -euo pipefail

VARIFY_URL="${VARIFY_URL:-http://localhost:8080}"
VARIFY_NAMESPACE="${VARIFY_NAMESPACE:-atlas-core}"
IDENTITY_URL="${IDENTITY_URL:-http://localhost:8001}"

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
need curl; need jq

# Auth header for /agent requests (empty when no token configured).
auth_header() {
  if [[ -n "${VARIFY_AGENT_TOKEN:-}" ]]; then
    printf 'Authorization: Bearer %s' "$VARIFY_AGENT_TOKEN"
  fi
}

# curl against the tester's /agent API. Usage: api METHOD PATH [json-body]
api() {
  local method="$1" path="$2" body="${3:-}"
  local -a args=(-sS -X "$method" "${VARIFY_URL}${path}")
  local h; h="$(auth_header)"; [[ -n "$h" ]] && args+=(-H "$h")
  if [[ -n "$body" ]]; then
    args+=(-H 'content-type: application/json' -d "$body")
  fi
  curl "${args[@]}"
}

cmd_forward() {
  need kubectl
  local port="${1:-8080}"
  echo "port-forward svc/atlas-varify ${port}:80 (ns=${VARIFY_NAMESPACE}) — Ctrl-C to stop" >&2
  exec kubectl -n "$VARIFY_NAMESPACE" port-forward svc/atlas-varify "${port}:80"
}

cmd_info()    { api GET /agent/info | jq .; }
cmd_current() { api GET /agent/run/current | jq .; }
cmd_runs()    { api GET /agent/runs | jq .; }
cmd_get()     { [[ $# -ge 1 ]] || die "usage: get <runId> [--failures]"
                local q=""; [[ "${2:-}" == "--failures" ]] && q="?failuresOnly=true"
                api GET "/agent/runs/$1$q" | jq .; }

cmd_catalog() {
  local q=""; [[ $# -ge 1 && -n "$1" ]] && q="?service=$1"
  api GET "/agent/catalog$q" | jq '{counts, suites: [.suites[] | {id, service, tests: (.testIds|length)}]}'
}

cmd_connect() {
  local body='{}'
  if [[ -n "${VARIFY_ADMIN_EMAIL:-}" && -n "${VARIFY_ADMIN_PASSWORD:-}" ]]; then
    body="$(jq -n --arg e "$VARIFY_ADMIN_EMAIL" --arg p "$VARIFY_ADMIN_PASSWORD" \
      '{adminEmail:$e, adminPassword:$p}')"
  fi
  api POST /agent/connect "$body" | jq .
}

# create-admin <email> <password> — register the first/admin user on Identity.
# The first user Identity ever registers auto-gets SUPERADMIN+ADMIN+USER.
cmd_create_admin() {
  need curl
  local email="${1:-${VARIFY_ADMIN_EMAIL:-}}" pw="${2:-${VARIFY_ADMIN_PASSWORD:-}}"
  [[ -n "$email" && -n "$pw" ]] || die "usage: create-admin <email> <password> (or set VARIFY_ADMIN_EMAIL/PASSWORD)"
  local first="${VARIFY_ADMIN_FIRST:-Verify}" last="${VARIFY_ADMIN_LAST:-Admin}"
  echo "registering ${email} on ${IDENTITY_URL} ..." >&2
  curl -sS -X POST "${IDENTITY_URL}/api/auth/register" \
    -H 'content-type: application/json' \
    -H 'Accept: application/vnd.atlasid.v1+json' \
    -d "$(jq -n --arg e "$email" --arg p "$pw" --arg f "$first" --arg l "$last" \
      '{email:$e, password:$p, firstName:$f, lastName:$l}')" | jq .
}

# run [--test id ...] [--suite id ...] [--service key ...] [--safety level ...]
#     [--all-safety] [--stop-on-failure] [--failures] [--no-wait] [--full]
cmd_run() {
  local -a tests=() suites=() services=() safety=()
  local stop=false failures=false wait=true full=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --test)     tests+=("$2"); shift 2;;
      --suite)    suites+=("$2"); shift 2;;
      --service)  services+=("$2"); shift 2;;
      --safety)   safety+=("$2"); shift 2;;
      --all-safety) safety=(write-isolated destructive system); shift;;
      --stop-on-failure) stop=true; shift;;
      --failures) failures=true; shift;;
      --no-wait)  wait=false; shift;;
      --full)     full=true; shift;;
      *) die "unknown run arg: $1";;
    esac
  done

  local body
  body="$(jq -n \
    --argjson tests   "$(printf '%s\n' "${tests[@]:-}"    | jq -R . | jq -s 'map(select(length>0))')" \
    --argjson suites  "$(printf '%s\n' "${suites[@]:-}"   | jq -R . | jq -s 'map(select(length>0))')" \
    --argjson services "$(printf '%s\n' "${services[@]:-}" | jq -R . | jq -s 'map(select(length>0))')" \
    --argjson safety  "$(printf '%s\n' "${safety[@]:-}"   | jq -R . | jq -s 'map(select(length>0))')" \
    --argjson stop "$stop" --argjson failures "$failures" \
    '{testIds:$tests, suiteIds:$suites, services:$services,
      enabledSafety:$safety, stopOnFailure:$stop, failuresOnly:$failures}')"

  local path="/agent/run"; [[ "$wait" == false ]] && path="/agent/run?wait=false"
  local out; out="$(api POST "$path" "$body")"

  if [[ "$wait" == false || "$full" == true ]]; then
    echo "$out" | jq .
    return
  fi
  # Compact summary + failing tests for fast diagnosis.
  echo "$out" | jq '{runId:.id, status, summary,
    failures: [ .results[] | select(.outcome=="fail" or .outcome=="error")
      | {testId, endpoint, service, outcome, status, expected, failures,
         response: (.response.body // null)} ]}'
}

usage() {
  cat >&2 <<'EOF'
varify-agent.sh <command> [args]

  forward [port]              kubectl port-forward svc/atlas-varify -> localhost:PORT (default 8080)
  info                        tester version, namespace, connection + catalog counts
  catalog [service]           suites/test counts (optionally one service)
  connect                     connect using VARIFY_ADMIN_EMAIL/PASSWORD (or env auto-connect)
  create-admin <email> <pw>   register the first/admin user on Identity (needs identity port-forward)
  run [selectors] [flags]     run tests and print summary+failures (waits by default)
  current                     current run status
  runs                        list recent runs
  get <runId> [--failures]    fetch a stored run

  run selectors: --test ID | --suite ID | --service KEY   (repeatable; none = all)
  run flags:     --safety LEVEL (repeatable) | --all-safety | --stop-on-failure
                 --failures (trim to fail/error) | --no-wait | --full (raw JSON)

Env: VARIFY_URL, VARIFY_AGENT_TOKEN, VARIFY_NAMESPACE, VARIFY_ADMIN_EMAIL, VARIFY_ADMIN_PASSWORD, IDENTITY_URL
EOF
  exit 1
}

[[ $# -ge 1 ]] || usage
cmd="$1"; shift || true
case "$cmd" in
  forward)       cmd_forward "$@";;
  info)          cmd_info;;
  catalog)       cmd_catalog "${1:-}";;
  connect)       cmd_connect;;
  create-admin)  cmd_create_admin "$@";;
  run)           cmd_run "$@";;
  current)       cmd_current;;
  runs)          cmd_runs;;
  get)           cmd_get "$@";;
  -h|--help|help) usage;;
  *) die "unknown command: $cmd (try --help)";;
esac
