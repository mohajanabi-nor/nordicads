"""Shared render helpers for the social system.

Reuses `nordic_catalogue` font/tracked/logo_mark (config-driven paths) and the
U2-Net ONNX cutout pipeline, so branding and cutouts match the catalogue.
"""
from __future__ import annotations

from typing import Optional, Union
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Reuse verified catalogue helpers (config-driven asset paths).
from nordic_catalogue.catalogue import font, tracked, logo_mark  # noqa: F401
from nordic_catalogue.images import cutout_alpha

from nordic_catalogue.images import cutout_alpha as _cutout_alpha

from .constants import (
    W, H, AMBER_DEEP, FRAME_MARGIN, FRAME_STROKE, FRAME_RADII,
    SHADOW_RGBA, SHADOW_BLUR, SHADOW_W_COEF, SHADOW_H_COEF,
)


_HEADING_SCRATCH = ImageDraw.Draw(Image.new("RGB", (8, 8)))

# ----- shared product-sizing rules (catalogue / story / reels all obey) -----
# A product must never bleed past the amber frame, and a single hero must not
# fill the whole canvas (the "Baklava Yufkasi" full-bleed problem).
MAX_PROD_W = int(0.62 * W)                 # ~669 px — at most 62% of the frame
MAX_PROD_H = int(0.42 * H)                 # ~806 px — clear of heading + CTA
INNER_W = W - 2 * FRAME_MARGIN             # usable width between the frame lines
# A matte that keeps ~the whole frame means the cutout failed (lifestyle photo).
CUTOUT_FAIL_COVERAGE = 0.90
# Cluster overlap cap shared with the catalogue/story guardrail. Kept tight so a
# product can never hide the one behind it — at most ~13% of the narrower bag is
# covered, so every logo + flavour stays visible (the "Lay's over the green bag"
# problem). If the cluster won't fit at this overlap, shrink it (fit_cluster_width)
# or show fewer products — never widen the overlap to make room.
MAX_OVERLAP = 0.13
# Below this width a bag's logo/flavour is no longer readable; the reel drops a
# product from the beat rather than show it this small (see reel._placed_specs).
MIN_LEGIBLE_W = int(0.20 * W)              # ~216 px
# When a no-overlap cluster ends up NARROWER than the frame (e.g. three slim
# chocolate bars), don't leave it bunched shoulder-to-shoulder in the middle —
# breathe the products out toward this comfortable span, with even gaps, so they
# read as a row across the frame. Capped so two products never drift unnaturally
# far apart, and wide clusters (already >= this) are left for fit_cluster_width.
COMFY_SPREAD_W = int(0.82 * W)             # ~885 px target span when there's room
MAX_GAP = int(0.075 * W)                   # ~81 px cap per gap between neighbours


def _tracked_width(text: str, weight: int, size: int, tracking: float) -> float:
    """Width of a letter-tracked string at the given weight/size."""
    if not text:
        return 0.0
    f = font(weight, size)
    return (sum(_HEADING_SCRATCH.textlength(ch, font=f) for ch in text)
            + tracking * (len(text) - 1))


def _wrap_tracked(text: str, weight: int, size: int, tracking: float, max_w: int) -> list[str]:
    """Greedy word-wrap a tracked heading at the given size."""
    lines, cur = [], ""
    for word in text.split():
        cand = (cur + " " + word).strip()
        if not cur or _tracked_width(cand, weight, size, tracking) <= max_w:
            cur = cand
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def fit_heading(text: str, weight: int, max_w: int, start: int, min_size: int,
                tracking: float = 1, max_lines: int = 2, step: int = 2):
    """Fit a (letter-tracked) heading inside ``max_w`` — never clip.

    Shrinks to a single line first; if it still won't fit at ``min_size``, wraps
    to at most ``max_lines`` lines and keeps shrinking. Returns (lines, size).
    """
    size = start
    while size > min_size:                      # pass 1: one line, shrink
        if _tracked_width(text, weight, size, tracking) <= max_w:
            return [text], size
        size -= step
    if max_lines <= 1:
        return [text], min_size
    size = start
    while size >= min_size:                     # pass 2: wrap, shrink
        lines = _wrap_tracked(text, weight, size, tracking, max_w)
        if len(lines) <= max_lines and all(
                _tracked_width(ln, weight, size, tracking) <= max_w for ln in lines):
            return lines, size
        size -= step
    lines = _wrap_tracked(text, weight, min_size, tracking, max_w)  # floor
    return (lines[:max_lines] or [text]), min_size


