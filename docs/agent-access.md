# Headless / Agent Access

This guide is for driving **Atlas Verify** without the browser UI — specifically
so a **Claude instance running on this host** can exercise the live Atlas Core
API, read structured pass/fail results, and iterate on Atlas core code in real
time.

> **The loop this enables**
>
> 1. `run` a suite of endpoint tests against the live cluster.
> 2. Read the **failures** (each carries the request sent and the response body).
> 3. Edit the offending **Atlas core** service's code and redeploy it.
> 4. `run` the same suite again and confirm it now passes.
>
> Atlas Verify is the feedback instrument in that loop; it does not change Atlas
> core itself.

---

## 1. Topology

`atlas-verify` runs as a pod in the `atlas-core` namespace and reaches the core
services over in-cluster DNS. A host-side agent reaches the **tester** over a
`kubectl port-forward`:

```
Claude (this host) ──curl──▶ localhost:8080 ──port-forward──▶ svc/atlas-verify (in-cluster)
                                                                   │
                                        in-cluster DNS ────────────┴───▶ atlas-core-identity / email / app-store / network / portal-api
```

The `/agent/*` API is separate from the browser `/vapi/*` API and the health
probes. It is designed for one-shot curl calls: connect from env, **run and wait
for the full JSON result**, and filter to failures.

---

## 2. Quick start

```bash
# 0. (once) the tester needs an Atlas admin login. The FIRST user ever
#    registered on Identity auto-gets SUPERADMIN. Port-forward Identity and
#    register one (skip if you already have admin creds):
kubectl -n atlas-core port-forward svc/atlas-core-identity 8001:80 &
scripts/verify-agent.sh create-admin verify-admin@verify.test 'S0me-Str0ng-Pw!'

# 1. Port-forward the tester itself.
scripts/verify-agent.sh forward &          # svc/atlas-verify -> localhost:8080

# 2. Point the helper at your admin creds and connect.
export VERIFY_ADMIN_EMAIL=verify-admin@verify.test
export VERIFY_ADMIN_PASSWORD='S0me-Str0ng-Pw!'
export VERIFY_AGENT_TOKEN=...              # only if the deploy set agent.token
scripts/verify-agent.sh connect

# 3. Run tests and see failures.
scripts/verify-agent.sh info
scripts/verify-agent.sh run --service email --safety write-isolated --failures
```

If the deployment was given `agent.adminEmail/adminPassword` (Helm values), the
pod **auto-connects at startup** and step 2 is unnecessary — `run` will connect
lazily on its own.

---

## 3. The `/agent` API

Base URL over the port-forward: `http://localhost:8080`. When the deployment
sets an agent token, send it as `Authorization: Bearer <token>` (or
`X-Verify-Token: <token>`); otherwise no auth is required.

| Method & path | Purpose |
|---|---|
| `GET  /agent/info` | Version, namespace, resolved service URLs, connection state, catalog counts, active run. |
| `GET  /agent/catalog[?service=email]` | Compact catalog: suites (with their test ids) + flat test list. |
| `POST /agent/connect` | Connect. Body optional — falls back to env admin creds. |
| `POST /agent/run[?wait=true]` | Run a selection and (by default) **wait** for the finished record. |
| `GET  /agent/run/current` | Lightweight status of the active/last run. |
| `POST /agent/run/abort` | Abort the active run. |
| `GET  /agent/runs` | Recent run index. |
| `GET  /agent/runs/:id[?failuresOnly=true\|view=summary]` | A stored run. |

Health probes remain unauthenticated and unchanged: `GET /health/live`,
`GET /health/ready`.

### `POST /agent/run` body

```jsonc
{
  "testIds":  ["email.mailboxes.create"],  // exact test ids
  "suiteIds": ["email.mailboxes"],          // whole suites
  "services": ["email"],                    // whole services
  // (provide any combination; omit all three to run everything)
  "enabledSafety": ["write-isolated"],      // "read" is always on; add write-isolated/destructive/system
  "stopOnFailure": false,
  "failuresOnly":  true                     // trim the response to fail/error results
}
```

