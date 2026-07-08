"""Download and bundle the U2-Net ONNX model into worker/models/u2net.onnx.

Run once at setup so runtime never downloads (BUILD-SPEC §3 "bundle the model").
The file is gitignored (large); re-add via Git LFS before deploy if desired.

    python scripts/fetch_model.py
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from nordic_catalogue.config import CONFIG  # noqa: E402

# Canonical U2-Net general model published by the rembg project (release asset).
URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx"
# Known sha256 of u2net.onnx (general model).
SHA256 = "8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491"


def main() -> int:
    dest = CONFIG.model_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1_000_000:
        print(f"model already present: {dest} ({dest.stat().st_size/1e6:.0f} MB)")
        return 0
    print(f"downloading u2net.onnx -> {dest} ...")
    with requests.get(URL, stream=True, timeout=120) as r:
        r.raise_for_status()
        h = hashlib.sha256()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
                h.update(chunk)
    digest = h.hexdigest()
    print(f"downloaded {dest.stat().st_size/1e6:.0f} MB, sha256={digest}")
    if SHA256 and digest != SHA256:
        print(f"WARNING: sha256 mismatch (expected {SHA256})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
