"""Drop worker CLI — produces ONE folder per drop with everything in it.

    python -m nordic_social.cli generate            # real Shopify data
    python -m nordic_social.cli generate --mock     # offline, prototype data
    python -m nordic_social.cli select samyang calypso fanta   # manual ad

A "drop" = one dated folder (output/drop_YYYY-MM-DD[_N]/) holding the catalogue
PDF (katalog.pdf) AND every social mp4 for that drop. Output is video-only: no
PNG stories or debug PNGs. The real `generate` run commits an inventory baseline
so the next drop can detect restocks precisely.
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

from nordic_catalogue.catalogue import build_pdf, week_label
from nordic_catalogue.config import CONFIG
from nordic_catalogue.drops import new_drop_dir
from nordic_catalogue.model_a import Edition, build_edition
from nordic_catalogue.snapshot import SnapshotStore

from .generate import build_social_drop


def _week_slug(today: date | None = None) -> str:
    today = today or date.today()
    iso = today.isocalendar()
    return f"uke{iso.week}-{iso.year}"


def _build_real_edition(commit: bool, cache_images: bool = True,
                        deny_terms: set[str] | None = None,
                        min_category_size: int = 1):
    """Fetch Shopify, build the clustered edition, optionally cache images.
    Returns (edition, products, store, first_run). Caller commits the baseline.

    cache_images=False skips the heavy image downloads — used by the read-only
    `preview` command, which never renders and so needs no local image files.
    deny_terms / min_category_size are passed straight to build_edition."""
    from nordic_catalogue.ai_category import classify_products
    from nordic_catalogue.imageio import cache_product_image
    from nordic_catalogue.shopify_client import ShopifyClient

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

    # Probe applies the deny-list (so denied items are never even classified)
    # but NOT the min-category prune — clustering wants the full set; the prune
    # is a final-edition concern.
    probe = build_edition(products, prev, first_run, sales=sales,
                          deny_terms=deny_terms)
    edition_products = [cp.product for cps in probe.by_category.values() for cp in cps]
    print(f"[ai] labelling {len(edition_products)} edition products for clustering ...")
    cluster_of = classify_products(edition_products)
    edition = build_edition(products, prev, first_run, sales=sales,
                            cluster_of=cluster_of, deny_terms=deny_terms,
                            min_category_size=min_category_size)

    if cache_images:
        keep = [cp.product for cps in edition.by_category.values() for cp in cps]
        print(f"[images] caching {len(keep)} edition product images ...")
        for p in keep:
            cache_product_image(p)
    return edition, products, store, first_run


def _deny_terms(args: argparse.Namespace) -> set[str]:
    """Collect lowercase deny substrings from repeated --deny flags."""
    return {t.strip().lower() for t in (getattr(args, "deny", None) or []) if t.strip()}


def cmd_generate(args: argparse.Namespace) -> int:
    week = week_label()
    slug = _week_slug()
    deny = _deny_terms(args)
    min_cat = getattr(args, "min_category_size", 1)

    store = products = None
    if args.mock:
        from nordic_catalogue.mockdata import mock_products

        products = mock_products()
        print(f"[mock] {len(products)} products")
        edition = build_edition(products, {}, True, sales={},
                                deny_terms=deny, min_category_size=min_cat)
    else:
        edition, products, store, first_run = _build_real_edition(
            args.commit, deny_terms=deny, min_category_size=min_cat)

    _report(edition)
    if edition.total_products == 0:
        print("Nothing arrived since last snapshot — no drop generated.")
        if store is not None and args.commit:
            store.commit_run((p.sku, p.inventory_quantity) for p in products)
            print("snapshot baseline committed")
        return 0

    # Allocate the ONE drop folder only now that we know there is content — this
    # is the single new_drop_dir() call for the run, so the catalogue PDF and
    # every mp4 below land together and nothing is ever split or left empty.
    drop = Path(args.out) if args.out else new_drop_dir()

    # Everything for this drop lands in ONE folder.
    pdf = build_pdf(edition, drop / "katalog.pdf", week=week, cta_url=CONFIG.cta_url)
    print(f"catalogue PDF: {pdf}")

    # Commit the inventory baseline NOW — BEFORE the heavy reel render — so the
    # restock baseline is never lost if reel encoding fails or is interrupted.
    # Restock detection depends on this snapshot, not on the mp4s, so it must not
    # be gated behind them. (Shopify exposes no adjustment ledger, so an
    # increase-vs-baseline diff is the only precise restock signal — and that
    # diff is only possible once a baseline exists.)
    if store is not None and args.commit:
        rid = store.commit_run((p.sku, p.inventory_quantity) for p in products)
        print(f"snapshot baseline committed (run {rid})")

    result = build_social_drop(edition, drop, week_slug=slug)
    extra = _render_vm_hero(args, products, drop, slug)
    n_assets = len(result.assets) + (1 if extra else 0)
    print(f"drop written: 1 PDF + {n_assets} mp4 -> {drop}")
    for a in result.assets:
        print(f"    {a.name}")
    if extra:
        print(f"    {extra.name}  (special VM-drikker hero)")
    return 0


def _render_vm_hero(args, products, drop: Path, slug: str):
    """Render the special football 'VM-drikker' hero reel into the drop folder.
    Selects up to 5 products by the comma-separated --vm-hero name terms (first
    title match per term, image cached on demand). Returns the path or None."""
    terms_raw = getattr(args, "vm_hero", None)
    if not terms_raw or not products:
        return None
    from nordic_catalogue.imageio import cache_product_image
    from .reel import reel_vm_squad

    terms = [t.strip().lower() for t in terms_raw.split(",") if t.strip()]
    chosen, used = [], set()
    for t in terms:
        for p in products:
            if p.id in used:
                continue
            if t in p.title.lower():
                chosen.append(p)
                used.add(p.id)
                break
    sources = []
    for p in chosen:
        try:
            cache_product_image(p)
        except Exception:  # noqa: BLE001
            pass
        src = p.image_path or p.image_url
        if src:
            sources.append(src)
    print(f"[vm-hero] matched {len(sources)}/{len(terms)} drinks: "
          + ", ".join(p.title for p in chosen))
    if len(sources) < 2:
        print("[vm-hero] need >=2 drinks with images — special ad skipped")
        return None
    out = drop / f"{slug}_vm_drikker.mp4"
    reel_vm_squad(sources, out)
    return out


def _parse_ids(raw: str | None) -> set[str]:
    """Split a comma/space/newline-separated id blob into a clean set."""
    if not raw:
        return set()
    parts = re.split(r"[\s,]+", raw.strip())
    return {p.strip() for p in parts if p.strip()}


def cmd_select(args: argparse.Namespace) -> int:
    """Manual ad: pick products by name OR by explicit id → PDF + reels for
    ONLY those items. `--ids` (comma/space separated Shopify GIDs) is what the
    dashboard product-picker uses; positional terms remain for CLI convenience.
    Either selector works; ids win when both are given."""
    from concurrent.futures import ThreadPoolExecutor

    from nordic_catalogue.ai_category import classify_products
    from nordic_catalogue.imageio import cache_product_image
    from nordic_catalogue.shopify_client import ShopifyClient

    terms = [t.strip().lower() for t in (args.query or []) if t.strip()]
    ids = _parse_ids(getattr(args, "ids", None))
    if not terms and not ids:
        print("Provide search terms or --ids, e.g. select samyang  |  select --ids gid://…,gid://…")
        return 2

    client = ShopifyClient()
    # Fast path: when the picker sends explicit ids we fetch ONLY those (one
    # nodes() request) instead of paging the whole 5000+ catalogue. Term search
    # still needs the full list to scan titles, so it keeps the paginated fetch.
    if ids:
        print(f"[shopify] fetching {len(ids)} selected products from {CONFIG.store_domain} ...")
        products = client.fetch_products_by_ids(list(ids))
    else:
        print(f"[shopify] fetching products from {CONFIG.store_domain} ...")
        products = client.fetch_products()
    sel = f"{len(ids)} ids" if ids else f"terms {terms}"
    print(f"[shopify] {len(products)} products fetched; matching {sel} ...")

    # Manual selection never ranks by sales (force_ids bypasses ranking), so we
    # skip the expensive all-orders scan entirely.
    sales: dict[str, int] = {}

    def matches(p) -> bool:
        if ids:
            return p.id in ids
        hay = f"{p.title} {p.vendor}".lower()
        return any(t in hay for t in terms)

    match = [p for p in products if matches(p)]
    print(f"[select] {len(match)} products matched")

    # --tilbud: focused offer ad. Keep ONLY the matched products that are on
    # offer (compare_at_price set = førpris) so the kampanje reel shows real
    # deals; an offer ad over non-offer products would be a lie.
    tilbud_mode = bool(getattr(args, "tilbud", False))
    if tilbud_mode:
        offers = [p for p in match if p.is_offer]
        print(f"[select] tilbud mode — {len(offers)}/{len(match)} matched are on offer")
        match = offers

    for p in match[:40]:
        print(f"    · {p.title}")
    if not match:
        print("No products matched — nothing generated.")
        return 0

    force_ids = {p.id for p in match}
    cluster_of = classify_products(match)
    edition = build_edition(products, {}, True, sales=sales,
                            cluster_of=cluster_of, force_ids=force_ids)

    print(f"[images] caching {len(match)} edition product images ...")
    # Image caching is network-bound (download per product), so run it in
    # parallel — the GIL doesn't block HTTP waits, and each cutout/cache file is
    # keyed independently, so concurrent writes are safe.
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(cache_product_image, match))

    drop = Path(args.out) if args.out else new_drop_dir()
    week = week_label()
    pdf = build_pdf(edition, drop / "katalog.pdf", week=week, cta_url=CONFIG.cta_url)
    print(f"catalogue PDF: {pdf}")
    # tilbud mode renders ONLY the kampanje (offer) reel; the normal manual
    # ad renders the full montage + per-category set.
    result = build_social_drop(edition, drop,
                               week_slug="tilbud" if tilbud_mode else "utvalg",
                               only_kampanje=tilbud_mode,
                               title=getattr(args, "title", None))
    label = "tilbud" if tilbud_mode else "manual"
    print(f"{label} drop written: 1 PDF + {len(result.assets)} mp4 -> {drop}")
    for a in result.assets:
        print(f"    {a.name}")
    # Manual ad — never commits an inventory baseline.
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    """Emit baseline + config status as JSON for the dashboard. Read-only:
    touches no Shopify, renders nothing, commits nothing."""
    import json

    store = SnapshotStore(CONFIG.snapshot_db)
    try:
        payload = {
            "store_domain": CONFIG.store_domain,
            "output_dir": str(CONFIG.output_dir),
            "baseline": {
                "is_first_run": store.is_first_run(),
                "last_run": store.latest_run(),  # {id, ts, item_count} | null
            },
            "config": {
                "new_window_days": CONFIG.new_window_days,
                "restock_window_days": CONFIG.restock_window_days,
            },
        }
    finally:
        store.close()
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def _inclusion_reason(cp) -> str:
    """Human-readable 'why is this in the edition' string for the preview.
    Mirrors the Modell A gate (TILBUD > NYHET > RESTOCK) using only fields the
    edition already carries — no snapshot re-query, so it stays read-only."""
    from nordic_catalogue.models import State

    p = cp.product
    if cp.state == State.TILBUD:
        if p.compare_at_price:
            return f"Tilbud — førpris kr {p.compare_at_price:.2f}".replace(".", ",")
        return "Tilbud — nedsatt pris"
    if cp.state == State.NYHET:
        try:
            return f"Nyhet — lagt til {p.created_at:%d.%m.%Y}"
        except Exception:  # noqa: BLE001
            return "Nyhet — nylig opprettet"
    return "Restock — lagerbeholdning økt vs forrige snapshot"


def _edition_payload(edition: Edition, *, mode: str, week: str) -> dict:
    """Serialise the resolved edition into the dashboard preview contract
    (§4.1): categories -> products with classification + reason. Read-only."""
    from collections import Counter

    from nordic_catalogue.models import State

    states: Counter = Counter()
    categories = []
    for title in edition.categories:
        items = []
        for cp in edition.by_category.get(title, []):
            states[cp.state] += 1
            p = cp.product
            items.append({
                "id": p.id,
                "title": p.title,
                "vendor": p.vendor,
                "price_label": p.price_label,
                "state": cp.state.value,
                "reason": _inclusion_reason(cp),
                "category": cp.category,
                "country_code": cp.country_code,
                "type_label": cp.type_label,
                "image_url": p.image_url,
                "inventory_quantity": p.inventory_quantity,
            })
        categories.append({"title": title, "count": len(items), "products": items})

    return {
        "mode": mode,
        "week": week,
        "first_run": edition.first_run,
        "store_domain": CONFIG.store_domain,
        "country_codes": edition.country_codes,
        "totals": {
            "products": edition.total_products,
            "categories": len(edition.categories),
            "nyhet": states.get(State.NYHET, 0),
            "restock": states.get(State.RESTOCK, 0),
            "tilbud": states.get(State.TILBUD, 0),
        },
        "categories": categories,
    }


def cmd_preview(args: argparse.Namespace) -> int:
    """Dry-run the edition and emit it as JSON — classify what WOULD ship,
    without rendering a PDF, encoding any reel, or committing a baseline.
    Lets the dashboard answer 'why is/ isn't X in this drop' before render."""
    import json

    week = week_label()
    deny = _deny_terms(args)
    min_cat = getattr(args, "min_category_size", 1)
    if args.mock:
        from nordic_catalogue.mockdata import mock_products

        products = mock_products()
        print(f"[mock] {len(products)} products")
        edition = build_edition(products, {}, True, sales={},
                                deny_terms=deny, min_category_size=min_cat)
        mode = "mock"
    else:
        # Read-only: skip image caching, and never commit (no store.commit_run).
        edition, _products, store, _first = _build_real_edition(
            commit=False, cache_images=False, deny_terms=deny,
            min_category_size=min_cat)
        if store is not None:
            store.close()
        mode = "real"

    _report(edition)
    payload = _edition_payload(edition, mode=mode, week=week)
    print("PREVIEW_JSON " + json.dumps(payload, ensure_ascii=False))
    return 0