Safety levels (a test runs only if its level is enabled):

- `read` — always on; GET / health / non-mutating.
- `write-isolated` — creates a throwaway resource and cleans it up.
- `destructive` — deletes/disables real resources. **Opt-in.**
- `system` — changes global state (primary domain, VPN, wizard reset, uninstall…). **Opt-in.**

### Example: run one suite, get only failures

```bash
curl -sS -X POST 'http://localhost:8080/agent/run' \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $VERIFY_AGENT_TOKEN" \
  -d '{"suiteIds":["email.mailboxes"],"enabledSafety":["write-isolated"],"failuresOnly":true}' \
| jq '{status, summary, failures: [.results[] | {testId, status, expected, failures, body: .response.body}]}'
```

A failure result includes `request` (method/url/body) and `response`
(status/headers/body) — enough to diagnose the core service without re-running.

---

## 4. Helper CLI

`scripts/verify-agent.sh` wraps the calls above. See `--help` for the full list.

```bash
scripts/verify-agent.sh forward [port]        # kubectl port-forward -> localhost:PORT (default 8080)
scripts/verify-agent.sh info
scripts/verify-agent.sh catalog [service]
scripts/verify-agent.sh connect
scripts/verify-agent.sh create-admin <email> <pw>
scripts/verify-agent.sh run --service email --safety write-isolated --failures
scripts/verify-agent.sh run --suite identity.users --test identity.me.get
scripts/verify-agent.sh runs
scripts/verify-agent.sh get <runId> --failures
```

`run` waits for completion and prints `{runId, status, summary, failures[]}` by
default; add `--full` for the raw record or `--no-wait` to return a `runId`
immediately.

---

## 5. Configuration (env)

| Variable | Purpose |
|---|---|
| `VERIFY_AGENT_TOKEN` | If set, guards every `/agent/*` request. Unset = open (port-forward only). |
| `VERIFY_ADMIN_EMAIL`, `VERIFY_ADMIN_PASSWORD` | Admin login for headless auto-connect. |
| `VERIFY_AUTO_CONNECT` | `true` to force startup auto-connect (implied when both creds are set). |

In-cluster these come from the Helm `agent:` values, which render a Secret
(`<app>-agent`) consumed by the Deployment:

```yaml
# values override at install/upgrade time
agent:
  token: "s3cr3t-agent-token"
  adminEmail: "verify-admin@verify.test"
  adminPassword: "S0me-Str0ng-Pw!"
  autoConnect: true
```

The helper's `run` also honors `VERIFY_URL` (default `http://localhost:8080`) and
`VERIFY_NAMESPACE` (default `atlas-core`).

---

## 6. Logs

The server emits one structured (pino JSON) stream to stdout, so
`kubectl -n atlas-core logs deploy/atlas-verify -f` shows requests **and** run
progress together. Run lifecycle lines:

| `msg` | Fields |
|---|---|
| `run.start` | `runId, total, selection, enabledSafety` |
| `run.result` | `runId, testId, service, outcome, status, durationMs, failures?` — `warn` for fail/error, `debug` for pass |
| `run.done` | `runId, status, summary` |

Set `LOG_LEVEL=debug` to see every passing test's `run.result` line.

---

## 7. Deploying the tester

Build and sideload the release, supplying the agent values so the pod is
turnkey for headless use:

```bash
scripts/build-release.sh
curl -X POST https://<app-store-host>/api/v1/apps/sideload \
  -H "Authorization: Bearer $TOKEN" \
  -F "tarball=@dist/atlas-verify-$(cat VERSION).tar.zst" \
  -F 'values_overrides={"agent":{"token":"s3cr3t","adminEmail":"verify-admin@verify.test","adminPassword":"S0me-Str0ng-Pw!","autoConnect":true}}'
```

Or `helm upgrade --install` the chart under `release/k8s/chart` with the same
`--set agent.*` values. No Ingress is created; reach the tester via
`kubectl port-forward` (Section 2).
