"""Core domain model shared by catalogue + (later) social outputs."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional


class State(str, Enum):
    """Modell A classification per product."""

    NYHET = "NYHET"
    TILBUD = "TILBUD"
    RESTOCK = "RESTOCK"


@dataclass
class Product:
    """Normalised Shopify product (first variant carries SKU/price/stock)."""

    id: str  # Shopify GID
    title: str
    vendor: str
    product_type: str  # price string, e.g. "17" (incl. VAT)
    created_at: datetime
    sku: str
    barcode: Optional[str]
    inventory_quantity: int
    compare_at_price: Optional[float]
    price: Optional[float]  # variant.price (used by campaign builder / sale math)
    country_name: Optional[str]  # English, from metafield custom.country_name
    collections: list[str] = field(default_factory=list)  # collection titles
    image_url: Optional[str] = None
    image_path: Optional[str] = None  # local cached path once downloaded
    inventory_updated_at: Optional[datetime] = None  # latest stock-change time (Shopify)
    updated_at: Optional[datetime] = None  # product last-edited time (Shopify updatedAt)

    # --- derived ---
    @property
    def price_value(self) -> Optional[float]:
        """Numeric catalogue price parsed from product_type (incl. VAT)."""
        raw = (self.product_type or "").strip().replace(",", ".")
        if not raw:
            return None
        # keep digits + dot only
        cleaned = "".join(ch for ch in raw if ch.isdigit() or ch == ".")
        try:
            return float(cleaned) if cleaned else None
        except ValueError:
            return None

    @property
    def price_label(self) -> str:
        v = self.price_value
        if v is None:
            return "—"
        return _format_price(v)

    @property
    def is_offer(self) -> bool:
        return self.compare_at_price is not None and self.compare_at_price > 0


@dataclass
class ClassifiedProduct:
    """A product that made it into the edition, with its state + category."""

    product: Product
    state: State
    category: str  # resolved category collection title (UNCHANGED structure)
    country_code: Optional[str] = None  # ISO-2, mapped from country_name
    rank_score: float = 0.0
    type_label: Optional[str] = None  # AI varetype label, for intra-category clustering


@dataclass
class Customer:
    """A Shopify customer, for the e-post recipient list.

    `email` is Level 2 protected customer data. Shopify redacts it (returns
    None) for an admin-created custom app on the Basic plan, which is exactly
    what `cli.py customers --probe` exists to detect — a null email here means
    a permissions problem, not a customer without an address.
    """

    id: str  # Shopify GID
    email: Optional[str]  # None = redacted OR genuinely absent; the probe tells them apart
    first_name: str
    last_name: str
    marketing_state: Optional[str]  # SUBSCRIBED | NOT_SUBSCRIBED | PENDING | UNSUBSCRIBED | …
    company: str = ""  # from defaultAddress
    city: str = ""
    orders_count: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @property
    def display_name(self) -> str:
        name = f"{self.first_name} {self.last_name}".strip()
        return name or (self.email or "—")

    @property
    def is_mailable(self) -> bool:
        """Only an explicit SUBSCRIBED is consent. PENDING is a double opt-in
        that was never confirmed, and must not be mailed."""
        return bool(self.email) and self.marketing_state == "SUBSCRIBED"


def _format_price(value: float) -> str:
    """17 -> 'kr 17,00', 34.9 -> 'kr 34,90'."""
    return "kr " + f"{value:,.2f}".replace(",", " ").replace(".", ",")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