def cmd_products(args: argparse.Namespace) -> int:
    """Emit a JSON list of store products for the dashboard product-picker.

    Read-only: touches no snapshot, renders nothing, commits nothing. Sorted
    most-recently-EDITED first (updatedAt, falling back to createdAt) so the
    operator sees 'whatever was just priced/updated' at the top. Optional
    `--since DAYS` keeps only products edited/created within the window; `--limit`
    caps the payload; `--query` filters by title/vendor substring."""
    import json
    from datetime import timedelta

    from nordic_catalogue.models import now_utc
    from nordic_catalogue.regions import country_to_iso
    from nordic_catalogue.shopify_client import ShopifyClient

    now = now_utc()
    since_days = getattr(args, "since", None)

    # Push windowing to Shopify: a restock or a new product both bump updatedAt,
    # so "updated_at:>=cutoff" returns exactly the candidate set (new + restocked
    # + merely-sold) instead of the whole catalogue — an order of magnitude fewer
    # pages. We use one extra day of slack so nothing on the boundary is missed;
    # the precise new/restock filtering happens client-side.
    query = None
    if since_days:
        cutoff_day = (now - timedelta(days=since_days + 1)).date().isoformat()
        query = f"updated_at:>={cutoff_day}"

    client = ShopifyClient()
    print(f"[shopify] fetching products from {CONFIG.store_domain} "
          f"({'window ' + query if query else 'full catalogue'}) ...")
    products = client.fetch_products(query=query)
    print(f"[shopify] {len(products)} products fetched")

    # Restock signal: compare each product's current stock against the last
    # committed snapshot baseline (per SKU). This is the SAME baseline the real
    # `generate` run uses, so "restocked +N" here means exactly what the Modell A
    # gate means — units added since the last drop, NOT units sold. Read-only:
    # we only READ previous_quantities(), never commit a new run.
    store = SnapshotStore(CONFIG.snapshot_db)
    try:
        prev = store.previous_quantities()  # {sku: qty} or empty on first run
    finally:
        store.close()

    def restock_increase(p):
        """Units added vs baseline (>=0), or None when there's no baseline for
        this SKU (first run / never-seen product) — None means 'unknown', which
        the picker treats as 'not a confirmed restock'."""
        if not p.sku or p.sku not in prev:
            return None
        return max(0, p.inventory_quantity - prev[p.sku])

    def freshness(p):
        return p.updated_at or p.created_at

    q = (getattr(args, "query", None) or "").strip().lower()
    if q:
        products = [p for p in products if q in f"{p.title} {p.vendor}".lower()]

    products.sort(key=lambda p: (freshness(p) or now_utc().min.replace(tzinfo=now.tzinfo)),
                  reverse=True)

    limit = getattr(args, "limit", None)
    if limit:
        products = products[:limit]

    items = []
    for p in products:
        items.append({
            "id": p.id,
            "title": p.title,
            "vendor": p.vendor,
            "price_label": p.price_label,
            "image_url": p.image_url,
            "inventory_quantity": p.inventory_quantity,
            "in_stock": p.inventory_quantity >= max(1, CONFIG.min_stock),
            "country_code": country_to_iso(p.country_name),
            "collections": p.collections,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            "inventory_updated_at": (p.inventory_updated_at.isoformat()
                                     if p.inventory_updated_at else None),
            "restock_increase": restock_increase(p),
            "is_offer": p.is_offer,
        })

    payload = {
        "store_domain": CONFIG.store_domain,
        "count": len(items),
        "products": items,
    }
    print("PRODUCTS_JSON " + json.dumps(payload, ensure_ascii=False))
    return 0


