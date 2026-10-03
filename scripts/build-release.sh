#!/usr/bin/env bash
#
# Build the atlas-system-tester release tarball: builds the container image, exports it,
# assembles the package per the Atlas App Release Package Standard, and produces
# dist/atlas-system-tester-<version>.tar.zst (falls back to .tar.gz if zstd is absent).
#
# Usage: scripts/build-release.sh [version]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_KEY="atlas-system-tester"
VERSION="${1:-$(cat VERSION 2>/dev/null || echo 0.1.0)}"
REGISTRY="${REGISTRY:-registry.local/atlas}"
# Override with DOCKER='sudo docker' if your user is not in the docker group.
DOCKER="${DOCKER:-docker}"
API_IMAGE="${REGISTRY}/${APP_KEY}-api:${VERSION}"
OUTPUT_DIR="$ROOT/dist"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

info() { echo "INFO  [build-release] $*"; }

mkdir -p "$OUTPUT_DIR"

# ── 1. Build the container image ─────────────────────────────────────────────
info "Building image ${API_IMAGE}"
"$DOCKER" build -t "$API_IMAGE" -f Dockerfile .

# ── 2. Assemble the package tree ─────────────────────────────────────────────
info "Assembling package staging at ${STAGING}"
mkdir -p "$STAGING/images" "$STAGING/k8s" "$STAGING/meta" "$STAGING/scripts" "$STAGING/media"
cp -r release/k8s/.    "$STAGING/k8s/"
cp -r release/meta/.   "$STAGING/meta/"
cp -r release/media/.  "$STAGING/media/"
cp     release/scripts/init.sh "$STAGING/scripts/init.sh"
cp     release/README.md "$STAGING/README.md"
chmod +x "$STAGING/scripts/init.sh"

# ── 3. Export the image + write images/index.json ────────────────────────────
info "Exporting image to images/api.tar"
"$DOCKER" save "$API_IMAGE" -o "$STAGING/images/api.tar"
API_SHA="$(sha256sum "$STAGING/images/api.tar" | awk '{print $1}')"
cat > "$STAGING/images/index.json" <<EOF
{
  "format": "docker-archive",
  "images": [
    { "name": "${API_IMAGE}", "tag": "${VERSION}", "file": "api.tar", "sha256": "${API_SHA}" }
  ]
}
EOF

# ── 4. Stamp the version into metadata + chart ───────────────────────────────
BUILD_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
python3 - "$STAGING" "$VERSION" "$BUILD_TS" <<'PY'
import json, sys
staging, version, ts = sys.argv[1], sys.argv[2], sys.argv[3]
vm = f"{staging}/meta/version-manifest.json"
d = json.load(open(vm))
d["release_version"] = version
d["build_timestamp"] = ts
json.dump(d, open(vm, "w"), indent=2)
PY
sed -i "s/^version: .*/version: ${VERSION}/"          "$STAGING/k8s/chart/Chart.yaml"
sed -i "s/^appVersion: .*/appVersion: \"${VERSION}\"/" "$STAGING/k8s/chart/Chart.yaml"
sed -i "s|^    tag: .*|    tag: \"${VERSION}\"|"        "$STAGING/k8s/chart/values.yaml"

# ── 5. Package ───────────────────────────────────────────────────────────────
if command -v zstd >/dev/null 2>&1; then
  TARBALL="$OUTPUT_DIR/${APP_KEY}-${VERSION}.tar.zst"
  info "Compressing with zstd → ${TARBALL}"
  tar -cf - -C "$STAGING" . | zstd -T0 -19 -f -o "$TARBALL"
else
  TARBALL="$OUTPUT_DIR/${APP_KEY}-${VERSION}.tar.gz"
  info "zstd not found; using gzip → ${TARBALL}"
  tar -czf "$TARBALL" -C "$STAGING" .
fi

info "Done: $TARBALL"
echo "$TARBALL"
