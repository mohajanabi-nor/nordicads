"""Download + cache product images locally (so the PDF build is offline-stable)."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional

import requests

from .config import CONFIG
from .models import Product

_IMG_DIR = CONFIG.snapshot_db.parent / "images"


def cache_product_image(product: Product, session: Optional[requests.Session] = None) -> Optional[str]:
    """Download product.image_url into a local cache; set + return image_path."""
    if not product.image_url:
        return None
    _IMG_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(product.image_url.encode()).hexdigest()[:24]
    dest = _IMG_DIR / f"{key}.img"
    if not dest.exists() or dest.stat().st_size < 200:
        s = session or requests
        try:
            r = s.get(product.image_url, timeout=40)
            r.raise_for_status()
            dest.write_bytes(r.content)
        except Exception:  # noqa: BLE001
            return None
    product.image_path = str(dest)
    return product.image_path
