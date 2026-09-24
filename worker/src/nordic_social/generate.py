"""Map a catalogue Edition into a coherent social drop (stories + reels).

Reuses the catalogue's classification (NYHET/TILBUD/RESTOCK), the AI category
grouping and per-product country code. Product images come from the same cached
paths the catalogue uses (image_path / image_url already downloaded) and go
through the SAME ML cutout pipeline (render.cutout / render.prep).

Outputs per drop (ALL mp4, from REAL product photos):
  - montage reel counting up to the number of new arrivals
  - one category reel per category (1/2/3-product hero layout, cluster-coherent)
  - PLUS, for every category with more than 3 products with photos, a SLIDER reel
    that pages through all of them 3 at a time (12 new ice creams ship as 12, not
    as the top 3). The 3-hero reel above is still rendered — the slider is extra.
  - a kampanje reel when TILBUD products (compare_at_price) exist
  - an origin chip (flag pill) ONLY if the operator asks for one: off by default,
    "auto" prints it when every product in the reel shares one origin, or a fixed
    ISO code prints that country on every reel (see `origin` in build_social_drop)
The drop is video-only: no PNG stories or debug PNGs are written. Empty pieces
are skipped (e.g. no reel for a category with no usable photo, no kampanje reel
when the drop has 0 offers).
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from nordic_catalogue.models import ClassifiedProduct, State
from nordic_catalogue.model_a import Edition
from nordic_catalogue import regions

from .constants import SLIDER_MAX_ITEMS, SLIDER_PER_PAGE
from .render import cutout, prep_safe
from . import reel as R


def _img_source(cp: ClassifiedProduct):
    """Best available image source for a classified product, or None."""
    p = cp.product
    return p.image_path or p.image_url or None


def _top_products(cps, n):
    """Already sorted by rank in the edition; take the first n with an image."""
    out = []
    for cp in cps:
        if _img_source(cp):
            out.append(cp)
        if len(out) >= n:
            break
    return out


def _clusters(cps):
    """Split an already-ordered category into clusters of like varetype.

    The edition orders products best-selling-cluster-first and keeps sales
    order inside each cluster, so consecutive items with the same type_label
    form one cluster. Returns a list of (label, [cp, ...]) preserving order.
    """
    groups: list[tuple[str, list]] = []
    for cp in cps:
        lbl = cp.type_label or "_"
        if groups and groups[-1][0] == lbl:
            groups[-1][1].append(cp)
        else:
            groups.append((lbl, [cp]))
    return groups


def _cluster_picks(cps, n):
    """Pick up to n like items from a SINGLE cluster, so a reel/story shows
    coherent products (not ice + meat mixed). Choose the cluster yielding the
    most usable photos; ties keep edition order (best-selling cluster first)."""
    best: list = []
    for _lbl, group in _clusters(cps):
        picks = _top_products(group, n)
        if len(picks) > len(best):
            best = picks
        if len(best) >= n:
            break
    return best


def _slider_groups(cps):
    """Usable (has a photo) products per varetype cluster, edition order kept.

    Feeds `reel.slider_pages`: a slider page is filled from ONE cluster, so a
    page never mixes ispinner with beger even though both ride the same reel.
    """
    groups = []
    for _lbl, group in _clusters(cps):
        usable = [cp for cp in group if _img_source(cp)]
        if usable:
            groups.append(usable)
    return groups


def _forced_chip(iso: str) -> tuple[str | None, str | None]:
    """Chip for an origin the OPERATOR picked, e.g. "PL" -> ("FRA POLEN", "PL").

    Unknown code -> no chip. The flag set and the Norwegian names come from the
    same table the automatic path uses, so a forced chip can never print a
    country we have no flag for.
    """
    code = (iso or "").strip().upper()
    name = regions.NAME_NO.get(code)
    if not name:
        return (None, None)
    return (f"FRA {name}", code)


def _chip_for(picks, origin: str) -> tuple[str | None, str | None]:
    """Resolve the origin chip for one reel under the operator's setting.

    origin is one of:
      "none" (default) — never print an origin chip
      "auto"           — the old behaviour: chip only when EVERY product in the
                         reel shares one known origin (see _origin_chip)
      "<ISO>"          — force this origin on every reel of the run
    """
    o = (origin or "none").strip()
    if not o or o.lower() == "none":
        return (None, None)
    if o.lower() == "auto":
        return _origin_chip(picks)
    return _forced_chip(o)


def _origin_chip(picks) -> tuple[str | None, str | None]:
    """Return (chip_text, iso) ONLY when EVERY product shown in the reel shares
    the same mappable origin; otherwise (None, None).

    Accuracy over coverage: a reel shows several products at once, so a partial
    majority (e.g. 2 of 3 from Iran, 1 from Sweden) must NOT print "FRA IRAN" —
    that mislabels the Swedish product. So we require all picks to (a) have a
    known country code and (b) be identical. Any mix, or any missing code, means
    no chip at all — never guess on a mixed reel."""
    codes = [cp.country_code for cp in picks if cp.country_code]
    if not codes or len(codes) != len(picks) or len(set(codes)) != 1:
        return (None, None)
    name = regions.NAME_NO.get(codes[0])
    if not name:
        return (None, None)
    return (f"FRA {name}", codes[0])


@dataclass
class DropResult:
    assets: list[Path] = field(default_factory=list)


# A render task: (human label, top-level reel fn, positional args, kwargs). The
# fn + args must be picklable so the task can run in a separate process — reel
# functions are module-level and their args are paths / PIL images / numbers,
# all picklable. Kept at module scope so ProcessPoolExecutor can import it.
def _run_task(task) -> tuple[str, object]:
    label, fn, args, kwargs = task
    try:
        return (label, fn(*args, **kwargs))
    except Exception as e:  # noqa: BLE001
        return (label, RuntimeError(str(e)))


def _render_tasks(tasks: list) -> list[Path]:
    """Render each reel task, in PARALLEL across processes when there's more than
    one. Reels are independent and CPU-bound (per-frame PIL compositing holds the
    GIL), so threads wouldn't help but separate processes use the spare cores —
    a 5-reel drop finishes in roughly the time of its slowest reel instead of the
    sum. A single task runs inline to avoid process-spawn + model-load overhead.
    Order of `tasks` is preserved in the returned asset list."""
    if not tasks:
        return []
    # Say what is about to be rendered, before the slow part. The labels carry
    # the category and, for a slider, how many varer / sider it covers — so the
    # log answers "is my slider in this drop?" without hunting for file names.
    print(f"[social] rendrer {len(tasks)} reels:")
    for label, _fn, _a, _k in tasks:
        print(f"    · {label}")
    if len(tasks) == 1:
        results = [_run_task(tasks[0])]
    else:
        import os
        from concurrent.futures import ProcessPoolExecutor, as_completed

        workers = min(len(tasks), max(1, os.cpu_count() or 4))
        print(f"[social] {workers} parallelle prosesser")
        try:
            with ProcessPoolExecutor(max_workers=workers) as pool:
                # Submitted rather than mapped, so each reel can be announced as
                # it lands. `pool.map` returns nothing until the last one is
                # done, which on a 2-core runner with two dozen reels is many
                # minutes of total silence — indistinguishable, from the
                # dashboard, from a job that has died.
                futures = {pool.submit(_run_task, t): i for i, t in enumerate(tasks)}
                results = [None] * len(tasks)
                for finished, fut in enumerate(as_completed(futures), start=1):
                    idx = futures[fut]
                    results[idx] = fut.result()
                    print(f"[social] reel {finished}/{len(tasks)} ferdig: {tasks[idx][0]}",
                          flush=True)
        except Exception as e:  # noqa: BLE001 — pool unavailable → sequential
            print(f"[social] parallel render unavailable ({e}); rendering serially")
            results = []
            for i, t in enumerate(tasks, start=1):
                results.append(_run_task(t))
                print(f"[social] reel {i}/{len(tasks)} ferdig: {t[0]}", flush=True)

    assets: list[Path] = []
    for label, res in results:
        if isinstance(res, Exception):
            print(f"[social] {label} failed: {res}")
        elif res is not None:
            assets.append(Path(res))
    return assets


def build_social_drop(edition: Edition, outdir: Path, week_slug: str = "drop",
                      only_kampanje: bool = False,
                      title: str | None = None,
                      slider: bool = True,
                      slider_per_page: int = SLIDER_PER_PAGE,
                      slider_max: int = SLIDER_MAX_ITEMS,
                      origin: str = "none") -> DropResult:
    """Render the social assets for an edition.

    only_kampanje=True renders ONLY the offer (TILBUD) reel — used by the
    dashboard's "Lag tilbud annonse" button, which wants a focused offer ad
    (compare_at_price as førpris, product_type as ny pris), not the full montage
    + per-category set.

    `origin` decides the origin chip (the flag pill on a reel), and defaults to
    "none" — no chip unless the operator asks for one. "auto" restores the
    old automatic behaviour (chip only when every product in the reel shares one
    origin); an ISO-2 code like "PL" forces that origin on every reel of the run.

    slider=True (default) adds an EXTRA slider reel for every category holding
    more than `slider_per_page` products with photos — the normal 3-hero reel is
    still rendered for that category, unchanged. `slider_max` caps how many
    products one slider shows (a longer reel just doesn't get watched).

    `title`, when given, overrides the montage (intro) reel's headline — this is
    the operator's campaign line, e.g. "Vi introduserer mange varer fra Balkan".
    It's uppercased and wrapped to fit at render time; None keeps the default.

    All reels are rendered in parallel (see _render_tasks); this function only
    prepares each reel's inputs then hands the render calls off as tasks.
    """
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    all_cps = [cp for cat in edition.categories for cp in edition.by_category[cat]]
    tasks: list = []

    # 1) Montage reel — counts up to the number of new arrivals.
    #    (skipped for a tilbud-only ad — offers are shown by the kampanje reel.)
    if not only_kampanje:
        montage_cuts = []
        for cp in all_cps[:40]:  # cap for render time; wall samples cyclically anyway
            src = _img_source(cp)
            if src:
                try:
                    montage_cuts.append(cutout(src))
                except Exception:  # noqa: BLE001
                    continue
        if montage_cuts:
            montage_kwargs = {"count": edition.total_products,
                              "out": outdir / f"{week_slug}_montage.mp4"}
            if title and title.strip():
                montage_kwargs["heading"] = title.strip()
            tasks.append(("montage reel", R.reel_montage, (montage_cuts,),
                          montage_kwargs))

    # 2) Per-category reel (real photos, cluster-coherent). mp4 only — no PNG
    #    stories. Skip categories with no usable photo.
    #
    #    The 3-hero reel is UNCHANGED — it stays exactly as it is, for every
    #    category. A category with more than one page's worth of products ALSO
    #    gets an EXTRA slider reel: same beat, but it pages through every product
    #    instead of only the top 3 (the "we got 12 ice creams" case). Two files,
    #    same category, pick whichever suits the post.
    if not only_kampanje:
        for cat in edition.categories:
            cps = edition.by_category[cat]
            slug = _slug(cat)

            reel_picks = _cluster_picks(cps, 3)
            if reel_picks:
                chip_text, iso = _chip_for(reel_picks, origin)
                tasks.append((f"reel {cat}", R.reel_category,
                              ([_img_source(cp) for cp in reel_picks],),
                              {"heading": cat.upper(),
                               "out": outdir / f"{week_slug}_reel_{slug}.mp4",
                               "iso": iso, "chip_text": chip_text}))

            groups = _slider_groups(cps)
            n_usable = sum(len(g) for g in groups)
            if slider and n_usable > slider_per_page:
                pages = R.slider_pages(groups, per_page=slider_per_page,
                                       max_items=slider_max)
                shown = [cp for pg in pages for cp in pg]
                chip_text, iso = _chip_for(shown, origin)
                label = f"slider reel {cat} · {len(shown)} varer / {len(pages)} sider"
                if len(shown) < n_usable:
                    # Say it out loud: a silent cap reads as "everything is in
                    # the reel" when it isn't. The rest are still in the PDF.
                    print(f"[social] {cat}: slider viser {len(shown)} av {n_usable} "
                          f"varer (maks {slider_max}) — resten står i katalogen")
                    label += f" (kappet, {n_usable - len(shown)} utenfor)"
                tasks.append((label, R.reel_slider,
                              ([[_img_source(cp) for cp in pg] for pg in pages],),
                              {"heading": cat.upper(),
                               "out": outdir / f"{week_slug}_slider_{slug}.mp4",
                               "iso": iso, "chip_text": chip_text}))

    # 3) Kampanje reels — ONE PER OFFER PRODUCT. Each offer has its own førpris
    #    and ny pris, so they can never share a reel: a single reel can only
    #    print one price pair, which would mislabel every other product in it.
    #    Both hero slots show the SAME product (two angles/sizes of one item),
    #    exactly like a single-product offer ad.
    tilbud = [cp for cp in all_cps
              if cp.state == State.TILBUD and _img_source(cp)
              and cp.product.compare_at_price and cp.product.price_value]
    for i, cp in enumerate(tilbud, start=1):
        try:
            src = _img_source(cp)
            a, _ = prep_safe(src, 560, -7)
            b, _ = prep_safe(src, 470, 8)
            name = f"{week_slug}_kampanje_{i:02d}_{_slug(cp.product.title)[:40]}.mp4"
            tasks.append((f"kampanje reel · {cp.product.title}", R.reel_kampanje, (a, b),
                          {"new_price": cp.product.price_value,
                           "old_price": cp.product.compare_at_price,
                           "out": outdir / name,
                           "title": title}))
        except Exception as e:  # noqa: BLE001
            print(f"[social] kampanje reel prep failed for {cp.product.title}: {e}")

    return DropResult(assets=_render_tasks(tasks))


def _slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "cat"