def draw_frame(d: ImageDraw.ImageDraw, color=AMBER_DEEP) -> None:
    """Draw the rounded amber border directly onto a draw context."""
    x0, y0, x1, y1 = FRAME_MARGIN, FRAME_MARGIN, W - FRAME_MARGIN, H - FRAME_MARGIN
    c = color
    w = FRAME_STROKE
    rTL, rTR, rBR, rBL = FRAME_RADII
    d.line([(x0 + rTL, y0), (x1 - rTR, y0)], fill=c, width=w)
    d.line([(x1, y0 + rTR), (x1, y1 - rBR)], fill=c, width=w)
    d.line([(x1 - rBR, y1), (x0 + rBL, y1)], fill=c, width=w)
    d.line([(x0, y1 - rBL), (x0, y0 + rTL)], fill=c, width=w)
    d.arc([x0, y0, x0 + 2 * rTL, y0 + 2 * rTL], 180, 270, fill=c, width=w)
    d.arc([x1 - 2 * rTR, y0, x1, y0 + 2 * rTR], 270, 360, fill=c, width=w)
    d.arc([x1 - 2 * rBR, y1 - 2 * rBR, x1, y1], 0, 90, fill=c, width=w)
    d.arc([x0, y1 - 2 * rBL, x0 + 2 * rBL, y1], 90, 180, fill=c, width=w)


def frame_layer() -> Image.Image:
    """Return the amber border as its own RGBA layer (for animated compositing)."""
    L = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw_frame(ImageDraw.Draw(L), color=AMBER_DEEP + (255,))
    return L


def cutout(source: Union[str, Path, Image.Image]) -> Image.Image:
    """ML cutout (edge fallback) -> trim to content. RGBA, NO static sheen.

    Reels add their own animated shine; stories use the flat cutout. This
    differs from catalogue.process_product which bakes a static sheen.
    """
    if isinstance(source, (str, Path)):
        rgb = Image.open(source).convert("RGB")
    else:
        rgb = source.convert("RGB")
    alpha, _method = cutout_alpha(rgb)
    am = Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.6))
    out = rgb.convert("RGBA")
    out.putalpha(am)
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)
    return out


def prep(source: Union[str, Path, Image.Image], target_h: int, angle: float) -> Image.Image:
    """Cutout -> scale to target height -> rotate. Returns RGBA."""
    p = cutout(source)
    sc = target_h / p.height
    p = p.resize((max(1, int(p.width * sc)), target_h), Image.LANCZOS)
    if angle:
        p = p.rotate(-angle, expand=True, resample=Image.BICUBIC)
    return p


