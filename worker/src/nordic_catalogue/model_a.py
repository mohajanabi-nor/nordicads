"""Modell A: decide what enters the edition + classify each product.

Gate (BUILD-SPEC §2):
  - Brand-new product (created_at < NEW_WINDOW_DAYS) -> in edition (NYHET).
  - RESTOCK = a real inventory INCREASE vs the previous snapshot (current > prev).
    Sales / stock reductions never qualify. With no baseline (first run, or a
    never-recorded SKU) we cannot prove an increase, so only NYHET enters — the
    run commits a baseline so the next drop's diff is precise.
Classification (winner order): TILBUD (compare_at_price set) > NYHET (new) > RESTOCK.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from .config import CONFIG, Config
from .models import ClassifiedProduct, Product, State, now_utc
from .regions import country_to_iso

# Category priority (slugs). Frysevarer + Kjølevarer pinned on top (§4).
PRIORITY_SLUGS = ["frysevarer", "kjolevarer", "kjølevarer"]
FALLBACK_CATEGORY = "Andre nyheter"

# Structural / non-category collections in the real store (always excluded).
STRUCTURAL_EXCLUDE_SLUGS = {
    "hovedside", "startside", "meny", "back-to-stock",
    "ultimate-search-bestseller-collection-do-not-delete",
}
# Any collection covering more than this share of ALL products is structural
# (e.g. Hovedside ~99%, Siste Ankomst ~60%) -> auto-excluded as a category.
AUTO_EXCLUDE_SHARE = 0.40


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")  # ø->o, å->a stripped accents
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text


@dataclass
class Edition:
    """The fully resolved edition, ready for the PDF generator."""

    categories: list[str] = field(default_factory=list)  # ordered category titles
    by_category: dict[str, list[ClassifiedProduct]] = field(default_factory=dict)
    country_codes: list[str] = field(default_factory=list)  # ISO-2, most products first
    first_run: bool = False

    @property
    def total_products(self) -> int:
        return sum(len(v) for v in self.by_category.values())


def brand_key(product: Product) -> str:
    """Stable brand identity for adjacency: the vendor when present, else the
    first significant token of the title. Keeps same-brand items together even
    when the vendor field is blank (e.g. 'Monster ...' stays with 'Monster')."""
    v = (product.vendor or "").strip()
    if v:
        return slugify(v)
    for tok in (product.title or "").split():
        s = slugify(tok)
        if len(s) >= 3:
            return s
    return slugify(product.title or "") or "_"


def is_new(product: Product, now: datetime, window_days: int) -> bool:
    return product.created_at >= now - timedelta(days=window_days)


def classify_state(product: Product, now: datetime, window_days: int) -> State:
    if product.is_offer:
        return State.TILBUD
    if is_new(product, now, window_days):
        return State.NYHET
    return State.RESTOCK


def _arrived(product: Product, previous_qty: dict[str, int], first_run: bool,
             now: datetime, window_days: int, restock_window_days: int,
             restock_min_increase: int = 1) -> bool:
    # 1) Brand-new products always qualify (they become NYHET).
    if is_new(product, now, window_days):
        return True
    # 2) RESTOCK only on a proven, MEANINGFUL inventory increase vs the previous
    #    snapshot. A decrease (a sale), an unchanged level, or a trivial +1/+2
    #    blip never qualifies — the stock-up has to be real (>= min increase).
    if not first_run and product.sku in previous_qty:
        if product.inventory_quantity - previous_qty[product.sku] < max(1, restock_min_increase):
            return False
        # The increase is real; only surface it if the stock level actually
        # changed within the window (guards against stale/uncommitted diffs).
        iua = product.inventory_updated_at
        if iua is not None and iua < now - timedelta(days=restock_window_days):
            return False
        return True
    # 3) No baseline for this SKU (first run / never recorded): we cannot prove
    #    an increase, so it does NOT enter as a restock. The run commits a
    #    baseline so the next drop can detect this SKU's increases precisely.
    return False


def compute_excluded_slugs(products: list[Product], cfg: Config) -> set[str]:
    """Slugs to exclude as categories: env list + structural + auto-share."""
    excluded = {slugify(s) for s in cfg.exclude_collections} | set(cfg.exclude_collections)
    excluded |= STRUCTURAL_EXCLUDE_SLUGS
    total = max(1, len(products))
    counts: dict[str, int] = {}
    for p in products:
        for title in p.collections:
            s = slugify(title)
            counts[s] = counts.get(s, 0) + 1
    for s, c in counts.items():
        if c / total > AUTO_EXCLUDE_SHARE:
            excluded.add(s)
    return excluded


def category_audit(products: list[Product], cfg: Config) -> dict[str, list[tuple[str, int, str]]]:
    """Audit collections so the operator can confirm categories before trusting them.

    Returns {"kept": [...], "excluded": [...]} where each entry is
    (display_title, product_count, reason). Counts are over ALL products.
    """
    deny = {slugify(s) for s in cfg.exclude_collections} | set(cfg.exclude_collections)
    deny |= STRUCTURAL_EXCLUDE_SLUGS
    total = max(1, len(products))

    counts: dict[str, int] = {}
    title_for: dict[str, str] = {}
    for p in products:
        for title in p.collections:
            s = slugify(title)
            counts[s] = counts.get(s, 0) + 1
            title_for.setdefault(s, title)

    kept: list[tuple[str, int, str]] = []
    excluded: list[tuple[str, int, str]] = []
    for s, c in sorted(counts.items(), key=lambda kv: -kv[1]):
        title = title_for[s]
        if s in deny:
            excluded.append((title, c, "deny-list"))
        elif c / total > AUTO_EXCLUDE_SHARE:
            excluded.append((title, c, f"auto >{int(AUTO_EXCLUDE_SHARE * 100)}%"))
        else:
            kept.append((title, c, "category"))
    return {"kept": kept, "excluded": excluded}


def resolve_category(product: Product, excluded_slugs: set[str],
                     order_index: dict[str, int]) -> Optional[str]:
    """Pick the product's category collection (highest priority), or None."""
    candidates = []
    for title in product.collections:
        s = slugify(title)
        if s in excluded_slugs:
            continue
        candidates.append((title, s))
    if not candidates:
        return None

    def rank(item: tuple[str, str]) -> tuple[int, int]:
        _, s = item
        if s in PRIORITY_SLUGS:
            return (0, PRIORITY_SLUGS.index(s))
        return (1, order_index.get(s, 9999))

    candidates.sort(key=rank)
    return candidates[0][0]


