"""One-off: focused NUT drop (catalogue PDF + reels) via force_ids.

Manual ad mode — never commits an inventory baseline. Selects the recent nut
batch precisely by created-date window + a nut/seed/dried-fruit allowlist,
drops out-of-stock items, dedupes duplicate listings (keep highest qty), and
excludes the separate Jun-26 frozen-dessert drop.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from nordic_catalogue.ai_category import classify_products
from nordic_catalogue.catalogue import build_pdf, week_label
from nordic_catalogue.config import CONFIG
from nordic_catalogue.drops import new_drop_dir
from nordic_catalogue.model_a import build_edition
from nordic_catalogue.imageio import cache_product_image
from nordic_catalogue.shopify_client import ShopifyClient
from nordic_social.generate import build_social_drop

# The nut/seed/dried-fruit batch landed from Jun 23 onward.
SINCE = datetime(2026, 6, 23, tzinfo=timezone.utc)

# Allowlist: nut / seed / dried-fruit keywords (lowercase substrings).
NUT_TERMS = [
    "walnut", "cashew", "hazelnut", "pistachio", "pumpkin seed", "nuts mix",
    "nut mix", "almond", "peanut", "macadamia", "chickpea", "apricot",
    "date", "mazafati", "raisin", "fig", "pecan", "brazil nut", "pine nut",
    "sunflower seed", "seed", "nøtt", "mandel", "rosin",
]
# Hard excludes (the separate frozen-dessert drop, etc.).
EXCLUDE_TERMS = ["frozen dessert", "friends of asian", "ice cream", "is "]


def is_nut(p) -> bool:
    hay = f"{p.title} {p.vendor}".lower()
    if any(x in hay for x in EXCLUDE_TERMS):
        return False
    return any(t in hay for t in NUT_TERMS)


def main() -> int:
    client = ShopifyClient()
    print(f"[shopify] fetching products from {CONFIG.store_domain} ...")
    products = client.fetch_products()
    print(f"[shopify] {len(products)} products fetched")

    sales: dict[str, int] = {}
    try:
        sales = client.product_sales()
    except Exception:  # noqa: BLE001
        pass

    # 1) recent batch + nut allowlist + in stock
    cand = [p for p in products
            if p.created_at >= SINCE and is_nut(p) and p.inventory_quantity >= 1]

    # 2) dedupe by normalised title — keep the highest-stock listing
    best: dict[str, object] = {}
    for p in sorted(cand, key=lambda x: -x.inventory_quantity):
        key = p.title.strip().lower()
        if key not in best:
            best[key] = p
    chosen = list(best.values())
    chosen.sort(key=lambda x: (x.created_at, x.title))

    print(f"\n[nut-drop] {len(chosen)} products selected:")
    for p in chosen:
        print(f"    · {p.title}  (qty {p.inventory_quantity}, "
              f"{p.created_at:%Y-%m-%d}, {p.vendor or '—'})")
    # Show what got dropped for out-of-stock / dedupe transparency
    oos = [p for p in products if p.created_at >= SINCE and is_nut(p)
           and p.inventory_quantity < 1]
    if oos:
        print(f"\n[nut-drop] excluded (out of stock):")
        for p in oos:
            print(f"    × {p.title}  (qty {p.inventory_quantity})")

    if not chosen:
        print("No nut products matched — nothing generated.")
        return 0

    force_ids = {p.id for p in chosen}
    cluster_of = classify_products(chosen)
    edition = build_edition(products, {}, True, sales=sales,
                            cluster_of=cluster_of, force_ids=force_ids)

    print(f"\n[images] caching {len(chosen)} images ...")
    for p in chosen:
        cache_product_image(p)

    drop = new_drop_dir()
    week = week_label()
    pdf = build_pdf(edition, drop / "katalog.pdf", week=week, cta_url=CONFIG.cta_url)
    print(f"catalogue PDF: {pdf}")
    result = build_social_drop(edition, drop, week_slug="notter")
    print(f"\nnut drop written: 1 PDF + {len(result.assets)} mp4 -> {drop}")
    for a in result.assets:
        print(f"    {a.name}")
    print("\n(manual mode — no inventory baseline committed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