def shadow(cx: int, base_y: int, w: int) -> Image.Image:
    """Soft contact-shadow ellipse under a product at (cx, base_y)."""
    gw = int(w * SHADOW_W_COEF)
    gh = max(12, int(gw * SHADOW_H_COEF))
    s = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(s).ellipse(
        [cx - gw // 2, base_y - gh // 2, cx + gw // 2, base_y + gh // 2],
        fill=SHADOW_RGBA,
    )
    return s.filter(ImageFilter.GaussianBlur(SHADOW_BLUR))


def soft_shadow(cx: int, base_y: int, w: int) -> Image.Image:
    """Premium two-layer product shadow for reels: a tight, darker contact ellipse
    plus a wide, very soft ambient pool. Reads as a product sitting on a surface
    under studio light instead of a flat grey blob. Catalogue/story keep the
    simpler ``shadow`` — this is reel-only so the print look is untouched."""
    s = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(s)
    # wide ambient pool (soft, low opacity, spreads out)
    aw = int(w * 1.02)
    ah = max(18, int(aw * 0.17))
    d.ellipse([cx - aw // 2, base_y - ah // 2, cx + aw // 2, base_y + ah // 2],
              fill=(55, 38, 22, 46))
    # tight contact core (darker, close under the product)
    cw = int(w * 0.74)
    ch = max(12, int(cw * 0.14))
    d.ellipse([cx - cw // 2, base_y - ch // 2 + 6, cx + cw // 2, base_y + ch // 2 + 6],
              fill=(45, 30, 18, 92))
    return s.filter(ImageFilter.GaussianBlur(22))


_GLOW_CACHE: dict[tuple, Image.Image] = {}
_VIGNETTE_CACHE: Optional[Image.Image] = None


def center_glow(cx: int, cy: int, radius: int,
                color: tuple = (255, 246, 232), peak: int = 120) -> Image.Image:
    """Soft warm radial 'studio light' centred at (cx, cy). Lightens the disc
    behind the hero products so they feel lit from the front, adding depth.
    Cached by geometry — cheap to reuse every frame."""
    key = (cx, cy, radius, color, peak)
    cached = _GLOW_CACHE.get(key)
    if cached is not None:
        return cached
    yy, xx = np.ogrid[0:H, 0:W]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / float(radius)
    falloff = np.clip(1.0 - dist, 0.0, 1.0) ** 2          # smooth edge
    a = (falloff * peak).astype("uint8")
    arr = np.zeros((H, W, 4), "uint8")
    arr[..., 0], arr[..., 1], arr[..., 2] = color
    arr[..., 3] = a
    img = Image.fromarray(arr, "RGBA")
    _GLOW_CACHE[key] = img
    return img


def vignette(strength: int = 60) -> Image.Image:
    """Subtle radial darkening toward the corners — pulls the eye to the centre
    and gives the frame a premium, lit-from-centre depth. Cached (static)."""
    global _VIGNETTE_CACHE
    if _VIGNETTE_CACHE is not None:
        return _VIGNETTE_CACHE
    yy, xx = np.ogrid[0:H, 0:W]
    cx, cy = W / 2.0, H / 2.0
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    dist /= dist.max()
    ramp = np.clip((dist - 0.55) / 0.45, 0.0, 1.0) ** 2   # only the outer ring darkens
    arr = np.zeros((H, W, 4), "uint8")
    arr[..., 3] = (ramp * strength).astype("uint8")        # black, varying alpha
    img = Image.fromarray(arr, "RGBA")
    _VIGNETTE_CACHE = img
    return img


# --------------------------------------------------------------------------- #
# shared sizing / cutout-quality / overlap helpers (one fix covers all three   #
# surfaces: catalogue, story, reels)                                           #
# --------------------------------------------------------------------------- #
def cap_size(p: Image.Image, max_w: int = MAX_PROD_W, max_h: int = MAX_PROD_H) -> Image.Image:
    """Fit a product inside a max bounding-box, scaling on its LARGEST dimension.

    The single binding rule shared by catalogue / story / reels: a product never
    exceeds ``max_w`` OR ``max_h`` — whether it is tall, wide or flat — so it can
    never bleed past the frame line (the flat-tub "Piątnica Twaróg" problem).
    Scales by ``min(max_w/w, max_h/h)`` so the larger dimension hits its cap and
    the other stays smaller. Never up-scales.
    """
    sc = min(1.0, max_w / p.width, max_h / p.height)
    if sc < 1.0:
        p = p.resize((max(1, int(p.width * sc)), max(1, int(p.height * sc))), Image.LANCZOS)
    return p


def cutout_status(source: Union[str, Path, Image.Image]) -> tuple[Image.Image, float]:
    """Return (trimmed RGBA cutout, foreground coverage of the ORIGINAL frame).

    Coverage near 1.0 means the matte kept almost the whole image — i.e. the
    cutout failed (a full-bleed / lifestyle photo with no isolatable subject).
    """
    if isinstance(source, (str, Path)):
        rgb = Image.open(source).convert("RGB")
    else:
        rgb = source.convert("RGB")
    alpha, _method = _cutout_alpha(rgb)
    coverage = float((alpha > 128).mean())
    am = Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.6))
    out = rgb.convert("RGBA")
    out.putalpha(am)
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)
    return out, coverage


