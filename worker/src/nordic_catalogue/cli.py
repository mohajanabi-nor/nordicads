"""Catalogue worker CLI.

    python -m nordic_catalogue.cli generate            # real Shopify data
    python -m nordic_catalogue.cli generate --mock     # offline, prototype data
    python -m nordic_catalogue.cli check               # verify Shopify auth/scopes
"""
from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

from .catalogue import build_pdf, week_label
from .config import CONFIG
from .model_a import Edition, build_edition
from .snapshot import SnapshotStore


def _week_slug(today: date | None = None) -> str:
    today = today or date.today()
    iso = today.isocalendar()
    return f"uke{iso.week}-{iso.year}"


def _default_out() -> Path:
    # One combined multi-page PDF per drop, in its own folder.
    return CONFIG.output_dir / "katalog" / f"{_week_slug()}.pdf"


def _ai_clusters(edition_products):
    """Give each edition product an internal varetype label (cached).

    These labels do NOT create categories — they only cluster like items
    next to each other inside each existing (collection-based) category.
    """
    from .ai_category import classify_products

    return classify_products(edition_products)


def cmd_generate(args: argparse.Namespace) -> int:
    out = Path(args.out) if args.out else _default_out()
    week = week_label()

    if args.mock:
        from .mockdata import mock_products

        products = mock_products()
        print(f"[mock] {len(products)} products")
        store = SnapshotStore(CONFIG.snapshot_db) if args.commit else None
        first_run = store.is_first_run() if store else True
        prev = store.previous_quantities() if store else {}
        edition = build_edition(products, prev, first_run, sales={})
    else:
        from .imageio import cache_product_image
        from .shopify_client import ShopifyClient

        client = ShopifyClient()
        print(f"[shopify] fetching products from {CONFIG.store_domain} ...")
        products = client.fetch_products()
        print(f"[shopify] {len(products)} products fetched")

        sales: dict[str, int] = {}
        try:
            sales = client.product_sales()
            print(f"[shopify] sales signals for {len(sales)} products")
        except Exception as e:  # noqa: BLE001
            print(f"[shopify] orders unavailable ({e}); ranking without sales")

        store = SnapshotStore(CONFIG.snapshot_db)
        first_run = store.is_first_run()
        prev = store.previous_quantities()

        # Category structure is collection-based and UNCHANGED. Show the
        # operator which collections are kept vs excluded before trusting them.
        _category_audit(products)

        # Pass 1: find which products enter the edition (gate only).
        probe = build_edition(products, prev, first_run, sales=sales)
        edition_products = [cp.product for cps in probe.by_category.values() for cp in cps]

        # Pass 2: AI labels each edition product with a varetype, used ONLY to
        # cluster like items inside each (unchanged) category. No new headings.
        print(f"[ai] labelling {len(edition_products)} edition products for clustering ...")
        cluster_of = _ai_clusters(edition_products)
        edition = build_edition(products, prev, first_run, sales=sales,
                                cluster_of=cluster_of)

        # Download images ONLY for products that made the edition (perf).
        print(f"[images] caching {len(edition_products)} edition product images ...")
        for p in edition_products:
            cache_product_image(p)

    _report(edition, first_run)
    if edition.total_products == 0:
        print("Nothing arrived since last snapshot — no catalogue generated.")
        if not args.mock and args.commit:
            store.commit_run((p.sku, p.inventory_quantity) for p in products)
        return 0

    build_pdf(edition, out, week=week, cta_url=CONFIG.cta_url, save_pngs=args.save_pngs)
    print(f"PDF written: {out}")

    # Commit the new snapshot AFTER classification (so next run compares correctly).
    if args.commit and not args.mock:
        rid = store.commit_run((p.sku, p.inventory_quantity) for p in products)
        print(f"snapshot committed (run {rid})")
    elif args.mock and store is not None:
        store.commit_run((p.sku, p.inventory_quantity) for p in products)
    return 0


def cmd_check(_args: argparse.Namespace) -> int:
    from .shopify_client import ShopifyClient, ShopifyError

    try:
        client = ShopifyClient()
        n = 0
        for _ in client.iter_products():
            n += 1
            if n >= 1:
                break
        print(f"OK: authenticated to {CONFIG.store_domain}; products readable.")
        return 0
    except ShopifyError as e:
        print(f"FAILED: {e}")
        return 1


def _category_audit(products) -> None:
    """Print kept vs excluded collections (categories) for confirmation."""
    from .model_a import category_audit

    audit = category_audit(products, CONFIG)
    kept, excluded = audit["kept"], audit["excluded"]
    print(f"[categories] {len(kept)} kept (collection-based) — confirm before trusting:")
    for title, cnt, _reason in kept:
        print(f"    {cnt:>5}  {title}")
    if excluded:
        print(f"[categories] {len(excluded)} excluded:")
        for title, cnt, reason in excluded:
            print(f"    {cnt:>5}  {title}  ({reason})")


def _report(edition: Edition, first_run: bool) -> None:
    print(f"first_run={first_run} | categories={len(edition.categories)} | "
          f"products={edition.total_products} | countries={edition.country_codes}")
    for cat in edition.categories:
        cps = edition.by_category[cat]
        states: dict[str, int] = {}
        for cp in cps:
            states[cp.state.value] = states.get(cp.state.value, 0) + 1
        # Show clusters in display order (best-selling cluster first) so the
        # operator can confirm like items sit next to each other.
        clusters: list[str] = []
        for cp in cps:
            lbl = cp.type_label or "—"
            if not clusters or clusters[-1] != lbl:
                clusters.append(lbl)
        print(f"  {cat}: {len(cps)} {states}  clusters: {' › '.join(clusters)}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nordic-catalogue")
    sub = parser.add_subparsers(dest="command", required=True)

    g = sub.add_parser("generate", help="generate the catalogue PDF")
    g.add_argument("--mock", action="store_true", help="use offline mock data")
    g.add_argument("--out", help="output PDF path")
    g.add_argument("--save-pngs", action="store_true", help="also save per-page PNGs")
    g.add_argument("--no-commit", dest="commit", action="store_false",
                   help="do not write the inventory snapshot")
    g.set_defaults(commit=True, func=cmd_generate)

    c = sub.add_parser("check", help="verify Shopify auth/scopes")
    c.set_defaults(func=cmd_check)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