def build_edition(
    products: list[Product],
    previous_qty: dict[str, int],
    first_run: bool,
    sales: Optional[dict[str, int]] = None,
    cfg: Config = CONFIG,
    now: Optional[datetime] = None,
    cluster_of: Optional[dict[str, str]] = None,
    force_ids: Optional[set[str]] = None,
    deny_terms: Optional[set[str]] = None,
    min_category_size: int = 1,
) -> Edition:
    """Build the edition.

    Category structure is UNCHANGED (collection-based). `cluster_of`
    ({product_id: AI varetype label}) does NOT create categories — it only
    clusters like items next to each other inside each existing category, with
    the best-selling cluster first and sales order kept inside a cluster.

    `force_ids`: manual-ad mode. When given, the arrival gate is bypassed and
    EXACTLY the products whose id is in the set enter the edition (still
    classified + clustered + categorised normally). Pass the full product list
    so category exclusion/order are computed over the whole store.

    `deny_terms`: lowercase substrings; any product whose "title vendor" matches
    one is dropped from the edition entirely (e.g. {"golden cow"}). Applies in
    both gated and force_ids modes.

    `min_category_size`: categories ending up with fewer than this many products
    are dropped from the edition (keeps the drop punchy — no 1-2 SKU reels).
    """
    now = now or now_utc()
    sales = sales or {}
    cluster_of = cluster_of or {}

    excluded_slugs = compute_excluded_slugs(products, cfg)

    # Global category display order = first appearance across all products.
    order_index: dict[str, int] = {}
    for p in products:
        for title in p.collections:
            s = slugify(title)
            if s in excluded_slugs:
                continue
            order_index.setdefault(s, len(order_index))

    by_category: dict[str, list[ClassifiedProduct]] = {}
    country_counter: dict[str, int] = {}

    deny_terms = {t for t in (deny_terms or set()) if t}

    for p in products:
        if deny_terms:
            hay = f"{p.title} {p.vendor}".lower()
            if any(t in hay for t in deny_terms):
                continue
        if force_ids is not None:
            if p.id not in force_ids:
                continue
        else:
            # Automatic gate: never advertise out-of-stock items, and only let in
            # brand-new products or proven meaningful restocks.
            if p.inventory_quantity < cfg.min_stock:
                continue
            if not _arrived(p, previous_qty, first_run, now, cfg.new_window_days,
                            cfg.restock_window_days, cfg.restock_min_increase):
                continue
        state = classify_state(p, now, cfg.new_window_days)
        category = resolve_category(p, excluded_slugs, order_index) or FALLBACK_CATEGORY
        iso = country_to_iso(p.country_name)
        cp = ClassifiedProduct(
            product=p,
            state=state,
            category=category,
            country_code=iso,
            rank_score=float(sales.get(p.id, 0)),
            type_label=cluster_of.get(p.id),
        )
        by_category.setdefault(category, []).append(cp)
        if iso:
            country_counter[iso] = country_counter.get(iso, 0) + 1

    # Intra-category ordering: cluster like varetypes AND like brands together.
    # Two stable passes:
    #   1) sales desc (then newest, then has-image)   -> ranks items globally
    #   2) by (varetype, brand) first appearance       -> groups same type+brand
    # Pass 2 is stable, so the best-selling group lands first and, inside a
    # group, the sales order from pass 1 holds. This keeps e.g. all Monster
    # together and all Fanta together, never "Monster - Fanta - Monster".
    for cps in by_category.values():
        cps.sort(
            key=lambda c: (
                -c.rank_score,
                -c.product.created_at.timestamp(),
                0 if (c.product.image_url or c.product.image_path) else 1,
            )
        )
        group_first: dict[tuple[str, str], int] = {}
        for c in cps:
            gkey = (c.type_label or "_", brand_key(c.product))
            group_first.setdefault(gkey, len(group_first))
        cps.sort(key=lambda c: group_first[(c.type_label or "_", brand_key(c.product))])

    # Category order is UNCHANGED: priority pins first, then first-appearance.
    def cat_key(title: str) -> tuple[int, int]:
        s = slugify(title)
        if s in PRIORITY_SLUGS:
            return (0, PRIORITY_SLUGS.index(s))
        if title == FALLBACK_CATEGORY:
            return (2, 0)  # uncategorised last
        return (1, order_index.get(s, 9999))

    # Drop thin categories (keeps the drop punchy — no 1-2 SKU reels). Prune
    # by_category too so totals/montage stay consistent with the rendered set.
    if min_category_size > 1:
        thin = [c for c, items in by_category.items() if len(items) < min_category_size]
        for c in thin:
            del by_category[c]

    categories = sorted([c for c in by_category if by_category[c]], key=cat_key)

    country_codes = [c for c, _ in sorted(country_counter.items(), key=lambda kv: -kv[1])]

    return Edition(
        categories=categories,
        by_category=by_category,
        country_codes=country_codes,
        first_run=first_run,
    )