def _report(edition: Edition) -> None:
    from collections import Counter

    from nordic_catalogue.models import State

    states: Counter = Counter()
    for cps in edition.by_category.values():
        for cp in cps:
            states[cp.state] += 1
    nyhet = states.get(State.NYHET, 0)
    restock = states.get(State.RESTOCK, 0)
    tilbud = states.get(State.TILBUD, 0)
    print(f"categories={len(edition.categories)} | products={edition.total_products} "
          f"| countries={edition.country_codes}")
    print(f"  NYHET={nyhet}  RESTOCK={restock}  TILBUD={tilbud}")
    if restock:
        names = [cp.product.title for cps in edition.by_category.values()
                 for cp in cps if cp.state == State.RESTOCK]
        for nm in names[:20]:
            print(f"    restock: {nm}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nordic-social")
    sub = parser.add_subparsers(dest="command", required=True)

    g = sub.add_parser("generate", help="generate the full drop (PDF + reels)")
    g.add_argument("--mock", action="store_true", help="use offline mock data")
    g.add_argument("--out", help="drop output directory")
    g.add_argument("--no-commit", dest="commit", action="store_false",
                   help="do not write the inventory snapshot baseline")
    g.add_argument("--deny", action="append", metavar="TERM",
                   help="exclude products whose title/vendor contains TERM "
                        "(repeatable, e.g. --deny 'golden cow')")
    g.add_argument("--min-category-size", type=int, default=1, metavar="N",
                   help="drop categories with fewer than N products")
    g.add_argument("--vm-hero", metavar="TERMS",
                   help="also render the football 'VM-drikker' hero reel from the "
                        "comma-separated product name terms, e.g. "
                        "--vm-hero 'coca cola pet 500,coca cola zero pet,sprite pet'")
    g.set_defaults(commit=True, func=cmd_generate)

    s = sub.add_parser("select", help="manual ad: PDF + reels for chosen products")
    s.add_argument("query", nargs="*", help="name terms, e.g. samyang calypso fanta")
    s.add_argument("--ids", metavar="GIDS",
                   help="comma/space separated Shopify product GIDs (picker mode)")
    s.add_argument("--tilbud", action="store_true",
                   help="offer ad: keep only on-offer products, render ONLY the "
                        "kampanje reel (førpris=compare_at_price)")
    s.add_argument("--out", help="drop output directory")
    s.add_argument("--title", metavar="TEXT",
                   help="custom campaign headline for the montage (intro) reel, "
                        "e.g. \"Vi introduserer mange varer fra Balkan\"")
    s.set_defaults(func=cmd_select)

    pr = sub.add_parser("products",
                        help="emit a JSON list of store products (picker source)")
    pr.add_argument("--since", type=int, metavar="DAYS",
                    help="only products edited/created within the last N days")
    pr.add_argument("--limit", type=int, metavar="N", help="cap the number returned")
    pr.add_argument("--query", metavar="TERM", help="filter by title/vendor substring")
    pr.set_defaults(func=cmd_products)

    st = sub.add_parser("status", help="emit baseline + config status as JSON")
    st.add_argument("--json", action="store_true", help="(default) JSON output")
    st.set_defaults(func=cmd_status)

    pv = sub.add_parser("preview",
                        help="dry-run the edition as JSON (no render, no commit)")
    pv.add_argument("--mock", action="store_true", help="use offline mock data")
    pv.add_argument("--deny", action="append", metavar="TERM",
                    help="exclude products whose title/vendor contains TERM (repeatable)")
    pv.add_argument("--min-category-size", type=int, default=1, metavar="N",
                    help="drop categories with fewer than N products")
    pv.set_defaults(func=cmd_preview)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
