#!/usr/bin/env bash
set -euo pipefail

info() { echo "INFO  [init.sh] $*"; }
err()  { echo "ERROR [init.sh] $*" >&2; }

info "Starting init for ${APP_KEY:-atlas-verify} v${RELEASE_VERSION:-?} in namespace ${ORG_NAMESPACE:-?}"

# --- Load container images into the node runtime (ctr/crictl) ---
IMAGES_DIR="${APP_PACKAGE_ROOT}/images"
if [[ -d "$IMAGES_DIR" ]] && [[ -f "$IMAGES_DIR/index.json" ]]; then
  info "Loading container images from ${IMAGES_DIR}"
  python3 -c "
import json
with open('${IMAGES_DIR}/index.json') as f:
    data = json.load(f)
for img in data.get('images', []):
    print(img['file'])
" | while read -r img_file; do
    img_path="${IMAGES_DIR}/${img_file}"
    if [[ -f "$img_path" ]]; then
      info "Loading image: ${img_file}"
      if command -v ctr >/dev/null 2>&1; then
        ctr -n k8s.io images import "$img_path"
      elif command -v crictl >/dev/null 2>&1; then
        crictl load -i "$img_path"
      else
        info "No container runtime CLI found; skipping ${img_file}"
      fi
    else
      err "Image file not found: ${img_path}"
      exit 1
    fi
  done
  info "All container images loaded"
else
  info "No images directory found; skipping image load"
fi

info "Init complete for ${APP_KEY:-atlas-verify} v${RELEASE_VERSION:-?}"
