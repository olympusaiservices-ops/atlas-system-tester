# Atlas Verify — release package

This tarball deploys **Atlas Verify**, an in-cluster diagnostic app that
exercises every app-facing Atlas Core API endpoint (Identity, Email, App Store,
Network, Portal API) and reports results in a web UI.

## Install (sideload)

```
curl -X POST https://<app-store-host>/api/v1/apps/sideload \
  -H "Authorization: Bearer $TOKEN" \
  -F "tarball=@atlas-verify-<version>.tar.zst"
```

`$TOKEN` must carry the `appstore:install` scope.

## Contents

- `images/` — the `atlas-verify-api` container image (`docker save` archive)
- `k8s/chart/` — Helm chart (single Deployment + Service + PVC)
- `meta/` — version, install and app metadata
- `scripts/init.sh` — loads the bundled image into the node runtime
- `media/` — icon and descriptions

## Runtime

- Exposes a primary Service named `atlas-verify` on port 80 → container 8080.
- Serves the UI and its API from one container; persists saved test plans and
  run history to a 1Gi PVC mounted at `/data/atlas-verify`.
- Reaches Atlas Core services via in-cluster DNS derived from the release
  namespace. No database required.

## No ordering requirements

`install_order: 0`, `depends_on: null` — Atlas Verify is an ordinary app that
talks to the core services at runtime; it has no install-time dependency wiring.
