"""Animation primitives for reels — eased compositing, gloss sweep, pop-scale.

All math lifted verbatim from the prototype reels so motion matches 1:1.
"""
from __future__ import annotations

import numpy as np
from PIL import Image


def ease(t: float) -> float:
    """Cubic ease-out, clamped to [0,1]."""
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def popscale(t: float) -> float:
    """Back-ease 'pop' scale factor (overshoots then settles)."""
    t = max(0.0, min(1.0, t))
    c1 = 1.70158
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def out_back(t: float, overshoot: float = 1.70158) -> float:
    """Back-ease-out: rises past 1.0, then settles to exactly 1.0 at t=1.

    Like popscale but with a tunable overshoot so products can enter with a
    subtle, premium 'spring' instead of a flat slide. A small overshoot
    (~1.1–1.4) reads as life; large values look bouncy/cheap, so keep it gentle
    for grocery hero shots."""
    t = max(0.0, min(1.0, t))
    c1 = overshoot
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def spring_pop(t: float, lo: float = 0.90, overshoot: float = 1.25) -> float:
    """Scale factor for an entering product: grows from ``lo`` to 1.0 with a
    gentle overshoot. Returns 1.0 once settled (t>=1)."""
    return lo + (1.0 - lo) * out_back(t, overshoot)


def paste_a(base: Image.Image, layer: Image.Image, xy, a: float) -> None:
    """Alpha-composite `layer` onto `base` at `xy`, scaled by opacity `a`."""
    if a <= 0:
        return
    if a >= 1:
        base.alpha_composite(layer, xy)
        return
    l = layer.copy()
    al = l.split()[3].point(lambda v: int(v * a))
    l.putalpha(al)
    base.alpha_composite(l, xy)


def shine(prod: Image.Image, p: float) -> Image.Image:
    """Diagonal gloss band sweeping across `prod` at progress p in [0,1]."""
    arr = np.asarray(prod).astype(float)
    h, w = arr.shape[:2]
    xx, yy = np.meshgrid(np.arange(w), np.arange(h))
    diag = xx * 0.94 + yy * 0.34
    span = w * 0.94 + h * 0.34
    center = (-0.25 + 1.5 * p) * span
    sigma = 0.09 * span
    band = np.exp(-((diag - center) ** 2) / (2 * sigma ** 2))
    a = arr[:, :, 3:4] / 255.0
    rgb = arr[:, :, :3] + (255 - arr[:, :, :3]) * (band[..., None] * 0.6 * a)
    return Image.fromarray(
        np.dstack([np.clip(rgb, 0, 255), arr[:, :, 3]]).astype("uint8"), "RGBA"
    )
