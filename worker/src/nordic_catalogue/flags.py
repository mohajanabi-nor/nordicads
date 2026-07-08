"""Flag rendering from the bundled real ISO flag set (worker/assets/flags/*.png).

Unknown / missing code -> neutral code chip (BUILD-SPEC §5 fallback).
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

from .config import CONFIG

BORDER = (90, 92, 104)
CHIP_BG = (58, 60, 74)
CREAM = (247, 240, 222)


@lru_cache(maxsize=256)
def _load(code: str) -> Optional[Image.Image]:
    path: Path = CONFIG.flags_dir / f"{code.upper()}.png"
    if not path.exists():
        return None
    try:
        return Image.open(path).convert("RGB")
    except Exception:  # noqa: BLE001
        return None


def _font(weight: int, size: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(CONFIG.font_path), size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:  # noqa: BLE001
        pass
    return f


def _cover_resize(img: Image.Image, w: int, h: int) -> Image.Image:
    """Resize to fill (w,h) preserving aspect, then center-crop."""
    sw, sh = img.size
    scale = max(w / sw, h / sh)
    rw, rh = max(1, round(sw * scale)), max(1, round(sh * scale))
    img = img.resize((rw, rh), Image.LANCZOS)
    left, top = (rw - w) // 2, (rh - h) // 2
    return img.crop((left, top, left + w, top + h))


def code_chip(label: str, w: int = 52, h: int = 35) -> Image.Image:
    """Neutral fallback brick showing the code or '+N'."""
    f = Image.new("RGB", (w, h), CHIP_BG)
    fd = ImageDraw.Draw(f)
    cf = _font(800, 15)
    txt = label[:3] if label.startswith("+") else label[:2].upper()
    fd.text((w / 2 - fd.textlength(txt, font=cf) / 2, h / 2 - 9), txt, font=cf, fill=CREAM)
    fd.rectangle([0, 0, w - 1, h - 1], outline=BORDER)
    return f


def flag(code: str, w: int = 52, h: int = 35) -> Image.Image:
    """Real flag for an ISO-2 code, else a code chip."""
    if code and code.startswith("+"):
        return code_chip(code, w, h)
    img = _load(code) if code else None
    if img is None:
        return code_chip(code or "??", w, h)
    out = _cover_resize(img, w, h)
    ImageDraw.Draw(out).rectangle([0, 0, w - 1, h - 1], outline=BORDER)
    return out