def rounded_card(source: Union[str, Path, Image.Image], target_h: int,
                 ratio: float = 0.74, radius: int = 30, border: int = 12) -> Image.Image:
    """Cover-fit a photo into a white rounded card of height ``target_h``.

    Used when the ML cutout failed: instead of pasting a full-bleed rectangle
    (which bleeds past the frame and looks broken), the product is shown inside
    a clean rounded card — intentional and on-brand. Returns RGBA.
    """
    if isinstance(source, (str, Path)):
        rgb = Image.open(source).convert("RGB")
    else:
        rgb = source.convert("RGB")
    card_h = max(2, target_h)
    card_w = max(2, int(card_h * ratio))
    inner_w, inner_h = card_w - 2 * border, card_h - 2 * border
    sc = max(inner_w / rgb.width, inner_h / rgb.height)
    rs = rgb.resize((max(1, int(rgb.width * sc)), max(1, int(rgb.height * sc))), Image.LANCZOS)
    left, top = (rs.width - inner_w) // 2, (rs.height - inner_h) // 2
    photo = rs.crop((left, top, left + inner_w, top + inner_h))

    card = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
    omask = Image.new("L", (card_w, card_h), 0)
    ImageDraw.Draw(omask).rounded_rectangle([0, 0, card_w - 1, card_h - 1], radius=radius, fill=255)
    white = Image.new("RGBA", (card_w, card_h), (255, 255, 255, 255))
    card.paste(white, (0, 0), omask)
    imask = Image.new("L", (inner_w, inner_h), 0)
    ImageDraw.Draw(imask).rounded_rectangle(
        [0, 0, inner_w - 1, inner_h - 1], radius=max(4, radius - border), fill=255)
    card.paste(photo, (border, border), imask)
    card.putalpha(omask)
    return card


def prep_safe(source: Union[str, Path, Image.Image], target_h: int, angle: float,
              max_w: int = MAX_PROD_W, max_h: int = MAX_PROD_H) -> tuple[Image.Image, bool]:
    """Cutout → scale → rotate, with the shared size cap; if the cutout failed,
    return a rounded photo card instead. Returns (image, failed?)."""
    cut, coverage = cutout_status(source)
    failed = coverage >= CUTOUT_FAIL_COVERAGE
    if failed:
        img = rounded_card(source, min(target_h, max_h))
    else:
        sc = target_h / cut.height
        img = cut.resize((max(1, int(cut.width * sc)), max(1, target_h)), Image.LANCZOS)
    img = cap_size(img, max_w, max_h)          # bound BEFORE rotation (keeps scale sane)
    if angle:
        img = img.rotate(-angle, expand=True, resample=Image.BICUBIC)
        img = cap_size(img, max_w, max_h)      # bound AGAIN: rotation grows the bbox,
                                               # this is the pasted size → guarantees no bleed
    return img, failed


