"""PDF generator — ported 1:1 from prototype_build_catalogue.py.

Exact pixel/colour values preserved. Data now comes from Modell A (Edition of
ClassifiedProduct) instead of the prototype's hard-coded DATA list. Differences
from the prototype, per BUILD-SPEC:
  - cutout is ML-based (images.process_product), not flood-fill;
  - flags are the real ISO PNG set (flags.flag);
  - card badge = NYHET / TILBUD (wins) / none for RESTOCK;
  - divider has NO subtitle (§4);
  - missing barcode -> "N/A" (§1);
  - week + country codes are dynamic.
"""
from __future__ import annotations

import io
import math
from datetime import date
from pathlib import Path
from typing import Optional

import barcode
import numpy as np
import qrcode
from barcode.writer import ImageWriter
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .config import CONFIG
from .flags import flag
from .images import process_product
from .model_a import Edition
from .models import ClassifiedProduct, State
from .regions import caption_for

# ---- canvas + palette (identical to prototype) ----
W, H = 1240, 1754
DARK = (40, 42, 54)
DARK_LITE = (50, 52, 66)
CREAM = (247, 240, 222)
AMBER = (254, 189, 89)
AMBER_DEEP = (224, 149, 31)
ORANGE_HI = (248, 154, 77)
ORANGE_LO = (200, 92, 12)
INK = (40, 42, 54)
MUTE_D = (150, 153, 170)
MUTE_L = (138, 141, 148)
WHITE = (255, 255, 255)
CREAM_FAINT = (232, 223, 202)
CREAM_WM = (236, 228, 208)

FONT = str(CONFIG.font_path)


def week_label(today: Optional[date] = None) -> str:
    today = today or date.today()
    iso = today.isocalendar()
    return f"Uke {iso.week} · {iso.year}"


