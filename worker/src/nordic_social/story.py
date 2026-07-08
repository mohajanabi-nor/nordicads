"""Static story generators (PNG, 9:16).

- `story_v5`: fixed 1/2/3-product teaser (build_social_v5.py).
- `story_v7`: dynamic named layouts fan/diagonal/stagger/hero (build_social_v7.py).

Same palette/branding as the catalogue; cutouts via the shared ML pipeline.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Sequence, Union

from PIL import Image, ImageDraw, ImageFilter

from .constants import (
    W, H, CREAM, ORANGE, PEACH, INK, MUTE, WHITE,
    LOGO_W, LOGO_Y, NORDIC_Y, ENGROS_Y, HEADING_Y, UNDERLINE_Y,
    CTA_Y, CTA_H, CTA_RADIUS, CTA_PRIMARY, CTA_WEB, SUBLINE_DEFAULT, SUBLINE_Y,
)
from .render import (
    font, tracked, logo_mark, draw_frame, cutout, fit_heading,
    spread_no_overlap, MAX_OVERLAP, cap_size,
)

Source = Union[str, Path, Image.Image]

# v7 named layouts: per product (cx, baseline_y, target_h, angle), circle (cx,cy,rx,ry), z-order.
LAYOUTS = {
    "fan":      {"pos": [(474, 1330, 580, -8), (606, 1330, 560, 8)], "circ": (540, 1045, 315, 300), "z": [0, 1]},
    "diagonal": {"pos": [(410, 1150, 510, -13), (662, 1360, 612, 9)], "circ": (548, 1140, 335, 318), "z": [0, 1]},
    "stagger":  {"pos": [(430, 1430, 560, -6), (660, 1180, 540, 12)], "circ": (545, 1120, 330, 330), "z": [1, 0]},
    "hero":     {"pos": [(560, 1380, 730, -4)], "circ": (560, 1060, 335, 330), "z": [0]},
}


def _header(img: Image.Image, d: ImageDraw.ImageDraw, heading: str) -> None:
    mk = logo_mark(ORANGE, LOGO_W)
    img.paste(mk, (W // 2 - mk.width // 2, LOGO_Y), mk)
    tracked(d, W // 2, NORDIC_Y, "NORDIC", font(800, 54), INK, 2)
    tracked(d, W // 2, ENGROS_Y, "E N G R O S", font(700, 31), ORANGE, 5)
    # Long category names auto-shrink, then break to two lines — never clipped.
    lines, hs = fit_heading(heading, 800, W - 160, 58, 36, tracking=1, max_lines=2)
    f = font(800, hs)
    asc, desc = f.getmetrics()
    line_h = asc + desc
    y = HEADING_Y
    for ln in lines:
        tracked(d, W // 2, y, ln, f, INK, 1)
        y += line_h
    if len(lines) == 1:
        d.rectangle([W // 2 - 70, UNDERLINE_Y[0], W // 2 + 70, UNDERLINE_Y[1]], fill=ORANGE)
    else:
        uy = y + 12
        d.rectangle([W // 2 - 70, uy, W // 2 + 70, uy + (UNDERLINE_Y[1] - UNDERLINE_Y[0])], fill=ORANGE)


def _footer(d: ImageDraw.ImageDraw, subline: str) -> None:
    by = CTA_Y
    d.rounded_rectangle([110, by, W - 110, by + CTA_H], radius=CTA_RADIUS, fill=ORANGE)
    tracked(d, W // 2, by + 22, CTA_PRIMARY, font(800, 40), WHITE, 2)
    fw = font(700, 32)
    d.text((W // 2 - d.textlength(CTA_WEB, font=fw) / 2, by + 74), CTA_WEB, font=fw, fill=WHITE)
    fs = font(600, 30)
    d.text((W // 2 - d.textlength(subline, font=fs) / 2, SUBLINE_Y), subline, font=fs, fill=MUTE)


def _shadow_ellipse(img: Image.Image, cx: int, base: int, pw: int, tone=(60, 40, 25, 80)) -> None:
    gw = int(pw * 0.86)
    gh = max(12, int(gw * 0.14))
    s = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(s).ellipse([cx - gw // 2, base - gh // 2, cx + gw // 2, base + gh // 2], fill=tone)
    sb = s.filter(ImageFilter.GaussianBlur(18))
    img.paste(sb, (0, 0), sb)


def _scale_rot(p: Image.Image, target_h: int, ang: float) -> Image.Image:
    """Resize a cutout to a target height, then rotate (expanding canvas).

    Bounded by the SHARED frame-relative size cap (width AND height) so a flat or
    wide product can never bleed past the frame — same rule as catalogue + reels.
    """
    sc = target_h / p.height
    p = p.resize((max(1, int(p.width * sc)), target_h), Image.LANCZOS)
    p = cap_size(p)                     # bound before rotation (keeps scale sane)
    if ang:
        p = p.rotate(-ang, expand=True, resample=Image.BICUBIC)
        p = cap_size(p)                # bound the rotated (pasted) size → no bleed
    return p


# Guardrail (shared with reels): cap horizontal overlap between neighbours at
# MAX_OVERLAP of the narrower product's width so nothing is ever stacked.
_guardrail = spread_no_overlap


def story_v5(products: Sequence[Source], heading: str = "UKENS NYHETER",
             out: Union[str, Path] = "story.png", subline: str = SUBLINE_DEFAULT) -> Path:
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)
    draw_frame(d)
    d.ellipse([230, 740, 850, 1340], fill=PEACH)
    d.ellipse([305, 810, 775, 1270], fill=ORANGE)
    _header(img, d, heading)

    n = min(len(products), 3)
    cx, floor = 540, 1320
    if n == 1:
        angs, scales, dxs = [0], [1.0], [0]
    elif n == 2:
        angs, scales, dxs = [-8, 8], [0.96, 0.96], [-145, 148]
    else:
        angs, scales, dxs = [-14, 0, 14], [0.82, 1.0, 0.82], [-225, 0, 225]

    items = []
    for i in range(n):
        p = cutout(products[i])
        th = int(580 * scales[i])
        sc = th / p.height
        p = p.resize((max(1, int(p.width * sc)), th), Image.LANCZOS)
        p = cap_size(p)                    # shared bounding-box cap (w AND h)
        if angs[i]:
            p = p.rotate(-angs[i], expand=True, resample=Image.BICUBIC)
            p = cap_size(p)                # re-cap rotated bbox → no bleed
        x = int(cx + dxs[i] - p.width // 2)
        y = int(floor - p.height)
        items.append((p, x, y))

    zorder = ([0, 2, 1][:n]) if n >= 3 else list(range(n))
    for i in zorder:
        p, x, y = items[i]
        _shadow_ellipse(img, x + p.width // 2, floor, p.width, tone=(80, 45, 20, 80))
    for i in zorder:
        p, x, y = items[i]
        img.paste(p, (x, y), p)

    _footer(ImageDraw.Draw(img), subline)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out


def _place_two(a: Image.Image, b: Image.Image, L: dict):
    """Place two cutouts cleanly. Flat/wide forms (frysebrett etc.) go
    side-by-side with a mild stagger and distinct sizes; tall narrow forms
    keep the fan. A guardrail caps overlap either way. Returns (items, z)."""
    cx, cy, rx, ry = L["circ"]
    base = L["pos"][0][1]
    aspect = (a.width / a.height + b.width / b.height) / 2
    flat = aspect >= 0.92  # trays/boxes are roughly square-or-wider

    if flat:
        # Hero (larger, lower-left) + secondary (smaller, raised right).
        hero = _scale_rot(a, 470, -5)
        sub = _scale_rot(b, 360, 7)
        gap = 28
        avail = W - 2 * 70
        total = hero.width + sub.width + gap
        if total > avail:                      # shrink to fit the frame width
            k = avail / total
            hero = hero.resize((int(hero.width * k), int(hero.height * k)), Image.LANCZOS)
            sub = sub.resize((int(sub.width * k), int(sub.height * k)), Image.LANCZOS)
            gap = int(gap * k)
        left = cx - (hero.width + sub.width + gap) // 2
        hb = base               # hero baseline
        sb = base - 130         # secondary raised for stagger
        items = [
            [hero, left, hb - hero.height, hb],
            [sub, left + hero.width + gap, sb - sub.height, sb],
        ]
        _guardrail(items, cx)
        return items, [0, 1]    # hero first (behind), sub in front

    # Tall forms: keep the designed fan, but vary size slightly + guardrail.
    items = []
    for i, (cut, scale) in enumerate(zip((a, b), (1.0, 0.86))):
        pcx, b_, th, ang = L["pos"][i]
        p = _scale_rot(cut, int(th * scale), ang)
        items.append([p, int(pcx - p.width // 2), int(b_ - p.height), b_])
    _guardrail(items, cx)
    return items, L["z"]


def story_v7(products: Sequence[Source], layout: str = "fan", heading: str = "UKENS NYHETER",
             out: Union[str, Path] = "story.png", subline: str = SUBLINE_DEFAULT) -> Path:
    L = LAYOUTS[layout]
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)
    draw_frame(d)
    cx, cy, rx, ry = L["circ"]
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=PEACH)
    d.ellipse([cx - rx + 70, cy - ry + 70, cx + rx - 70, cy + ry - 50], fill=ORANGE)
    _header(img, d, heading)

    n = min(len(products), len(L["pos"]))
    cuts = [cutout(products[i]) for i in range(n)]

    if n == 2:
        items, zorder = _place_two(cuts[0], cuts[1], L)
    else:
        items, zorder = [], list(range(n))
        for i in range(n):
            pcx, base, th, ang = L["pos"][i]
            p = _scale_rot(cuts[i], th, ang)
            items.append([p, int(pcx - p.width // 2), int(base - p.height), base])

    for i in zorder:
        p, x, y, base = items[i]
        _shadow_ellipse(img, int(x + p.width // 2), int(base), p.width, tone=(60, 40, 25, 80))
    for i in zorder:
        p, x, y, base = items[i]
        img.paste(p, (int(x), int(y)), p)

    _footer(ImageDraw.Draw(img), subline)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out
