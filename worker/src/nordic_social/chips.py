"""Origin chip: rounded white pill with a real ISO flag + label.

Replaces the prototypes' hardcoded flag_de()/flag_pl() with the bundled ISO
flag set. Per brand rule: if the origin can't be mapped to a flag (iso None),
show the label with NO flag — never guess a flag.
"""
from __future__ import annotations

from typing import Optional

from PIL import Image, ImageDraw

from nordic_catalogue.flags import flag as iso_flag

from .constants import AMBER_DEEP, INK
from .render import font


def _rounded(img: Image.Image, radius: int = 5) -> Image.Image:
    m = Image.new("L", img.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, img.width, img.height], radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(m)
    return out


def chip_layer(text: str, iso: Optional[str]) -> Image.Image:
    """Pill chip: [flag] TEXT. Omits the flag when iso is None (never guess)."""
    fh = 40
    flag_img = None
    if iso:
        fw = int(fh * 1.5)  # 60x40
        flag_img = _rounded(iso_flag(iso, fw, fh), radius=5)

    tf = font(800, 30)
    pad = 24
    gap = 14
    tw = ImageDraw.Draw(Image.new("RGB", (4, 4))).textlength(text, font=tf)
    flag_w = (flag_img.width + gap) if flag_img is not None else 0
    w = int(pad + flag_w + tw + pad)
    h = fh + 28

    L = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=h // 2,
                        fill=(255, 255, 255, 255), outline=AMBER_DEEP + (255,), width=3)
    tx = pad
    if flag_img is not None:
        L.alpha_composite(flag_img, (pad, (h - fh) // 2))
        tx = pad + flag_img.width + gap
    d.text((tx, (h - 30) // 2 - 1), text, font=tf, fill=INK)
    return L