def spread_no_overlap(items: list, cx: int, max_overlap: float = MAX_OVERLAP) -> None:
    """Spread items horizontally (in place) so no neighbour overlaps more than
    ``max_overlap`` of the narrower one, then recentre the cluster on ``cx``.
    items = [[img, x, y, base], ...] (x is the left edge). Shared by story+reel.

    A single LEFT-TO-RIGHT sweep: keep the leftmost item, then push each next item
    just far enough right that it clears the previous one's right edge minus the
    overlap cap. Because every item only ever moves right (monotonic), three or
    more stacked products separate correctly in one pass — the old two-sided
    nudge left residual overlaps when 3+ items started on top of each other."""
    if not items:
        return
    order = sorted(range(len(items)), key=lambda i: items[i][1] + items[i][0].width / 2)
    prev = None
    for i in order:
        it = items[i]
        if prev is not None:
            p = items[prev]
            narrow = min(p[0].width, it[0].width)
            min_left = p[1] + p[0].width - int(max_overlap * narrow)
            if it[1] < min_left:
                it[1] = min_left
        prev = i
    lo = min(it[1] for it in items)
    hi = max(it[1] + it[0].width for it in items)
    off = cx - (lo + hi) // 2
    for it in items:
        it[1] += off


def distribute_evenly(items: list, cx: int, target_w: int = COMFY_SPREAD_W,
                      max_gap: int = MAX_GAP) -> None:
    """Give a narrow cluster room to breathe (in place): when the products, packed
    with no overlap, span LESS than ``target_w``, re-lay them out with EQUAL gaps so
    they fill toward ``target_w`` centred on ``cx`` — instead of bunching together in
    the middle (the "three Milka bars stacked side-by-side" look).

    Safe by construction: the span never exceeds ``target_w`` and no single gap
    exceeds ``max_gap``, so products keep clear positive space between them (always
    wider than the no-overlap minimum). Clusters already as wide as / wider than
    ``target_w`` are left untouched for fit_cluster_width to shrink. items hold
    [img, x_left, y, base]; only x_left changes."""
    if len(items) < 2:
        return
    order = sorted(range(len(items)), key=lambda i: items[i][1] + items[i][0].width / 2)
    sum_w = sum(items[i][0].width for i in order)
    n = len(order)
    span = min(target_w, sum_w + (n - 1) * max_gap)
    gap = (span - sum_w) / (n - 1)
    if gap <= 0:                               # already wide enough — don't compress
        return
    x = cx - span / 2
    for i in order:
        items[i][1] = int(round(x))
        x += items[i][0].width + gap


# Fit clusters to a hair inside the frame lines (never flush against them).
CLUSTER_FIT_W = INNER_W - 28


def fit_cluster_width(items: list, max_w: int = CLUSTER_FIT_W) -> None:
    """If the spread cluster is wider than ``max_w``, shrink every member (in
    place) so the whole group fits between the frame lines. items hold RGBA imgs
    whose .width drives the spread; we replace the image + keep base/center."""
    if not items:
        return
    lo = min(it[1] for it in items)
    hi = max(it[1] + it[0].width for it in items)
    total = hi - lo
    if total <= max_w:
        return
    k = max_w / total
    cx = (lo + hi) / 2
    # Scale BOTH each image AND its centre offset from the cluster centre by k, so
    # the whole group — widths, gaps and overlaps alike — shrinks uniformly to
    # exactly ``max_w``. (The old version shrank images but kept their original
    # left edges, leaving gaps the push-apart re-spread could never close, so the
    # cluster stayed too wide and bled past the frame.)
    for it in items:
        img, x, _y, base = it[0], it[1], it[2], it[3]
        nw, nh = max(1, int(img.width * k)), max(1, int(img.height * k))
        old_center = x + img.width / 2
        new_center = cx + (old_center - cx) * k
        it[0] = img.resize((nw, nh), Image.LANCZOS)
        it[1] = int(new_center - nw / 2)
        it[2] = base - nh                  # keep the baseline fixed
    # Overlaps are already within cap (uniform scale preserves ratios); this only
    # cleans up integer rounding and recentres.
    spread_no_overlap(items, int(cx))
