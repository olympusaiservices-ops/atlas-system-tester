#!/usr/bin/env python3
"""Validate an Atlas app release tarball against the Commissioner's strict rules
(Release Package Standard §13). Usage: validate-package.py <tarball>"""
import json
import subprocess
import sys
import tarfile
import tempfile

REQUIRED_FILES = [
    "meta/version-manifest.json",
    "meta/install-manifest.json",
    "meta/app-metadata.json",
    "scripts/init.sh",
    "k8s/chart/Chart.yaml",
    "k8s/chart/values.yaml",
    "media/icon/icon.png",
    "media/description/short.txt",
    "media/description/long.md",
    "images/index.json",
]


def open_tar(path: str) -> tarfile.TarFile:
    """Open a tarball, transparently decompressing zstd (which Python's tarfile
    does not support natively) via the zstd CLI."""
    with open(path, "rb") as fh:
        magic = fh.read(4)
    if magic == b"\x28\xb5\x2f\xfd":  # zstd magic
        tmp = tempfile.NamedTemporaryFile(suffix=".tar", delete=False)
        cli = "unzstd" if subprocess.run(["which", "unzstd"], capture_output=True).returncode == 0 else "zstd"
        subprocess.run([cli, "-d", "-f", "-o", tmp.name, path], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return tarfile.open(tmp.name)
    return tarfile.open(path)


def main(path: str) -> int:
    errors: list[str] = []
    with open_tar(path) as tf:
        names = set(n.lstrip("./") for n in tf.getnames())

        def read(name: str):
            for cand in (name, "./" + name):
                try:
                    return tf.extractfile(cand).read()  # type: ignore[union-attr]
                except KeyError:
                    continue
            return None

        # Structural: required files present.
        for f in REQUIRED_FILES:
            if f not in names and ("./" + f) not in names:
                errors.append(f"missing required file: {f}")

        # At least one template under k8s/chart/templates/
        if not any("k8s/chart/templates/" in n and n.rstrip("/") != "k8s/chart/templates" for n in names):
            errors.append("no files under k8s/chart/templates/")

        # Content: version-manifest.
        vm_raw = read("meta/version-manifest.json")
        app_key = None
        if vm_raw is None:
            errors.append("version-manifest.json unreadable")
        else:
            try:
                vm = json.loads(vm_raw)
                app_key = vm.get("app_key")
                if not app_key:
                    errors.append("version-manifest.json missing app_key")
                if not vm.get("release_version"):
                    errors.append("version-manifest.json missing release_version")
            except json.JSONDecodeError as e:
                errors.append(f"version-manifest.json invalid JSON: {e}")

        # Content: app-metadata primary_service_name == app_key.
        am_raw = read("meta/app-metadata.json")
        if am_raw is None:
            errors.append("app-metadata.json unreadable")
        else:
            try:
                am = json.loads(am_raw)
                psn = am.get("service", {}).get("primary_service_name")
                if psn != app_key:
                    errors.append(
                        f"app-metadata service.primary_service_name ({psn!r}) != app_key ({app_key!r})"
                    )
            except json.JSONDecodeError as e:
                errors.append(f"app-metadata.json invalid JSON: {e}")

        # Content: images/index.json.
        idx_raw = read("images/index.json")
        if idx_raw is None:
            errors.append("images/index.json unreadable")
        else:
            try:
                idx = json.loads(idx_raw)
                imgs = idx.get("images")
                if not isinstance(imgs, list):
                    errors.append("images/index.json has no 'images' array")
                else:
                    for i, entry in enumerate(imgs):
                        f = entry.get("file")
                        if not f:
                            errors.append(f"images entry {i} missing 'file'")
                        elif f"images/{f}" not in names and f"./images/{f}" not in names:
                            errors.append(f"image file referenced but absent: images/{f}")
            except json.JSONDecodeError as e:
                errors.append(f"images/index.json invalid JSON: {e}")

    if errors:
        print(f"❌ {path}: {len(errors)} validation error(s):")
        for e in errors:
            print(f"   - {e}")
        return 1
    print(f"✅ {path}: passes all Commissioner structural + content checks (app_key={app_key}).")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: validate-package.py <tarball>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