def font(weight: int, size: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(FONT, size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:  # noqa: BLE001
        pass
    return f


def tracked(draw, cx, y, text, fnt, fill, tracking, left=None):
    widths = [draw.textlength(ch, font=fnt) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = left if left is not None else cx - total / 2
    for ch, wch in zip(text, widths):
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += wch + tracking
    return total


def _wrap_words(draw, text, fnt, max_w):
    """Greedy word-wrap (a too-long single word stays on its own line)."""
    lines, cur = [], ""
    for word in text.split():
        cand = (cur + " " + word).strip()
        if not cur or draw.textlength(cand, font=fnt) <= max_w:
            cur = cand
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def fit_title(draw, text, max_w, weight, start, min_size, max_lines=2, step=2):
    """Largest font (start..min_size) that fits ``text`` in ``max_w`` — never
    clip. Shrinks as one line first, then wraps to <= ``max_lines`` lines.
    Returns (lines, font, size)."""
    size = start
    while size > min_size:                          # pass 1: one line, shrink
        f = font(weight, size)
        if draw.textlength(text, font=f) <= max_w:
            return [text], f, size
        size -= step
    if max_lines <= 1:
        return [text], font(weight, min_size), min_size
    size = start
    while size >= min_size:                         # pass 2: wrap, shrink
        f = font(weight, size)
        lines = _wrap_words(draw, text, f, max_w)
        if len(lines) <= max_lines and all(
                draw.textlength(ln, font=f) <= max_w for ln in lines):
            return lines, f, size
        size -= step
    f = font(weight, min_size)                       # floor
    return _wrap_words(draw, text, f, max_w)[:max_lines], f, min_size


def make_qr(url, size):
    qr = qrcode.QRCode(border=1, box_size=10)
    qr.add_data(url)
    qr.make(fit=True)
    q = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    return q.resize((size, size), Image.NEAREST)


def logo_mark(target, w):
    src = Image.open(CONFIG.logo_path).convert("RGB")
    a = np.asarray(src).astype(int)
    alpha = np.clip((255 - a[:, :, 2]) / (255 - 89), 0, 1)
    alpha = (alpha * 255).astype("uint8")
    out = Image.new("RGBA", src.size, target + (0,))
    out.putalpha(Image.fromarray(alpha))
    h = int(src.size[1] * w / src.size[0])
    return out.resize((w, h), Image.LANCZOS)


# ---------------- FORSIDE ----------------
def cover(codes: list[str], week: str, cta_url: str, title: Optional[str] = None):
    cxc = (84 + W) // 2
    sun_y = 470
    yy, xx = np.mgrid[0:H, 0:W]
    base = np.zeros((H, W, 3)) + np.array(DARK, dtype=float)
    dv = np.sqrt((xx - cxc) ** 2 + (yy - 560) ** 2)
    vig = np.clip(1 - dv / 950, 0, 1) * 0.12
    base = base * (1 - vig[..., None]) + np.array((62, 65, 84)) * vig[..., None]
    dg = np.sqrt((xx - cxc) ** 2 + (yy - sun_y) ** 2)
    g = np.clip(1 - dg / 320, 0, 1) ** 1.7 * 0.55
    base = base * (1 - g[..., None]) + np.array(AMBER) * g[..., None]
    img = Image.fromarray(np.clip(base, 0, 255).astype("uint8"))
    d = ImageDraw.Draw(img)
    SB = 84
    d.rectangle([0, 0, SB, H], fill=AMBER)
    sf = font(700, 25)
    sb = "frysevarer  •  snacks  •  godteri  •  drikke"
    tw = d.textlength(sb, font=sf)
    strip = Image.new("RGBA", (int(tw) + 20, 42), (0, 0, 0, 0))
    ImageDraw.Draw(strip).text((10, 8), sb, font=sf, fill=DARK)
    strip = strip.rotate(90, expand=True)
    img.paste(strip, (SB // 2 - strip.width // 2, H // 2 - strip.height // 2), strip)
    tracked(d, cxc, 330, "•   K A T A L O G   •", font(700, 25), AMBER, 3)
    mk = logo_mark(AMBER, 212)
    img.paste(mk, (cxc - mk.width // 2, 392), mk)
    tracked(d, cxc, 672, "NORDIC ENGROS", font(800, 76), CREAM, 4)
    d.rectangle([cxc - 46, 772, cxc + 46, 776], fill=AMBER_DEEP)
    tracked(d, cxc, 800, "C O N S T A N T L Y   F O R W A R D", font(600, 21), MUTE_D, 3)
    # Subtitle band: the operator's campaign line when given (e.g. "VI
    # INTRODUSERER MANGE VARER FRA BALKAN"), else the default. Auto-fit so a long
    # line shrinks (then wraps to 2 lines) instead of clipping, and stays clear
    # of the week pill at y=992.
    if title and title.strip():
        up = title.strip().upper()
        lines, tf, _ = fit_title(d, up, W - 220, 800, 48, 26, max_lines=2)
        asc, desc = tf.getmetrics()
        lh = asc + desc
        ty = 918 if len(lines) == 1 else 900 - (lh * (len(lines) - 1)) // 2
        for ln in lines:
            d.text((cxc - d.textlength(ln, font=tf) / 2, ty), ln, font=tf, fill=AMBER)
            ty += lh
    else:
        tracked(d, cxc, 918, "NYHETER & KAMPANJE", font(800, 48), AMBER, 1)
    pf = font(700, 28)
    ptw = d.textlength(week, font=pf)
    pw = ptw + 56
    px = cxc - pw // 2
    py = 992
    d.rounded_rectangle([px, py, px + pw, py + 52], radius=26, outline=AMBER, width=2)
    d.text((cxc - ptw / 2, py + 11), week, font=pf, fill=CREAM)
    cap = caption_for(codes)
    tracked(d, cxc, 1168, cap, font(700, 22), MUTE_D, 4)
    CAP = 9
    show = codes[: CAP - 1] + ["+%d" % (len(codes) - (CAP - 1))] if len(codes) > CAP else codes
    fw, gap = 52, 14
    if show:
        tot = len(show) * fw + (len(show) - 1) * gap
        fx = cxc - tot // 2
        fy = 1212
        for c in show:
            img.paste(flag(c, fw, 35), (fx, fy))
            fx += fw + gap
    qim = make_qr(cta_url, 132)
    pad = 16
    qc = 132 + 2 * pad
    fb = font(700, 27)
    fu = font(500, 23)
    t1, t2 = "Bestill i nettbutikken", "www.nordicengros.com"
    tw2 = max(d.textlength(t1, font=fb), d.textlength(t2, font=fu))
    ig = 26
    block = qc + ig + tw2
    bx = int(cxc - block // 2)
    by = 1470
    d.rounded_rectangle([bx, by, bx + qc, by + qc], radius=16, fill=WHITE)
    img.paste(qim, (bx + pad, by + pad))
    tx = bx + qc + ig
    d.text((tx, by + 44), t1, font=fb, fill=AMBER)
    d.text((tx, by + 84), t2, font=fu, fill=MUTE_D)
    d.rectangle([SB + 40, 1690, W - 40, 1692], fill=(58, 60, 74))
    d.text((SB + 40, 1712), "Nye varer på lager – bestill direkte i nettbutikken vår",
           font=font(500, 23), fill=MUTE_D)
    return img


# ---------------- MELLOMSIDE ----------------
def divider(num: int, title: str, count: int, week: str):
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)
    mk = logo_mark(CREAM_WM, 360)
    img.paste(mk, (W - mk.width + 40, H - mk.height + 30), mk)
    d = ImageDraw.Draw(img)
    nwid = tracked(d, 0, 86, "NORDIC ", font(800, 30), INK, 1, left=84)
    tracked(d, 0, 86, "ENGROS", font(800, 30), AMBER_DEEP, 1, left=84 + nwid)
    nt = "NYHETER · " + week.split(" · ")[0]
    d.text((W - 84 - d.textlength(nt, font=font(700, 26)), 90), nt, font=font(700, 26), fill=MUTE_L)
    d.text((76, 470), f"{num:02d}", font=font(800, 300), fill=CREAM_FAINT)
    absy = 792
    # Long category titles auto-fit: shrink, then break to two lines (down to a
    # floor size). The name is never clipped at the page margin (§4).
    lines, tf, _ = fit_title(d, title, W - 2 * 84, 800, 108, 60, max_lines=2)
    asc, desc = tf.getmetrics()
    line_h = asc + desc
    ty = absy
    for ln in lines:
        d.text((84, ty), ln, font=tf, fill=INK)
        ty += line_h
    rule_y = ty + 18
    d.rectangle([88, rule_y, 238, rule_y + 8], fill=AMBER_DEEP)
    # NO subtitle (BUILD-SPEC §4); count line follows the amber rule.
    d.text((88, rule_y + 50), f"{count} nye varer i denne kategorien",
           font=font(700, 32), fill=AMBER_DEEP)
    fz = "nordicengros.com"
    d.text((W / 2 - d.textlength(fz, font=font(700, 26)) / 2, 1672), fz, font=font(700, 26), fill=MUTE_L)
    return img


# ---------------- STREKKODE ----------------
def make_barcode(data, tw=232, th=46):
    c = barcode.get("code128", data, writer=ImageWriter())
    bio = io.BytesIO()
    c.write(bio, options=dict(module_height=12, module_width=0.22, quiet_zone=1,
                              write_text=False, background="white", foreground="black"))
    bio.seek(0)
    im = Image.open(bio).convert("RGB")
    a = np.asarray(im)
    cols = np.where((a < 128).any(axis=2).any(axis=0))[0]
    if len(cols):
        im = im.crop((cols[0], 0, cols[-1] + 1, im.height))
    return im.resize((tw, th))


# ---------------- PRODUKTKORT ----------------
CW, CHH, RAD = 347, 672, 26


def card(cp: ClassifiedProduct):
    p = cp.product
    name = p.title
    supplier = p.vendor
    price = p.price_label
    sku = p.sku or "—"
    code = p.barcode  # may be None -> "N/A"
    image = p.image_path

    sup = Image.new("RGBA", (CW, CHH), (0, 0, 0, 0))
    cd = ImageDraw.Draw(sup)
    cd.rounded_rectangle([0, 0, CW - 1, CHH - 1], radius=RAD, fill=WHITE + (255,))

    # ---- product image zone (always present per spec; ML cutout + shadow) ----
    if image:
        prod = process_product(image)
        box_w, box_h, floor = 222, 248, 320
        pw, ph = prod.size
        scale = min(box_w / pw, box_h / ph)
        prod = prod.resize((max(1, int(pw * scale)), max(1, int(ph * scale))), Image.LANCZOS)
        pw, ph = prod.size
        px = (CW - pw) // 2
        py = floor - ph
        gw = int(pw * 0.94)
        gh = max(8, int(gw * 0.18))
        gs = Image.new("RGBA", (CW, CHH), (0, 0, 0, 0))
        gd = ImageDraw.Draw(gs)
        gcx = CW // 2
        gcy = floor - 2
        gd.ellipse([gcx - gw // 2, gcy - gh // 2, gcx + gw // 2, gcy + gh // 2], fill=(40, 42, 54, 120))
        gs = gs.filter(ImageFilter.GaussianBlur(10))
        sup.alpha_composite(gs)
        sup.alpha_composite(prod, (px, py))
    else:
        _image_zone(cd, 26, 26, CW - 26, 332)

    # ---- name (max 2 lines, centred, fixed top 347) ----
    nf = font(700, 23)
    words = name.split()
    lines, cur = [], ""
    for wd in words:
        t = (cur + " " + wd).strip()
        if cd.textlength(t, font=nf) <= CW - 44:
            cur = t
        else:
            lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    lines = lines[:2]
    ny = 347
    for ln in lines:
        cd.text((CW / 2 - cd.textlength(ln, font=nf) / 2, ny), ln, font=nf, fill=INK)
        ny += 30

    # ---- supplier (fixed 418) ----
    sf = font(500, 19)
    cd.text((CW / 2 - cd.textlength(supplier, font=sf) / 2, 418), supplier, font=sf, fill=MUTE_L)

    # ---- price (centre 458) deep amber ----
    pf = font(800, 42)
    cd.text((CW / 2 - cd.textlength(price, font=pf) / 2, 438), price, font=pf, fill=AMBER_DEEP)

    # ---- inkl. mva · SKU (fixed 512, shrinks) ----
    skutxt = f"inkl. mva · SKU {sku}"
    ssize = 17
    while ssize > 12 and ImageDraw.Draw(sup).textlength(skutxt, font=font(500, ssize)) > CW - 40:
        ssize -= 1
    skf = font(500, ssize)
    cd.text((CW / 2 - cd.textlength(skutxt, font=skf) / 2, 512), skutxt, font=skf, fill=MUTE_L)

    # ---- barcode (centre ~562) or N/A ----
    if code:
        bc = make_barcode(code)
        sup.paste(bc, ((CW - bc.width) // 2, 548))
        numtxt = " ".join(code)
        nmf = font(500, 18)
        if cd.textlength(numtxt, font=nmf) > CW - 40:
            numtxt = code
        cd.text((CW / 2 - cd.textlength(numtxt, font=nmf) / 2, 600), numtxt, font=nmf, fill=(96, 98, 106))
    else:
        naf = font(700, 24)
        cd.text((CW / 2 - cd.textlength("N/A", font=naf) / 2, 566), "N/A", font=naf, fill=(150, 150, 158))

    # ---- badge: NYHET / TILBUD (TILBUD wins); RESTOCK = none ----
    badge = None
    if cp.state == State.TILBUD:
        badge = "TILBUD"
    elif cp.state == State.NYHET:
        badge = "NYHET"
    if badge:
        ribbon = Image.new("RGBA", (CW, CHH), (0, 0, 0, 0))
        rd = ImageDraw.Draw(ribbon)
        rd.polygon([(CW - 152, 0), (CW, 0), (CW, 152)], fill=AMBER_DEEP + (255,))
        tag = Image.new("RGBA", (240, 60), (0, 0, 0, 0))
        tracked(ImageDraw.Draw(tag), 0, 12, badge, font(800, 18), WHITE, 2, left=12)
        tag = tag.crop(tag.getbbox())
        tag = tag.rotate(-45, expand=True, resample=Image.BICUBIC)
        cx, cy = CW - 51, 51
        ribbon.alpha_composite(tag, (int(cx - tag.width / 2), int(cy - tag.height / 2)))
        mask = Image.new("L", (CW, CHH), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, CW - 1, CHH - 1], radius=RAD, fill=255)
        sup.paste(ribbon, (0, 0), Image.composite(ribbon.split()[3], Image.new("L", (CW, CHH), 0), mask))
    return sup


def _image_zone(cd, x0, y0, x1, y1):
    cd.rounded_rectangle([x0, y0, x1, y1], radius=16, fill=(242, 242, 245, 255))
    gcx = (x0 + x1) // 2
    gcy = (y0 + y1) // 2
    t = (227, 228, 234, 255)
    bw, bh = 70, 92
    cd.rounded_rectangle([gcx - bw // 2, gcy - bh // 2, gcx + bw // 2, gcy + bh // 2], radius=12, fill=t)
    cd.rounded_rectangle([gcx - 20, gcy - bh // 2 - 13, gcx + 20, gcy - bh // 2 + 9], radius=8, fill=t)


# ---------------- KOMPAKT PRODUKTKORT (3×4 = 12/side) ----------------
CW2, CHH2 = 347, 345


def card_compact(cp: ClassifiedProduct):
    """Half-height card for the dense 12-per-page grid. Keeps the essentials
    (cutout, name, supplier, price, SKU, NYHET/TILBUD badge) but drops the
    scannable barcode strip to save vertical space."""
    p = cp.product
    name = p.title
    supplier = p.vendor
    price = p.price_label
    sku = p.sku or "—"
    image = p.image_path

    sup = Image.new("RGBA", (CW2, CHH2), (0, 0, 0, 0))
    cd = ImageDraw.Draw(sup)
    cd.rounded_rectangle([0, 0, CW2 - 1, CHH2 - 1], radius=22, fill=WHITE + (255,))

    # ---- product image zone (ML cutout + soft floor shadow) ----
    if image:
        prod = process_product(image)
        box_w, box_h, floor = 188, 150, 168
        pw, ph = prod.size
        scale = min(box_w / pw, box_h / ph)
        prod = prod.resize((max(1, int(pw * scale)), max(1, int(ph * scale))), Image.LANCZOS)
        pw, ph = prod.size
        px = (CW2 - pw) // 2
        py = floor - ph
        gw = int(pw * 0.94)
        gh = max(6, int(gw * 0.16))
        gs = Image.new("RGBA", (CW2, CHH2), (0, 0, 0, 0))
        gd = ImageDraw.Draw(gs)
        gcx = CW2 // 2
        gcy = floor - 2
        gd.ellipse([gcx - gw // 2, gcy - gh // 2, gcx + gw // 2, gcy + gh // 2], fill=(40, 42, 54, 120))
        gs = gs.filter(ImageFilter.GaussianBlur(8))
        sup.alpha_composite(gs)
        sup.alpha_composite(prod, (px, py))
    else:
        _image_zone(cd, 22, 18, CW2 - 22, 168)

    # ---- name (max 2 lines, centred) ----
    nf = font(700, 21)
    lines = _wrap_words(cd, name, nf, CW2 - 40)[:2]
    ny = 182
    for ln in lines:
        cd.text((CW2 / 2 - cd.textlength(ln, font=nf) / 2, ny), ln, font=nf, fill=INK)
        ny += 25

    # ---- supplier ----
    sf = font(500, 17)
    cd.text((CW2 / 2 - cd.textlength(supplier, font=sf) / 2, 236), supplier, font=sf, fill=MUTE_L)

    # ---- price (deep amber) ----
    pf = font(800, 36)
    cd.text((CW2 / 2 - cd.textlength(price, font=pf) / 2, 258), price, font=pf, fill=AMBER_DEEP)

    # ---- inkl. mva · SKU ----
    skutxt = f"inkl. mva · SKU {sku}"
    ssize = 16
    while ssize > 11 and cd.textlength(skutxt, font=font(500, ssize)) > CW2 - 36:
        ssize -= 1
    skf = font(500, ssize)
    cd.text((CW2 / 2 - cd.textlength(skutxt, font=skf) / 2, 308), skutxt, font=skf, fill=MUTE_L)

    # ---- badge: NYHET / TILBUD (TILBUD wins); RESTOCK = none ----
    badge = None
    if cp.state == State.TILBUD:
        badge = "TILBUD"
    elif cp.state == State.NYHET:
        badge = "NYHET"
    if badge:
        ribbon = Image.new("RGBA", (CW2, CHH2), (0, 0, 0, 0))
        rd = ImageDraw.Draw(ribbon)
        rd.polygon([(CW2 - 118, 0), (CW2, 0), (CW2, 118)], fill=AMBER_DEEP + (255,))
        tag = Image.new("RGBA", (200, 52), (0, 0, 0, 0))
        tracked(ImageDraw.Draw(tag), 0, 10, badge, font(800, 15), WHITE, 2, left=10)
        tag = tag.crop(tag.getbbox())
        tag = tag.rotate(-45, expand=True, resample=Image.BICUBIC)
        cx, cy = CW2 - 40, 40
        ribbon.alpha_composite(tag, (int(cx - tag.width / 2), int(cy - tag.height / 2)))
        mask = Image.new("L", (CW2, CHH2), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, CW2 - 1, CHH2 - 1], radius=22, fill=255)
        sup.paste(ribbon, (0, 0), Image.composite(ribbon.split()[3], Image.new("L", (CW2, CHH2), 0), mask))
    return sup


def paste_card_with_shadow(page, cardimg, x, y):
    blur = 17
    off = (0, 12)
    op = 64
    pad = blur * 3
    cw, ch = cardimg.size
    sh = Image.new("RGBA", (cw + 2 * pad, ch + 2 * pad), (0, 0, 0, 0))
    shape = Image.new("RGBA", cardimg.size, DARK + (op,))
    sh.paste(shape, (pad + off[0], pad + off[1]), cardimg.split()[3])
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    page.alpha_composite(sh, (x - pad, y - pad))
    page.alpha_composite(cardimg, (x, y))


# ---------------- PRODUKTSIDE (kompakt 3×4) ----------------
def product_page(category: str, products: list[ClassifiedProduct], page_no: int,
                 total_pages: int, week: str, first: bool = True, count: int = 0):
    img = Image.new("RGBA", (W, H), CREAM + (255,))
    d = ImageDraw.Draw(img)
    # brand row
    tracked(d, 0, 52, "NORDIC ", font(800, 28), INK, 1, left=64)
    nwid = d.textlength("NORDIC ", font=font(800, 28))
    tracked(d, 0, 52, "ENGROS", font(800, 28), AMBER_DEEP, 1, left=64 + nwid + 4)
    wf = font(700, 26)
    week_w = d.textlength(week, font=wf)
    d.text((W - 64 - week_w, 54), week, font=wf, fill=MUTE_L)

    # inline category header band (replaces the old full-page divider)
    cat_title = category.title() if first else category.title() + "  (forts.)"
    clines, ctf, _ = fit_title(d, cat_title, W - 128, 800, 46, 26, max_lines=1)
    d.text((64, 100), clines[0], font=ctf, fill=INK)
    if first and count:
        ct = f"{count} varer"
        d.text((W - 64 - d.textlength(ct, font=font(700, 26)), 148), ct, font=font(700, 26), fill=MUTE_L)
    d.rectangle([66, 158, 206, 166], fill=AMBER_DEEP)
    d.line([(64, 196), (W - 64, 196)], fill=(222, 216, 200), width=2)

    gut_x, gut_y = 35, 22
    items = products[:12]
    rows = [items[i:i + 3] for i in range(0, len(items), 3)]
    y = 214
    for row in rows:
        rw = len(row) * CW2 + (len(row) - 1) * gut_x
        x = (W - rw) // 2
        for cp in row:
            paste_card_with_shadow(img, card_compact(cp), x, y)
            x += CW2 + gut_x
        y += CHH2 + gut_y

    fz1 = "Bestill i nettbutikken"
    fz2 = " · nordicengros.com"
    f1 = font(800, 26)
    f2 = font(700, 26)
    tot = d.textlength(fz1, font=f1) + d.textlength(fz2, font=f2)
    fx = W / 2 - tot / 2
    d.text((fx, 1700), fz1, font=f1, fill=AMBER_DEEP)
    d.text((fx + d.textlength(fz1, font=f1), 1700), fz2, font=f2, fill=AMBER_DEEP)
    sidetxt = f"Side {page_no} / {total_pages}"
    d.text((W - 64 - d.textlength(sidetxt, font=font(500, 24)), 1702), sidetxt, font=font(500, 24), fill=MUTE_L)
    return img.convert("RGB")


# ---------------- INNHOLD (visuell indeks) ----------------
def index_page(edition: Edition, start_page: dict[str, int], total_pp: int, week: str):
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)
    tracked(d, 0, 52, "NORDIC ", font(800, 28), INK, 1, left=64)
    nwid = d.textlength("NORDIC ", font=font(800, 28))
    tracked(d, 0, 52, "ENGROS", font(800, 28), AMBER_DEEP, 1, left=64 + nwid + 4)
    wf = font(700, 26)
    d.text((W - 64 - d.textlength(week, font=wf), 54), week, font=wf, fill=MUTE_L)

    d.text((64, 108), "Innhold", font=font(800, 64), fill=INK)
    d.rectangle([66, 196, 240, 206], fill=AMBER_DEEP)
    tracked(d, 0, 226, "K A T E G O R I E R", font(700, 22), MUTE_L, 3, left=66)

    cats = [c for c in edition.categories if c in start_page]
    half = (len(cats) + 1) // 2
    cols = [cats[:half], cats[half:]]
    col_x = [64, W // 2 + 24]
    col_w = (W // 2) - 64 - 48
    row_h = 58
    top = 296
    rf = font(700, 28)
    nf = font(500, 22)
    pf = font(800, 28)
    for ci, col in enumerate(cols):
        x0 = col_x[ci]
        y = top
        for cat in col:
            count = len(edition.by_category[cat])
            pg = start_page[cat]
            label = cat.title()
            ptxt = f"s. {pg}"
            pw = d.textlength(ptxt, font=pf)
            maxw = col_w - pw - 18
            while d.textlength(label, font=rf) > maxw and len(label) > 4:
                label = label[:-2]
            if label != cat.title():
                label = label.rstrip() + "…"
            d.text((x0, y), label, font=rf, fill=INK)
            d.text((x0 + 4, y + 32), f"{count} varer", font=nf, fill=MUTE_L)
            d.text((x0 + col_w - pw, y + 6), ptxt, font=pf, fill=AMBER_DEEP)
            d.line([(x0, y + row_h - 8), (x0 + col_w, y + row_h - 8)], fill=(228, 220, 202), width=1)
            y += row_h

    fz = "nordicengros.com"
    d.text((W / 2 - d.textlength(fz, font=font(700, 24)) / 2, 1702), fz, font=font(700, 24), fill=MUTE_L)
    return img


# ---------------- KONTAKTSIDE ----------------
def contact():
    img = Image.new("RGB", (W, H), DARK)
    d = ImageDraw.Draw(img)
    cxc = W // 2
    circ = Image.new("L", (W, H), 0)
    ImageDraw.Draw(circ).ellipse([cxc - 460, 180, cxc + 460, 1100], fill=34)
    circ = circ.filter(ImageFilter.GaussianBlur(2))
    img.paste(Image.new("RGB", (W, H), DARK_LITE), (0, 0), circ)
    d = ImageDraw.Draw(img)
    mk = logo_mark(AMBER, 170)
    img.paste(mk, (cxc - mk.width // 2, 440), mk)
    nf = font(800, 64)
    d.text((cxc - d.textlength("Nordic Engros AS", font=nf) / 2, 650), "Nordic Engros AS", font=nf, fill=AMBER)
    for i, t in enumerate(["Org. 922 796 076", "Oslo, Norge"]):
        tf = font(500, 32)
        d.text((cxc - d.textlength(t, font=tf) / 2, 748 + i * 48), t, font=tf, fill=CREAM)
    tracked(d, cxc, 900, "K O N T A K T   O S S", font(800, 30), AMBER, 2)
    for i, t in enumerate(["+47 00 00 00 00", "post@nordicengros.com"]):
        tf = font(500, 32)
        d.text((cxc - d.textlength(t, font=tf) / 2, 962 + i * 48), t, font=tf, fill=CREAM)
    tracked(d, cxc, 1100, "www.nordicengros.com", font(700, 28), AMBER, 2)
    return img


# ---------------- BUILD ----------------
def build_pdf(edition: Edition, out_path: Path, week: Optional[str] = None,
              cta_url: Optional[str] = None, save_pngs: bool = False,
              title: Optional[str] = None) -> Path:
    week = week or week_label()
    cta_url = cta_url or CONFIG.cta_url
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    PER = 12
    cat_pages = {c: max(1, math.ceil(len(edition.by_category[c]) / PER))
                 for c in edition.categories if edition.by_category[c]}
    total_pp = sum(cat_pages.values())
    start_page: dict[str, int] = {}
    run = 1
    for c in edition.categories:
        if c not in cat_pages:
            continue
        start_page[c] = run
        run += cat_pages[c]

    pages = [cover(edition.country_codes, week, cta_url, title=title)]
    pages.append(index_page(edition, start_page, total_pp, week))

    pno = 1
    for cat in edition.categories:
        prods = edition.by_category[cat]
        if not prods:
            continue  # skip empty category (§4)
        chunks = [prods[k:k + PER] for k in range(0, len(prods), PER)]
        for ci, chunk in enumerate(chunks):
            pages.append(product_page(cat, chunk, pno, total_pp, week,
                                      first=(ci == 0), count=len(prods)))
            pno += 1
    pages.append(contact())

    rgb_pages = [p.convert("RGB") for p in pages]
    rgb_pages[0].save(out_path, save_all=True, append_images=rgb_pages[1:], resolution=150.0)
    if save_pngs:
        for k, p in enumerate(rgb_pages):
            p.save(out_path.with_name(f"{out_path.stem}_pg{k:02d}.png"))
    return out_path
