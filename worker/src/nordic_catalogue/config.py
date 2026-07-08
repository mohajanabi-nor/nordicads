"""Runtime configuration, loaded from worker/.env (gitignored)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - dotenv optional
    load_dotenv = None

# worker/ root = three parents up from this file (src/nordic_catalogue/config.py)
WORKER_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = WORKER_ROOT.parent

if load_dotenv is not None:
    load_dotenv(WORKER_ROOT / ".env")


def _split(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass(frozen=True)
class Config:
    store_domain: str = os.getenv("SHOPIFY_STORE_DOMAIN", "nordic-engros.myshopify.com")
    # Auth via client_credentials grant (token-reveal deprecated 2026-01-01).
    client_id: str = os.getenv("SHOPIFY_CLIENT_ID", "")
    client_secret: str = os.getenv("SHOPIFY_CLIENT_SECRET", "")
    # Optional static override (rarely needed); leave empty to use client_credentials.
    admin_token: str = os.getenv("SHOPIFY_ADMIN_TOKEN", "")
    api_version: str = os.getenv("SHOPIFY_API_VERSION", "2024-10")

    origin_namespace: str = os.getenv("ORIGIN_METAFIELD_NAMESPACE", "custom")
    origin_key: str = os.getenv("ORIGIN_METAFIELD_KEY", "country_name")

    exclude_collections: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            s.lower() for s in _split(os.getenv("EXCLUDE_COLLECTIONS", "tilbud,siste-ankomst"))
        )
    )
    cta_url: str = os.getenv(
        "CTA_URL", "https://www.nordicengros.com/collections/siste-ankomst"
    )
    new_window_days: int = int(os.getenv("NEW_WINDOW_DAYS", "7"))
    # RESTOCK = a proven inventory INCREASE vs the previous snapshot (a sale /
    # reduction never counts). This window only bounds how recently the stock
    # level must have changed for that increase to still surface as a restock.
    restock_window_days: int = int(os.getenv("RESTOCK_WINDOW_DAYS", "3"))
    # A restock must be a MEANINGFUL stock-up, not a +1 blip: the increase vs the
    # baseline has to be at least this many units. Guards against noise when the
    # baseline is older and net movement is tiny.
    restock_min_increase: int = int(os.getenv("RESTOCK_MIN_INCREASE", "3"))
    # Nothing out of stock is ever advertised: a product needs at least this much
    # sellable stock NOW to enter the edition (applies to NYHET and RESTOCK alike).
    min_stock: int = int(os.getenv("MIN_STOCK", "1"))

    # Paths
    assets_dir: Path = REPO_ROOT / "Assets"
    font_path: Path = REPO_ROOT / "Assets" / "Montserrat-var.ttf"
    logo_path: Path = REPO_ROOT / "Assets" / "logo_mark.png"
    flags_dir: Path = WORKER_ROOT / "assets" / "flags"
    model_path: Path = WORKER_ROOT / "models" / "u2net.onnx"
    snapshot_db: Path = WORKER_ROOT / "state" / "snapshot.sqlite3"
    state_dir: Path = WORKER_ROOT / "state"
    output_dir: Path = WORKER_ROOT / "output"

    token_cache: Path = WORKER_ROOT / "state" / "token.json"

    @property
    def graphql_url(self) -> str:
        return f"https://{self.store_domain}/admin/api/{self.api_version}/graphql.json"

    @property
    def token_url(self) -> str:
        return f"https://{self.store_domain}/admin/oauth/access_token"


CONFIG = Config()
