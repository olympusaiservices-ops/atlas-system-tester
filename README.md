# Atlas Verify

An Atlas app that **exercises every app-facing Atlas Core API endpoint** and
reports the result of each call in a live web UI. Deploys to an Atlas RKE2
cluster as a normal sideloadable app.

It covers 200+ endpoint tests across all five core services:

| Service     | K8s service            | Tests |
|-------------|------------------------|-------|
| Identity    | `atlas-core-identity`  | 96    |
| Email       | `atlas-core-email`     | 39    |
| App Store   | `atlas-core-app-store` | 30    |
| Network     | `atlas-core-network`   | 38    |
| Portal API  | `atlas-core-portal-api`| 26    |

## Features

- **Browse & queue tests** — a catalog tree grouped by service and suite; pick
  any combination and run it.
- **Live results** — per-test status, latency, request and response, streamed
  over SSE as the run progresses; filter by pass/fail/error/skip.
- **Safety scoping** — `read` and isolated `write` tests run by default;
  `destructive` and `system` tests are opt-in per run. Write tests create
  throwaway resources and clean them up; they never touch pre-existing data.
- **Auto-provisioning auth** — sign in with an admin account; Atlas Verify logs
  in for a user token, self-registers an app, and mints a scoped M2M token to
  reach the email/app-store/network APIs.
- **Saveable plans** — store any selection + options as a named test plan (JSON
  on the data volume, also downloadable/importable) to replay later.
- **Run history** — every run is persisted and reviewable.

## Architecture

- **`server/`** — TypeScript (Fastify). Hosts the test engine, the Atlas client
  + auth manager, the `/vapi/*` API, file-backed plan/run storage, and serves
  the built SPA. Exposes unauthenticated `/health/live` and `/health/ready`.
- **`web/`** — React + Vite SPA, built to static files served by the server.
- One container, one image; a PVC at `/data/atlas-varify` holds plans + history.

## Develop locally

```bash
npm install
# point at the live cluster via port-forwards (separate terminals):
#   kubectl -n atlas-core port-forward svc/atlas-core-identity   8001:80
#   kubectl -n atlas-core port-forward svc/atlas-core-email      8002:80
#   kubectl -n atlas-core port-forward svc/atlas-core-app-store  8003:80
#   kubectl -n atlas-core port-forward svc/atlas-core-network    8004:80
#   kubectl -n atlas-core port-forward svc/atlas-core-portal-api 8005:80
ATLAS_IDENTITY_URL=http://localhost:8001 \
ATLAS_EMAIL_URL=http://localhost:8002 \
ATLAS_APPSTORE_URL=http://localhost:8003 \
ATLAS_NETWORK_URL=http://localhost:8004 \
ATLAS_PORTAL_API_URL=http://localhost:8005 \
VARIFY_DATA_DIR=./data \
npm run dev          # web on :5173 (proxies /vapi + /health to the server on :8080)
```

In-cluster, the Helm chart injects `ATLAS_NAMESPACE` and the per-service URLs;
no configuration is needed.

## Build & deploy

```bash
# Produces dist/atlas-varify-<version>.tar.zst
scripts/build-release.sh

# Sideload into the App Store
curl -X POST https://<app-store-host>/api/v1/apps/sideload \
  -H "Authorization: Bearer $TOKEN" \
  -F "tarball=@dist/atlas-varify-$(cat VERSION).tar.zst"
```

## Headless / agent access

Besides the browser UI, the server exposes an **`/agent` API** so a Claude
instance (or any script) on a machine with cluster access can drive the tester
without a browser: connect from env, **run tests and wait for the full JSON
result**, and filter to failures — each failure carries the request sent and the
response received. This closes a real-time loop: run tests → read failures →
edit the Atlas **core** service → redeploy → re-run.

Reach the in-cluster tester over a `kubectl port-forward`; the helper CLI wraps
the calls:

```bash
scripts/varify-agent.sh forward &                                   # svc/atlas-varify -> localhost:8080
scripts/varify-agent.sh info
scripts/varify-agent.sh run --service email --safety write-isolated --failures
```

Full guide — API reference, safety levels, auth token, logs, deploy values:
**[`docs/agent-access.md`](docs/agent-access.md)**. Repo-root
[`CLAUDE.md`](CLAUDE.md) gives a host Claude the loop at a glance.

## Configuration (env)

| Variable | Default | Purpose |
|----------|---------|---------|
| `ATLAS_NAMESPACE` | `atlas-core` | Namespace used to derive service DNS |
| `ATLAS_IDENTITY_URL` … `ATLAS_PORTAL_API_URL` | in-cluster DNS | Per-service base URL overrides |
| `PORT` | `8080` | HTTP port |
| `VARIFY_DATA_DIR` | `/data/atlas-varify` | Plans + run history location |
| `VARIFY_APP_KEY` | `atlas-varify` | App name used for self-registration |
| `VARIFY_AGENT_TOKEN` | _(unset)_ | If set, guards every `/agent/*` request (bearer token) |
| `VARIFY_ADMIN_EMAIL` / `VARIFY_ADMIN_PASSWORD` | _(unset)_ | Admin login for headless auto-connect |
| `VARIFY_AUTO_CONNECT` | `false` | Connect at startup (implied when both admin creds are set) |
