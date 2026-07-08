"""Mock data mirroring prototype_build_catalogue.py DATA, for offline PDF verification.

Synthesises a couple of product images (a coloured snack bag + a white-on-white
confection box) so the ML cutout path is exercised end-to-end without Shopify.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

from .config import CONFIG
from .models import Product, now_utc

_MOCK_DIR = CONFIG.flags_dir.parent / "mock"


def _font(size: int):
    from PIL import ImageFont

    f = ImageFont.truetype(str(CONFIG.font_path), size)
    try:
        f.set_variation_by_axes([800])
    except Exception:  # noqa: BLE001
        pass
    return f


def _make_snack_bag(path: Path) -> None:
    img = Image.new("RGB", (1024, 1024), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([300, 230, 724, 800], radius=40, fill=(232, 96, 28))
    d.polygon([(300, 230), (360, 270), (300, 310)], fill=(210, 80, 20))
    d.polygon([(724, 230), (664, 270), (724, 310)], fill=(210, 80, 20))
    d.ellipse([430, 430, 594, 594], fill=(255, 214, 60))
    d.text((512 - d.textlength("CHEETOS", font=_font(70)) / 2, 330), "CHEETOS", font=_font(70), fill=(255, 255, 255))
    img.save(path)


def _make_white_box(path: Path) -> None:
    img = Image.new("RGB", (1024, 1024), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([330, 260, 694, 770], radius=26, fill=(249, 249, 247), outline=(223, 219, 210), width=4)
    d.ellipse([430, 360, 594, 524], fill=(245, 240, 228), outline=(210, 200, 175), width=3)
    d.text((512 - d.textlength("RAFFAELLO", font=_font(46)) / 2, 600), "RAFFAELLO", font=_font(46), fill=(196, 150, 70))
    img.save(path)


def _ensure_images() -> tuple[str, str]:
    _MOCK_DIR.mkdir(parents=True, exist_ok=True)
    bag = _MOCK_DIR / "snack_bag.png"
    box = _MOCK_DIR / "white_box.png"
    if not bag.exists():
        _make_snack_bag(bag)
    if not box.exists():
        _make_white_box(box)
    return str(bag), str(box)


def _p(title, vendor, price, sku, barcode, country, collections, qty=20,
       compare=None, image=None) -> Product:
    return Product(
        id=f"gid://shopify/Product/{sku}",
        title=title,
        vendor=vendor,
        product_type=price,
        created_at=now_utc(),
        sku=sku,
        barcode=barcode,
        inventory_quantity=qty,
        compare_at_price=compare,
        price=None,
        country_name=country,
        collections=collections,
        image_url=None,
        image_path=image,
    )


def mock_products() -> list[Product]:
    bag, box = _ensure_images()
    return [
        # FRYSEVARER (priority category -> first)
        _p("Kyllingvinger", "NordFood", "129", "FRY-1001", "703900100015", "Poland", ["Frysevarer"]),
        _p("Lammekoteletter", "NordFood", "189.50", "FRY-1002", "703900100022", "Germany", ["Frysevarer"]),
        _p("Pommes frites", "Aviko", "79.90", "FRY-1004", "703900100046", "Netherlands", ["Frysevarer"]),
        # SNACKS
        _p("Cheetos Ketchup Family Bag", "Cheetos", "34.90", "SNK-3008", "590467131420",
           "Poland", ["Snacks"], image=bag),
        _p("Smoki", "Stark", "18.90", "SNK-3010", "703900300019", "Serbia", ["Snacks"]),
        _p("Napolitanke", "Kras", "22.90", "SNK-3011", None, "Croatia", ["Snacks"]),  # missing barcode -> N/A
        # GODTERI (one TILBUD)
        _p("Raffaello 150g", "Ferrero", "44.90", "GOD-4001", "800500006016", "Italy", ["Godteri"],
           compare=59.90, image=box),
        _p("Bajadera", "Kras", "64.90", "GOD-4002", "800500006023", "Croatia", ["Godteri"]),
        # DRIKKE
        _p("Cockta", "Droga Kolinska", "21.90", "DRK-2201", "703900200012", "Slovenia", ["Drikke"]),
        _p("Sutas Ayran", "Sutas", "14.90", "DRK-2202", "703900200029", "Turkey", ["Drikke"]),
    ]
