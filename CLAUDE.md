# atlas-varify — notes for Claude

**What this is.** An Atlas app that exercises every app-facing Atlas Core API
endpoint (209 tests across identity / email / app-store / network / portal-api)
and reports each call's result. It is a *test instrument*, not part of Atlas
core — it drives the core services but never modifies them.

**Why you're here.** You (a Claude instance on this host) drive the tester
headlessly to validate the live `atlas-core` cluster, then fix Atlas **core**
code. The loop:

1. `run` a suite → 2. read **failures** (each has the request + response) →
3. edit the core service and redeploy it → 4. `run` again to confirm green.

## Driving it

The tester runs in-cluster; reach it over a `kubectl port-forward` and use the
`/agent` API. The helper wraps everything:

```bash
scripts/varify-agent.sh forward &                                   # localhost:8080 -> svc/atlas-varify
scripts/varify-agent.sh info                                        # orientation + connection state
scripts/varify-agent.sh run --service email --safety write-isolated --failures
scripts/varify-agent.sh get <runId> --failures
```

If the pod wasn't given admin creds, connect first (needs an Atlas admin login —
the first user registered on Identity auto-gets SUPERADMIN; see
`create-admin`). Full reference, API, safety levels, env vars, and log format:
**`docs/agent-access.md`**.

## Guardrails

- Default runs are `read` + `write-isolated` (throwaway resources that clean up).
  `destructive` and `system` are **opt-in** per run (`--all-safety` or explicit
  `--safety`); don't enable them unless you mean to mutate real/global state.
- A failing test points at a bug in the **core service under test**, not in
  atlas-varify. Fix the core service; only touch this repo's catalog if a test
  itself encodes a wrong expectation.

## Building this repo

`npm run build` (web + server). Local dev against port-forwarded services and
release packaging are documented in `README.md`.
