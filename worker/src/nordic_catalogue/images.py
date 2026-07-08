"""Product image pipeline (BUILD-SPEC §3, §9.8).

Cutout MUST be ML-based: U2-Net segments the object regardless of colour, so it
survives white packages on white backgrounds (Raffaello et al.). An edge-aware
fallback handles the case where the ML model is unavailable or returns a
degenerate mask. After cutout: trim to content + subtle sheen. The ground shadow
and scaling happen per-card in catalogue.py (matching the prototype).
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional, Union

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

from .config import CONFIG

_SESSION = None
_SESSION_TRIED = False

# U2-Net normalisation (matches the rembg general model).
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
_NET = 320


def _get_session():
    global _SESSION, _SESSION_TRIED
    if _SESSION_TRIED:
        return _SESSION
    _SESSION_TRIED = True
    try:
        import onnxruntime as ort  # noqa: PLC0415

        if not CONFIG.model_path.exists():
            return None
        so = ort.SessionOptions()
        so.log_severity_level = 3
        _SESSION = ort.InferenceSession(
            str(CONFIG.model_path),
            sess_options=so,
            providers=["CPUExecutionProvider"],
        )
    except Exception:  # noqa: BLE001
        _SESSION = None
    return _SESSION


def ml_available() -> bool:
    return _get_session() is not None


# ---------------------------------------------------------------- ML cutout ----
def _ml_alpha(rgb: Image.Image) -> Optional[np.ndarray]:
    sess = _get_session()
    if sess is None:
        return None
    w, h = rgb.size
    small = rgb.resize((_NET, _NET), Image.LANCZOS)
    arr = np.asarray(small, dtype=np.float32) / 255.0
    arr = (arr - _MEAN) / _STD
    arr = arr.transpose(2, 0, 1)[None, ...].astype(np.float32)  # NCHW
    try:
        out = sess.run(None, {sess.get_inputs()[0].name: arr})[0]
    except Exception:  # noqa: BLE001
        return None
    d = out[0, 0]
    dmin, dmax = float(d.min()), float(d.max())
    if dmax - dmin < 1e-6:
        return None
    d = (d - dmin) / (dmax - dmin)
    mask = Image.fromarray((d * 255).astype("uint8")).resize((w, h), Image.LANCZOS)
    return np.asarray(mask)


def _mask_is_good(alpha: np.ndarray) -> bool:
    cov = float((alpha > 128).mean())
    return 0.02 < cov < 0.985


# ----------------------------------------------------------- edge fallback ----
def _edge_alpha(rgb: Image.Image) -> np.ndarray:
    """Edge-aware background removal for white-on-white packages.

    Background = near-white AND low-gradient region connected to the border.
    The product edge carries gradient, so the flood stops at it (unlike a plain
    whiteness flood-fill, which leaks into white products).
    """
    a = np.asarray(rgb).astype(np.float32)
    gray = a.mean(axis=2)
    gx = ndimage.sobel(gray, axis=1)
    gy = ndimage.sobel(gray, axis=0)
    mag = np.hypot(gx, gy)

    nearwhite = (a > 236).all(axis=2)
    lowgrad = mag < 12.0
    bg_candidate = nearwhite & lowgrad

    lbl, _ = ndimage.label(bg_candidate)
    border = set(lbl[0, :]) | set(lbl[-1, :]) | set(lbl[:, 0]) | set(lbl[:, -1])
    border.discard(0)
    background = np.isin(lbl, list(border))

    fg = ~background
    fg = ndimage.binary_fill_holes(fg)
    fg = ndimage.binary_closing(fg, iterations=2)
    # keep largest component (drop stray speckles)
    lbl2, n = ndimage.label(fg)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(lbl2), lbl2, index=range(1, n + 1))
        keep = int(np.argmax(sizes)) + 1
        fg = lbl2 == keep
    alpha = np.where(fg, 255, 0).astype("uint8")
    return alpha


# --------------------------------------------------------------- public API ----
def cutout_alpha(rgb: Image.Image) -> tuple[np.ndarray, str]:
    """Return (alpha uint8 HxW, method) using ML first, edge fallback otherwise."""
    alpha = _ml_alpha(rgb)
    if alpha is not None and _mask_is_good(alpha):
        return alpha, "ml"
    return _edge_alpha(rgb), "edge"


def process_product(source: Union[str, Path, Image.Image]) -> Image.Image:
    """Cutout -> trim to content -> subtle top sheen. Returns RGBA.

    Caches results on disk by source-content hash for fast re-runs.
    """
    if isinstance(source, (str, Path)):
        cache_key = _file_hash(Path(source))
        cache_path = CONFIG.snapshot_db.parent / "cutouts" / f"{cache_key}.png"
        if cache_path.exists():
            return Image.open(cache_path).convert("RGBA")
        rgb = Image.open(source).convert("RGB")
    else:
        rgb = source.convert("RGB")
        cache_path = None

    alpha, _method = cutout_alpha(rgb)
    am = Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.6))
    out = rgb.convert("RGBA")
    out.putalpha(am)
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)
    out = _add_sheen(out)

    if cache_path is not None:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        out.save(cache_path)
    return out


def _add_sheen(out: Image.Image) -> Image.Image:
    """Subtle bright sheen in the upper half, masked to the product (§3.2)."""
    w, h = out.size
    pa = out.split()[3]
    col = Image.new("L", (1, h), 0)
    for y in range(h):
        col.putpixel((0, y), int(64 * max(0, 1 - y / (h * 0.5))))
    grad = col.resize((w, h))
    sheen = Image.new("RGBA", out.size, (255, 255, 255, 255))
    sheen.putalpha(Image.composite(grad, Image.new("L", out.size, 0), pa))
    return Image.alpha_composite(out, sheen)


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    h.update(str(path).encode())
    try:
        h.update(str(path.stat().st_mtime_ns).encode())
    except OSError:
        pass
    return h.hexdigest()[:20]
