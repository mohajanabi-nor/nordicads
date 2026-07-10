"""Animated reels (mp4, 9:16) — ported 1:1 from build_reel*.py.

One parametric `build_reel` covers the shared skeleton (cream bg + circles +
amber frame + logo/heading/CTA/subline fades + product pop-in/float/shine).
Optional features: origin chip (real ISO flag), kampanje price block + sticker.
Thin variant wrappers (`reel_nyhet`, `reel_choc`, `reel_snacks`,
`reel_restock`, `reel_kampanje`) set each prototype's exact constants.

Requires imageio + ffmpeg (libx264) for encoding.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence, Union

import numpy as np
from PIL import Image, ImageDraw

from .constants import (
    W, H, FPS, N_FRAMES, N_FRAMES_MONTAGE, CREAM, ORANGE, PEACH, AMBER_DEEP,
    INK, MUTE, WHITE, CTA_PRIMARY, CTA_WEB, SUBLINE_DEFAULT,
)
from .render import (
    font, tracked, logo_mark, frame_layer, prep, shadow, soft_shadow, fit_heading,
    prep_safe, spread_no_overlap, distribute_evenly, fit_cluster_width, MIN_LEGIBLE_W,
    center_glow, vignette,
)
from .animation import ease, popscale, spring_pop, out_back, paste_a, shine
from .chips import chip_layer

# A product placement: prepared RGBA image + position + animation.
ReelSpec = tuple  # (prod: Image, cx: int, base_y: int, start: int, phase: float, shine: bool)


@dataclass
class ReelStyle:
    circ_outer: tuple = (225, 745, 865, 1375)
    circ_inner: tuple = (300, 815, 790, 1305)
    compact_header: bool = False          # kampanje uses a slightly tighter header
    heading: str = "NYHETER"
    entrance: int = 210                   # pop-in travel (px)
    shine_start: int = 48                 # gloss sweep window = [shine_start, shine_start+30]
    cta_y: int = 1560
    cta_text: str = CTA_PRIMARY
    cta_size: int = 40
    cta_start: int = 54
    subline_text: Optional[str] = SUBLINE_DEFAULT
    subline_y: int = 1744
    subline_start: int = 66
    n_frames: int = N_FRAMES


def _logo_layer(style: ReelStyle) -> Image.Image:
    """Logo mark + NORDIC / ENGROS wordmark (its own fade layer)."""
    L = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if style.compact_header:
        lw, ly, ny, ns, ey, es = 118, 150, 290, 52, 354, 30
    else:
        lw, ly, ny, ns, ey, es = 120, 158, 300, 54, 366, 31
    mk = logo_mark(ORANGE, lw)
    L.alpha_composite(mk, (W // 2 - mk.width // 2, ly))
    d = ImageDraw.Draw(L)
    tracked(d, W // 2, ny, "NORDIC", font(800, ns), INK, 2)
    tracked(d, W // 2, ey, "E N G R O S", font(700, es), ORANGE, 5)
    return L


def _heading_layer(style: ReelStyle, heading: str) -> Image.Image:
    """Heading + underline (its own fade layer, slightly delayed).

    Category names can be long ("KORNPRODUKTER & RIS"), so the heading auto-fits
    the inner width: it shrinks first, then breaks to two lines if still too
    wide — it is never clipped outside the 9:16 frame. The underline tracks the
    last line.
    """
    L = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if style.compact_header:
        hy, base_hs, uy0, uy1 = 462, 64, 560, 569
    else:
        hy, base_hs, uy0, uy1 = 478, 58, 564, 572
    lines, hs = fit_heading(heading, 800, W - 160, base_hs, 36, tracking=1, max_lines=2)
    f = font(800, hs)
    asc, desc = f.getmetrics()
    line_h = asc + desc
    d = ImageDraw.Draw(L)
    y = hy
    for ln in lines:
        tracked(d, W // 2, y, ln, f, INK, 1)
        y += line_h
    if len(lines) == 1:
        d.rectangle([W // 2 - 70, uy0, W // 2 + 70, uy1], fill=ORANGE)
    else:
        uy = y + 12                                   # just below the last line
        d.rectangle([W // 2 - 70, uy, W // 2 + 70, uy + (uy1 - uy0)], fill=ORANGE)
    return L


def _cta_layer(style: ReelStyle) -> Image.Image:
    L = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    by = style.cta_y
    d.rounded_rectangle([110, by, W - 110, by + 120], radius=24, fill=ORANGE)
    tracked(d, W // 2, by + 22, style.cta_text, font(800, style.cta_size), WHITE, 2)
    fw = font(700, 32)
    d.text((W // 2 - d.textlength(CTA_WEB, font=fw) / 2, by + 74 + (4 if style.compact_header else 0)),
           CTA_WEB, font=fw, fill=WHITE)
    return L


def _subline_layer(text: str, y: int) -> Image.Image:
    L = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    fs = font(600, 30)
    d.text((W // 2 - d.textlength(text, font=fs) / 2, y), text, font=fs, fill=MUTE)
    return L


def _price_layers(new_price: float, old_price: float):
    """Return (price_layer, sticker_cropped, sticker_pos, pct)."""
    pct = round((1 - new_price / old_price) * 100)
    # sticker -X%
    stick = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ds = ImageDraw.Draw(stick)
    sx, sy, r = 842, 640, 96
    ds.ellipse([sx - r, sy - r, sx + r, sy + r], fill=ORANGE)
    st = f"-{pct}%"
    sf = font(800, 48)
    ds.text((sx - ds.textlength(st, font=sf) / 2, sy - 32), st, font=sf, fill=WHITE)
    stick_c = stick.crop((sx - r - 4, sy - r - 4, sx + r + 4, sy + r + 4))
    stick_pos = (sx - r - 4, sy - r - 4)
    # price block
    price = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dp = ImageDraw.Draw(price)
    pt = f"kr {new_price:.2f}".replace(".", ",")
    dp.text((W // 2 - dp.textlength(pt, font=font(800, 120)) / 2, 1330), pt, font=font(800, 120), fill=AMBER_DEEP)
    ot = f"før kr {old_price:.2f}".replace(".", ",")
    ow = dp.textlength(ot, font=font(600, 46))
    ox = W // 2 - ow / 2
    dp.text((ox, 1486), ot, font=font(600, 46), fill=MUTE)
    dp.line([(ox, 1512), (ox + ow, 1508)], fill=MUTE, width=4)
    return price, stick_c, stick_pos, pct


def _encode_mp4(frames, out: Union[str, Path], crf: int = 18) -> Path:
    """Shared high-quality H.264 writer for every reel (montage included).

    Visually-lossless CRF, yuv420p for universal playback (IG/TikTok/WhatsApp),
    High profile, and +faststart so it streams before fully downloading. ``crf``
    can be lowered (more bitrate) for detail-heavy content like the scrolling
    montage wall, which compresses worse than a few big hero products."""
    import imageio.v2 as imageio

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # `veryfast` encodes 3-5x quicker than `slow` for a marginal bitrate cost
    # that's invisible on a phone (IG/TikTok/WhatsApp re-encode everything anyway).
    # CRF still governs quality, so the picture stays visually-lossless.
    imageio.mimwrite(
        out, frames, fps=FPS, codec="libx264", macro_block_size=8,
        pixelformat="yuv420p",
        output_params=["-crf", str(crf), "-preset", "veryfast", "-profile:v", "high",
                       "-movflags", "+faststart"],
    )
    return out


def build_reel(
    specs: Sequence[ReelSpec],
    out: Union[str, Path],
    style: Optional[ReelStyle] = None,
    chip: Optional[tuple] = None,        # (text, cx, cy, start, iso)
    price: Optional[tuple] = None,       # (new_price, old_price)
    deco: Optional[Image.Image] = None,  # static themed layer behind products
) -> Path:
    style = style or ReelStyle()
    N = style.n_frames

    base = Image.new("RGBA", (W, H), CREAM + (255,))
    d = ImageDraw.Draw(base)
    d.ellipse(list(style.circ_outer), fill=PEACH)
    d.ellipse(list(style.circ_inner), fill=ORANGE)
    # Warm studio glow at the disc centre → products read as lit from the front.
    ix0, iy0, ix1, iy1 = style.circ_inner
    gcx, gcy = (ix0 + ix1) // 2, (iy0 + iy1) // 2
    grad = int(0.62 * (ix1 - ix0))
    base.alpha_composite(center_glow(gcx, gcy, grad))
    # Optional themed decoration (e.g. football pitch + balls) sits over the
    # disc but UNDER the products and frame, so bottles still pop in on top.
    if deco is not None:
        base.alpha_composite(deco)
    base.alpha_composite(frame_layer())
    vign = vignette()

    logoL = _logo_layer(style)
    headL = _heading_layer(style, style.heading)
    ctaL = _cta_layer(style)
    subL = _subline_layer(style.subline_text, style.subline_y) if style.subline_text else None
    chipL = chip_layer(chip[0], chip[4]) if chip else None
    priceL = stickC = stick_pos = None
    if price:
        priceL, stickC, stick_pos, _pct = _price_layers(price[0], price[1])

    frames = []
    for f in range(N):
        img = base.copy()
        paste_a(img, logoL, (0, 0), ease(f / 12))
        paste_a(img, headL, (0, 0), ease((f - 6) / 14))

        for prod, cx, base_y, st, ph, sh in specs:
            t = (f - st) / 24.0
            a = ease(t)
            if a <= 0:
                continue
            # Premium spring entrance: position overshoots slightly past rest and
            # the product scale-pops from 0.90→~1.0, then a gentle float once settled.
            ob = out_back(t, 1.30)                       # 0 → ~1.07 → 1
            entr = (1 - ob) * style.entrance             # rise up, tiny overshoot
            sc = spring_pop(t)                           # 0.90 → ~1.02 → 1.0
            settled = t >= 1.0
            fl = 7 * math.sin(2 * math.pi * (f - st) / 64.0 + ph) if settled else 0
            yoff = entr - fl
            ss, se = style.shine_start, style.shine_start + 30
            pim = shine(prod, (f - ss) / 30.0) if (sh and ss <= f <= se) else prod
            if not settled and sc != 1.0:                # scale only while entering
                pim = pim.resize((max(1, int(pim.width * sc)),
                                  max(1, int(pim.height * sc))), Image.LANCZOS)
            x = int(cx - pim.width // 2)
            y = int(base_y - pim.height + yoff)
            shl = soft_shadow(cx, int(base_y), pim.width)
            paste_a(img, shl, (0, 0), a)
            paste_a(img, pim, (x, y), a)

        if chipL is not None:
            cs = chip[3]
            tt = (f - cs) / 16.0
            if tt > 0:
                s = max(0.05, popscale(tt))
                cw, ch = int(chipL.width * s), int(chipL.height * s)
                cc = chipL.resize((cw, ch))
                paste_a(img, cc, (chip[1] - cw // 2, chip[2] - ch // 2), ease((f - cs) / 10.0))

        if priceL is not None:
            ts = (f - 40) / 16.0
            if ts > 0:
                s = max(0.05, popscale(ts))
                sc2 = stickC.resize((int(stickC.width * s), int(stickC.height * s)))
                cx0 = stick_pos[0] + stickC.width // 2
                cy0 = stick_pos[1] + stickC.height // 2
                paste_a(img, sc2, (cx0 - sc2.width // 2, cy0 - sc2.height // 2), ease((f - 40) / 10.0))
            paste_a(img, priceL, (0, 0), ease((f - 50) / 14))

        paste_a(img, ctaL, (0, int((1 - ease((f - style.cta_start) / 16)) * 150)),
                ease((f - style.cta_start) / 16))
        if subL is not None:
            paste_a(img, subL, (0, 0), ease((f - style.subline_start) / 14))
        img.alpha_composite(vign)                 # subtle depth vignette on top
        frames.append(np.asarray(img.convert("RGB")))

    return _encode_mp4(frames, out, crf=18)


# ---------------- variant wrappers (exact prototype constants) ----------------

def reel_nyhet(bottle, can, heading="NYE DRIKKER", out="reel_nyhet.mp4") -> Path:
    style = ReelStyle(heading=heading)
    specs = [(bottle, 465, 1342, 10, 0.0, False), (can, 648, 1342, 22, math.pi, True)]
    return build_reel(specs, out, style)


def reel_choc(wafer, bubbly, heading="FERSK SJOKOLADE", iso="DE",
              chip_text="FRA TYSKLAND", out="reel_choc.mp4") -> Path:
    style = ReelStyle(
        circ_outer=(215, 855, 875, 1505), circ_inner=(295, 930, 795, 1430),
        heading=heading, entrance=220, shine_start=50, cta_y=1600,
        cta_start=56, subline_y=1784, subline_start=68,
    )
    specs = [(wafer, 455, 1130, 10, 0.0, False), (bubbly, 640, 1380, 22, math.pi, True)]
    return build_reel(specs, out, style, chip=(chip_text, 780, 720, 44, iso))


def reel_snacks(p_left, p_right, p_center, heading="UKENS SNACKS", iso="PL",
                chip_text="FRA POLEN", out="reel_snacks.mp4") -> Path:
    # 3-product fan; center is the hero (shine). Matches build_reel_snacks.py.
    style = ReelStyle(heading=heading, entrance=220, shine_start=50,
                      subline_y=1784, subline_start=68, cta_y=1600, cta_start=56)
    specs = [
        (p_left, 402, 1330, 10, 0.0, False),
        (p_right, 688, 1330, 26, math.pi, False),
        (p_center, 545, 1360, 18, math.pi / 2, True),
    ]
    return build_reel(specs, out, style, chip=(chip_text, 300, 720, 44, iso))


def reel_restock(p_left, p_right, heading="TILBAKE PÅ LAGER", iso="PL",
                 chip_text="FRA POLEN", out="reel_restock.mp4") -> Path:
    # Matches build_reel_restock.py: entrance 220, shine on the LEFT product.
    style = ReelStyle(
        circ_outer=(215, 855, 875, 1505), circ_inner=(295, 930, 795, 1430),
        heading=heading, entrance=220, shine_start=50, cta_y=1600, cta_start=56,
        subline_text="Fersk vare – bestill før den er borte", subline_y=1784, subline_start=68,
    )
    specs = [(p_left, 460, 1300, 12, 0.0, True), (p_right, 665, 1360, 24, math.pi, False)]
    return build_reel(specs, out, style, chip=(chip_text, 300, 720, 44, iso))


def reel_category(sources: Sequence, heading: str, out: Union[str, Path],
                  iso: Optional[str] = None, chip_text: Optional[str] = None) -> Path:
    """Generic per-category reel from REAL product images (1/2/3 hero layout).

    `sources` are image paths/PIL images for the category's top products; they
    go through the same ML cutout pipeline (`prep`) as the montage/story.
    `iso`/`chip_text` add an origin chip ONLY when the category has a confident
    single origin (caller passes None to omit — never guess).
    """
    n = min(len(sources), 3)
    chip = (chip_text, 0, 0, 44, iso) if (chip_text and iso) else None

    if n >= 3:
        style = ReelStyle(heading=heading, entrance=220, shine_start=50,
                          subline_y=1784, subline_start=68, cta_y=1600, cta_start=56)
        prepared = [prep_safe(sources[0], 440, -11), prep_safe(sources[1], 440, 11),
                    prep_safe(sources[2], 560, 0)]
        specs = _placed_specs(prepared, bases=[1330, 1330, 1360],
                              starts=[10, 26, 18], phases=[0.0, math.pi, math.pi / 2],
                              shine_idx=2)
        if chip:
            chip = (chip_text, 300, 720, 44, iso)   # top-left, clear of the fan
    elif n == 2:
        style = ReelStyle(
            circ_outer=(215, 855, 875, 1505), circ_inner=(295, 930, 795, 1430),
            heading=heading, entrance=220, shine_start=50, cta_y=1600,
            cta_start=56, subline_y=1784, subline_start=68,
        )
        prepared = [prep_safe(sources[0], 540, -7), prep_safe(sources[1], 470, 8)]
        specs = _placed_specs(prepared, bases=[1300, 1360],
                              starts=[12, 24], phases=[0.0, math.pi], shine_idx=0)
        if chip:
            chip = (chip_text, 790, 700, 44, iso)   # top-right, clear of products
    else:
        style = ReelStyle(heading=heading, entrance=210, shine_start=48)
        prepared = [prep_safe(sources[0], 720, -4)]
        specs = _placed_specs(prepared, bases=[1380], starts=[12], phases=[0.0],
                              shine_idx=0)
        if chip:
            chip = (chip_text, 790, 700, 44, iso)
    return build_reel(specs, out, style, chip=chip)


def _placed_specs(prepared, bases, starts, phases, shine_idx, cx=W // 2):
    """Turn prepared (img, failed) products into reel specs that always show every
    product distinctly. The rules, in order:

      1) Spread with the tight shared guardrail (<=~13% overlap) so no product can
         hide the one behind it.
      1b) If the de-overlapped cluster is NARROWER than the frame, breathe it out
         with even gaps (distribute_evenly) so slim products read as a row across
         the middle instead of bunching shoulder-to-shoulder.
      2) If the cluster is wider than the frame, SHRINK the whole group
         (fit_cluster_width) — never widen the overlap to make room.
      3) If a product would still be too small to read (< MIN_LEGIBLE_W), drop the
         narrowest one and re-lay-out — fewer, legible products beat tiny ones.
      4) Z-order: draw the LARGEST product at the back and smaller ones in front,
         so a small product is never swallowed by a big neighbour.

    Each product keeps its own entrance start/phase + shine flag through all of
    this. Returns a ReelSpec list already in back-to-front draw order.
    """
    entries = []  # keep originals so re-layout after a drop never compounds shrink
    for i, ((img, _failed), base) in enumerate(zip(prepared, bases)):
        entries.append({"orig": img, "base": base,
                         "start": starts[i], "phase": phases[i], "shine": i == shine_idx})

    def layout(es):
        items = [[e["orig"].copy(), int(cx - e["orig"].width // 2),
                  int(e["base"] - e["orig"].height), int(e["base"])] for e in es]
        if len(items) > 1:
            spread_no_overlap(items, cx)      # kill overlap (<=13%), centre
            distribute_evenly(items, cx)      # breathe out into spare width, even gaps
            fit_cluster_width(items)          # shrink to frame if still too wide
        return items

    items = layout(entries)
    # (3) Drop the narrowest product while the smallest is below the legible floor.
    while len(entries) > 1 and min(it[0].width for it in items) < MIN_LEGIBLE_W:
        narrow_i = min(range(len(entries)), key=lambda k: entries[k]["orig"].width)
        entries.pop(narrow_i)
        items = layout(entries)

    paired = list(zip(entries, items))
    if not any(e["shine"] for e, _ in paired):     # keep one shine if its item was dropped
        big = max(range(len(paired)), key=lambda k: paired[k][1][0].width * paired[k][1][0].height)
        paired[big][0]["shine"] = True
    # (4) Largest area first => pasted first => drawn at the back.
    paired.sort(key=lambda p: p[1][0].width * p[1][0].height, reverse=True)

    specs = []
    for e, (img, x, _y, base) in paired:
        ccx = int(x + img.width // 2)
        specs.append((img, ccx, base, e["start"], e["phase"], e["shine"]))
    return specs


def _vgrad(height: int, top_op: int, bottom_op: int, flip: bool = False) -> Image.Image:
    a = np.linspace(top_op, bottom_op, height).astype("uint8")
    if flip:
        a = a[::-1]
    arr = np.zeros((height, W, 4), "uint8")
    arr[:, :, 0], arr[:, :, 1], arr[:, :, 2] = CREAM
    arr[:, :, 3] = a[:, None]
    return Image.fromarray(arr, "RGBA")


def reel_montage(cutouts: Sequence[Image.Image], count: int,
                 heading: str = "NYE VARER DENNE UKEN", out="reel_montage.mp4") -> Path:
    """Scrolling product-wall + counting-up number (build_montage.py).

    `cutouts` are pre-cut RGBA product images (use render.cutout). `count` is the
    real number to tick up to (prototype hardcoded 100).
    """
    N = N_FRAMES_MONTAGE
    prods = list(cutouts) or [Image.new("RGBA", (260, 300), (0, 0, 0, 0))]

    # Fewer, BIGGER products in a 4-wide wall (was 5×small). Larger cells mean
    # each product carries lower spatial frequency, which WhatsApp/IG's
    # re-compression preserves far better than a dense grid of tiny tilted
    # cut-outs — the single biggest win against the "pixelated on WhatsApp" look.
    cols, cw, ch, gap, rows = 4, 255, 300, 18, 16
    wall_w = cols * cw + (cols + 1) * gap
    wall_h = rows * ch + (rows + 1) * gap
    wall = Image.new("RGBA", (wall_w, wall_h), (0, 0, 0, 0))
    idx = 0
    for r in range(rows):
        for c in range(cols):
            p = prods[(idx * 7 + 3) % len(prods)]
            idx += 1
            fit = min((cw - 26) / p.width, (ch - 26) / p.height) * (0.86 + 0.12 * ((idx * 5) % 4) / 3)
            pp = p.resize((max(1, int(p.width * fit)), max(1, int(p.height * fit))), Image.LANCZOS)
            ang = ((idx * 53) % 11) - 5
            pp = pp.rotate(ang, expand=True, resample=Image.BICUBIC)
            x = gap + c * (cw + gap) + (cw - pp.width) // 2
            y = gap + r * (ch + gap) + (ch - pp.height) // 2
            wall.alpha_composite(pp, (x, y))
    wall_x = (W - wall_w) // 2

    topG = _vgrad(500, 255, 0)
    botG = _vgrad(360, 0, 255)
    frameL = frame_layer()
    mk = logo_mark(ORANGE, 86)

    ctaL = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dc = ImageDraw.Draw(ctaL)
    by = 1640
    dc.rounded_rectangle([110, by, W - 110, by + 120], radius=24, fill=ORANGE)
    tracked(dc, W // 2, by + 22, CTA_PRIMARY, font(800, 40), WHITE, 2)
    fw = font(700, 32)
    dc.text((W // 2 - dc.textlength(CTA_WEB, font=fw) / 2, by + 74), CTA_WEB, font=fw, fill=WHITE)

    # Travel far enough that a lot of products glide past in the 8 s — the wall
    # scrolls ~2900 px (was 1600), so noticeably more of the catalogue shows.
    # rows=16 keeps the wall taller than the scroll so it never runs into empty
    # cream at the bottom. (Faster motion costs a little encoder detail, but
    # showing more of the range is the point of the montage.)
    wy_start, wy_end = 470, 470 - 2900
    frames = []
    for f in range(N):
        img = Image.new("RGBA", (W, H), CREAM + (255,))
        prog = ease(max(0, min(1, (f - 8) / (N - 28))))
        wy = int(wy_start + prog * (wy_end - wy_start))
        img.alpha_composite(wall, (wall_x, wy))
        img.alpha_composite(topG, (0, 0))
        img.alpha_composite(botG, (0, H - 360))
        d = ImageDraw.Draw(img)
        img.alpha_composite(mk, (W // 2 - mk.width // 2, 96))
        tracked(d, W // 2, 196, "NORDIC ENGROS", font(800, 34), INK, 3)
        cnt = int(round(count * ease(min(1, f / 72.0))))
        nf = font(800, 150)
        ntxt = str(cnt)
        d.text((W // 2 - d.textlength(ntxt, font=nf) / 2, 250), ntxt, font=nf, fill=ORANGE)
        # Uppercase to match the brand style, and allow TWO lines so a custom
        # campaign headline ("VI INTRODUSERER MANGE VARER FRA BALKAN") fits
        # instead of shrinking to nothing. The block stays centred on y=418, so a
        # one-line default ("NYE VARER DENNE UKEN") renders exactly as before.
        mlines, mhs = fit_heading(heading.upper(), 800, W - 140, 38, 24, tracking=2, max_lines=2)
        mf = font(800, mhs)
        masc, mdesc = mf.getmetrics()
        mline_h = masc + mdesc
        my = 418 - (mline_h * (len(mlines) - 1)) // 2
        for ln in mlines:
            tracked(d, W // 2, my, ln, mf, INK, 2)
            my += mline_h
        ca = ease((f - (N - 32)) / 20.0)
        if ca > 0:
            cl = ctaL.copy()
            al = cl.split()[3].point(lambda v: int(v * ca))
            cl.putalpha(al)
            img.alpha_composite(cl, (0, int((1 - ca) * 120)))
        img.alpha_composite(frameL, (0, 0))
        frames.append(np.asarray(img.convert("RGB")))
    # Detail-heavy scrolling wall → give it more bitrate (lower CRF) so it stays
    # sharp and survives WhatsApp/IG re-compression better than the old quality=8.
    return _encode_mp4(frames, out, crf=16)


def _soccer_ball(r: int) -> Image.Image:
    """A small stylised football (white sphere, central black pentagon + seams).
    Procedurally drawn — no external asset, no trademark."""
    size = r * 2 + 8
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = size // 2
    dark = (32, 32, 38, 255)
    d.ellipse([c - r, c - r, c + r, c + r], fill=(255, 255, 255, 255),
              outline=dark, width=max(2, r // 13))

    def pentagon(cx, cy, rad, rot=-90.0):
        return [(cx + rad * math.cos(math.radians(rot + 72 * i)),
                 cy + rad * math.sin(math.radians(rot + 72 * i))) for i in range(5)]

    pent = pentagon(c, c, r * 0.40)
    d.polygon(pent, fill=dark)
    seam = max(2, r // 11)
    for vx, vy in pent:
        ang = math.atan2(vy - c, vx - c)
        ex, ey = c + math.cos(ang) * r * 0.95, c + math.sin(ang) * r * 0.95
        d.line([(vx, vy), (ex, ey)], fill=dark, width=seam)
        pr = r * 0.15
        d.ellipse([ex - pr, ey - pr, ex + pr, ey + pr], fill=dark)
    return img


def _vm_deco(badge_text: str = "VM 2026") -> Image.Image:
    """Static football decoration layer: a red VM badge flanked by footballs,
    plus a couple of corner balls. Sits behind the drink products."""
    RED = (206, 43, 43)
    L = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)

    bf = font(800, 46)
    tw = sum(d.textlength(ch, font=bf) for ch in badge_text) + 3 * (len(badge_text) - 1)
    pad, by, bh = 46, 600, 96
    bx0, bx1 = W / 2 - (tw / 2 + pad), W / 2 + (tw / 2 + pad)
    d.rounded_rectangle([bx0, by, bx1, by + bh], radius=bh // 2, fill=RED)
    asc, desc = bf.getmetrics()
    tracked(d, W // 2, int(by + (bh - asc) / 2), badge_text, bf, WHITE, 3)

    ball = _soccer_ball(48)
    cy = int(by + (bh - ball.height) / 2)
    L.alpha_composite(ball, (int(bx0 - ball.width - 16), cy))
    L.alpha_composite(ball, (int(bx1 + 16), cy))
    # corner accents
    b2, b3 = _soccer_ball(34), _soccer_ball(26)
    L.alpha_composite(b2, (84, 250))
    L.alpha_composite(b3, (W - 84 - b3.width, 300))
    return L


def reel_vm_squad(sources: Sequence, out: Union[str, Path],
                  heading: str = "VM-DRIKKER", badge: str = "VM 2026",
                  subline: str = "Heia! Forfriskning til fotballsommeren") -> Path:
    """Special football-themed hero reel: a 'squad' of up to 5 drink products in
    a row over a red VM badge + footballs. Reuses the standard reel skeleton, so
    logo/heading/CTA/animation all match the rest of the drop. No FIFA marks."""
    style = ReelStyle(
        circ_outer=(215, 855, 875, 1505), circ_inner=(295, 930, 795, 1430),
        heading=heading, entrance=220, shine_start=50,
        subline_text=subline, subline_y=1784, subline_start=68,
        cta_y=1600, cta_start=56,
    )
    srcs = list(sources)[:5]
    # Manual even single-row "squad" layout. Unlike _placed_specs (built for the
    # 2–3 product category reels), this NEVER drops a product: every drink in the
    # multipack must appear. If the row is wider than the frame (e.g. a wide
    # multipack tray shot is mixed in), the whole group is shrunk uniformly to
    # fit — smaller, but all 5 stay visible.
    prepared = [prep_safe(s, 430, ((i % 2) * 2 - 1) * 5)[0] for i, s in enumerate(srcs)]
    margin, gap = 70, 22
    avail = W - 2 * margin
    total = sum(p.width for p in prepared) + gap * (len(prepared) - 1)
    if total > avail:
        sc = avail / total
        prepared = [p.resize((max(1, int(p.width * sc)), max(1, int(p.height * sc))),
                             Image.LANCZOS) for p in prepared]
        total = sum(p.width for p in prepared) + gap * (len(prepared) - 1)
    base_y = 1330
    mid = len(prepared) // 2
    x = (W - total) // 2
    specs = []
    for i, p in enumerate(prepared):
        cx = x + p.width // 2
        phase = (i * math.pi / 2) % (2 * math.pi)
        specs.append((p, cx, base_y, 10 + i * 5, phase, i == mid))
        x += p.width + gap
    return build_reel(specs, out, style, deco=_vm_deco(badge))


def reel_kampanje(bottle, can, new_price: float, old_price: float, out="reel_kampanje.mp4") -> Path:
    style = ReelStyle(
        circ_outer=(235, 690, 845, 1300), circ_inner=(310, 760, 770, 1230),
        compact_header=True, heading="TILBUD", cta_y=1600, cta_text="BESTILL NÅ",
        cta_size=46, cta_start=62, subline_text=None,
    )
    specs = [(bottle, 448, 1240, 10, 0.0, False), (can, 636, 1240, 22, math.pi, False)]
    return build_reel(specs, out, style, price=(new_price, old_price))
