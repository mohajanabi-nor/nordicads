"""Shopify Admin GraphQL client.

Scopes required: read_products, read_inventory, read_orders.
Fetches products (with first variant, metafield country_name, collections) and
order line-item quantities for sales-based ranking.
"""
from __future__ import annotations

import json
import time
from html import unescape
from datetime import datetime, timezone
from typing import Any, Iterator, Optional

import requests

from .config import CONFIG, Config
from .models import Customer, Product

_PRODUCTS_QUERY = """
query Products($cursor: String, $ns: String!, $key: String!, $query: String) {
  products(first: 250, after: $cursor, query: $query, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      vendor
      productType
      createdAt
      updatedAt
      featuredImage { url }
      images(first: 1) { nodes { url } }
      countryMeta: metafield(namespace: $ns, key: $key) { value }
      collections(first: 30) { nodes { title handle } }
      variants(first: 1) {
        nodes {
          sku
          barcode
          inventoryQuantity
          price
          compareAtPrice
          inventoryItem {
            inventoryLevels(first: 5) { nodes { updatedAt } }
          }
        }
      }
    }
  }
}
"""

# Product fields shared by the paginated query and the by-ids lookup, so both
# build identical Product objects through _to_product.
_PRODUCT_FIELDS = """
  id
  title
  vendor
  productType
  createdAt
  updatedAt
  featuredImage { url }
  images(first: 1) { nodes { url } }
  countryMeta: metafield(namespace: $ns, key: $key) { value }
  collections(first: 30) { nodes { title handle } }
  variants(first: 1) {
    nodes {
      sku
      barcode
      inventoryQuantity
      price
      compareAtPrice
      inventoryItem {
        inventoryLevels(first: 5) { nodes { updatedAt } }
      }
    }
  }
"""

_PRODUCTS_BY_IDS_QUERY = """
query ProductsByIds($ids: [ID!]!, $ns: String!, $key: String!) {
  nodes(ids: $ids) {
    ... on Product {
      __FIELDS__
    }
  }
}
""".replace("__FIELDS__", _PRODUCT_FIELDS)

# Customers for the e-post recipient list.
#
# The email + consent fields were renamed mid-life: `defaultEmailAddress` exists
# from 2025-04 onward, while `email` / `emailMarketingConsent` are the older
# spelling (deprecated, but still served by older versions). Neither works on
# every version, and this store's API version is operator-configurable — so we
# try the modern shape first and fall back once if the server rejects it, then
# remember the answer for the rest of the run.
#
# `marketingUnsubscribeUrl` is deliberately NOT requested: it requires
# write_customers and its absence would 403 the entire query.
_CUSTOMER_FIELDS_MODERN = """
      defaultEmailAddress { emailAddress marketingState }
"""

_CUSTOMER_FIELDS_LEGACY = """
      email
      emailMarketingConsent { marketingState }
"""

_CUSTOMERS_QUERY_TEMPLATE = """
query Customers($cursor: String, $query: String) {
  customers(first: 250, after: $cursor, query: $query, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      firstName
      lastName
      numberOfOrders
      createdAt
      updatedAt
__EMAIL_FIELDS__
      defaultAddress { company city }
    }
  }
}
"""


def _customers_query(modern: bool) -> str:
    return _CUSTOMERS_QUERY_TEMPLATE.replace(
        "__EMAIL_FIELDS__", _CUSTOMER_FIELDS_MODERN if modern else _CUSTOMER_FIELDS_LEGACY
    )

_ORDERS_QUERY = """
query Orders($cursor: String, $q: String) {
  orders(first: 100, after: $cursor, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      lineItems(first: 50) {
        nodes {
          quantity
          variant { product { id } }
        }
      }
    }
  }
}
"""


class ShopifyError(RuntimeError):
    pass


class TokenManager:
    """Obtains + caches an Admin API token via the client_credentials grant.

    Token-reveal is deprecated (Shopify, 2026-01-01). We POST client_id +
    client_secret + grant_type=client_credentials to /admin/oauth/access_token
    and reuse the token for its 24h lifetime (cached on disk).
    """

    _SKEW = 120  # refresh slightly before expiry

    def __init__(self, config: Config = CONFIG, session: Optional[requests.Session] = None):
        self.cfg = config
        self.session = session or requests.Session()
        self._token: Optional[str] = None
        self._expires_at: float = 0.0
        # static override wins if provided
        if config.admin_token:
            self._token = config.admin_token
            self._expires_at = float("inf")

    def _load_cache(self) -> None:
        try:
            data = json.loads(self.cfg.token_cache.read_text())
            self._token = data.get("access_token")
            self._expires_at = float(data.get("expires_at", 0))
        except Exception:  # noqa: BLE001
            self._token, self._expires_at = None, 0.0

    def _save_cache(self) -> None:
        self.cfg.token_cache.parent.mkdir(parents=True, exist_ok=True)
        self.cfg.token_cache.write_text(
            json.dumps({"access_token": self._token, "expires_at": self._expires_at})
        )

    def _fresh(self) -> bool:
        return bool(self._token) and time.time() < self._expires_at - self._SKEW

    def get(self, force: bool = False) -> str:
        if not force and self._fresh():
            return self._token  # type: ignore[return-value]
        if not force and self.cfg.admin_token:
            return self._token  # type: ignore[return-value]
        if not force:
            self._load_cache()
            if self._fresh():
                return self._token  # type: ignore[return-value]
        return self._refresh()

    def _refresh(self) -> str:
        if not (self.cfg.client_id and self.cfg.client_secret):
            raise ShopifyError(
                "SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET missing (set them in worker/.env)"
            )
        resp = self.session.post(
            self.cfg.token_url,
            data={
                "client_id": self.cfg.client_id,
                "client_secret": self.cfg.client_secret,
                "grant_type": "client_credentials",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded",
                     "Accept": "application/json"},
            timeout=30,
        )
        if resp.status_code != 200:
            err = ""
            try:
                body = resp.json()
                err = body.get("error_description") or body.get("error") or ""
            except Exception:  # noqa: BLE001
                err = resp.text[:200]
            hint = ""
            if "not installed" in err.lower() or resp.status_code == 400:
                hint = (
                    " — install the app on the store (Shopify admin → Apps → "
                    "install your custom app), then retry."
                )
            raise ShopifyError(
                f"client_credentials grant failed ({resp.status_code}): {err}{hint}"
            )
        payload = resp.json()
        token = payload.get("access_token")
        if not token:
            raise ShopifyError(f"No access_token in token response: {payload}")
        self._token = token
        self._expires_at = time.time() + float(payload.get("expires_in", 86399))
        self._save_cache()
        return token


class ShopifyClient:
    def __init__(self, config: Config = CONFIG, session: Optional[requests.Session] = None):
        self.cfg = config
        self.session = session or requests.Session()
        self.tokens = TokenManager(config, self.session)
        # None = not yet determined; see _customers_page.
        self._customers_modern: Optional[bool] = None

    # ---- low level ----
    def _post(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        for attempt in range(6):
            headers = {
                "X-Shopify-Access-Token": self.tokens.get(),
                "Content-Type": "application/json",
            }
            resp = self.session.post(
                self.cfg.graphql_url,
                json={"query": query, "variables": variables},
                headers=headers,
                timeout=60,
            )
            if resp.status_code == 429:
                time.sleep(2 * (attempt + 1))
                continue
            if resp.status_code in (401, 403):
                # token may have expired mid-run -> force one refresh and retry
                if attempt == 0:
                    self.tokens.get(force=True)
                    continue
                raise ShopifyError(
                    f"Auth failed ({resp.status_code}) after refresh. Check app scopes "
                    "(read_products, read_inventory, read_orders)."
                )
            resp.raise_for_status()
            payload = resp.json()
            if "errors" in payload and payload["errors"]:
                # throttled errors → back off and retry
                msg = str(payload["errors"])
                if "THROTTLED" in msg.upper():
                    time.sleep(2 * (attempt + 1))
                    continue
                raise ShopifyError(f"GraphQL errors: {payload['errors']}")
            return payload["data"]
        raise ShopifyError("Exceeded retry budget (throttled).")

    # ---- products ----
    def iter_products(self, query: Optional[str] = None) -> Iterator[Product]:
        """Yield products newest-edited-first. `query` is a Shopify search filter
        (e.g. "updated_at:>=2026-06-24") that pushes windowing to the server so we
        fetch only recently-changed products instead of the whole catalogue."""
        cursor: Optional[str] = None
        while True:
            data = self._post(
                _PRODUCTS_QUERY,
                {"cursor": cursor, "ns": self.cfg.origin_namespace,
                 "key": self.cfg.origin_key, "query": query},
            )
            block = data["products"]
            for node in block["nodes"]:
                product = self._to_product(node)
                if product is not None:
                    yield product
            if not block["pageInfo"]["hasNextPage"]:
                break
            cursor = block["pageInfo"]["endCursor"]

    def fetch_products(self, query: Optional[str] = None) -> list[Product]:
        return list(self.iter_products(query))

    def fetch_products_by_ids(self, ids: list[str]) -> list[Product]:
        """Fetch ONLY the given product GIDs via nodes(ids:) — one request per
        250 ids instead of paginating the whole catalogue. Used by the manual
        picker, which already knows exactly which products it wants, so there is
        no reason to page through thousands of unrelated products."""
        out: list[Product] = []
        for i in range(0, len(ids), 250):
            chunk = ids[i:i + 250]
            data = self._post(
                _PRODUCTS_BY_IDS_QUERY,
                {"ids": chunk, "ns": self.cfg.origin_namespace, "key": self.cfg.origin_key},
            )
            for node in data.get("nodes", []):
                if not node:  # a non-Product or deleted id comes back as null
                    continue
                product = self._to_product(node)
                if product is not None:
                    out.append(product)
        return out

    @staticmethod
    def _to_product(node: dict[str, Any]) -> Optional[Product]:
        variants = node.get("variants", {}).get("nodes", [])
        if not variants:
            return None
        v = variants[0]
        image_url = None
        if node.get("featuredImage"):
            image_url = node["featuredImage"].get("url")
        if not image_url:
            imgs = node.get("images", {}).get("nodes", [])
            if imgs:
                image_url = imgs[0].get("url")
        country = None
        if node.get("countryMeta") and node["countryMeta"].get("value"):
            country = unescape(node["countryMeta"]["value"]).strip()
        # Shopify titles are HTML-encoded ("Sjokolader &amp; Snacks") -> decode.
        collections = [unescape(c["title"]) for c in node.get("collections", {}).get("nodes", [])]

        def _f(x: Any) -> Optional[float]:
            if x in (None, ""):
                return None
            try:
                return float(x)
            except (TypeError, ValueError):
                return None

        # Latest stock-change time across the variant's inventory levels (the
        # most recent restock/adjustment). Used as a baseline-free restock signal.
        inv_updated: Optional[datetime] = None
        levels = ((v.get("inventoryItem") or {}).get("inventoryLevels") or {}).get("nodes", [])
        for lvl in levels:
            ts = lvl.get("updatedAt")
            if ts:
                dt = _parse_dt(ts)
                if inv_updated is None or dt > inv_updated:
                    inv_updated = dt

        return Product(
            id=node["id"],
            title=unescape(node.get("title", "")).strip(),
            vendor=unescape(node.get("vendor") or "").strip(),
            product_type=(node.get("productType") or "").strip(),
            created_at=_parse_dt(node.get("createdAt")),
            sku=(v.get("sku") or "").strip(),
            barcode=(v.get("barcode") or "").strip() or None,
            inventory_quantity=int(v.get("inventoryQuantity") or 0),
            compare_at_price=_f(v.get("compareAtPrice")),
            price=_f(v.get("price")),
            country_name=country,
            collections=collections,
            image_url=image_url,
            inventory_updated_at=inv_updated,
            updated_at=_parse_dt(node.get("updatedAt")) if node.get("updatedAt") else None,
        )

    # ---- diagnostics ----
    def access_scopes(self) -> list[str]:
        """The scopes this token ACTUALLY carries, straight from Shopify.

        Worth having as a first-class call: an app config can list a scope while
        the token in hand does not carry it (the app version was never released,
        or the app was not reinstalled after the change). Guessing at that from
        an ACCESS_DENIED alone wastes a lot of time."""
        resp = self.session.get(
            f"https://{self.cfg.store_domain}/admin/oauth/access_scopes.json",
            headers={"X-Shopify-Access-Token": self.tokens.get()},
            timeout=30,
        )
        resp.raise_for_status()
        return sorted(s["handle"] for s in resp.json().get("access_scopes", []))

    # ---- customers (e-post recipient list) ----
    def _customers_page(self, variables: dict[str, Any]) -> dict[str, Any]:
        """One page of customers, resolving the email-field spelling on first use.

        Which spelling the server accepts depends on its API version, and the
        version is operator-configurable — so probe once rather than hard-coding
        an assumption that silently breaks when someone bumps it."""
        if self._customers_modern is None:
            try:
                data = self._post(_customers_query(True), variables)
                self._customers_modern = True
                return data
            except ShopifyError as e:
                if "defaultEmailAddress" not in str(e):
                    raise  # a real failure (auth, throttle) — don't mask it
                self._customers_modern = False
        return self._post(_customers_query(bool(self._customers_modern)), variables)

    def iter_customers(self, query: Optional[str] = None) -> Iterator[Customer]:
        """Yield customers newest-edited-first. `query` is a Shopify search
        filter, e.g. "accepts_marketing:true" to narrow server-side — though the
        result is always re-filtered on marketing_state, never trusted."""
        cursor: Optional[str] = None
        while True:
            data = self._customers_page({"cursor": cursor, "query": query})
            block = data["customers"]
            for node in block["nodes"]:
                yield self._to_customer(node)
            if not block["pageInfo"]["hasNextPage"]:
                break
            cursor = block["pageInfo"]["endCursor"]

    def fetch_customers(self, query: Optional[str] = None,
                        limit: Optional[int] = None) -> list[Customer]:
        out: list[Customer] = []
        for c in self.iter_customers(query):
            out.append(c)
            if limit and len(out) >= limit:
                break
        return out

    @staticmethod
    def _to_customer(node: dict[str, Any]) -> Customer:
        addr = node.get("defaultAddress") or {}
        # Accept either spelling, so the same parser serves both API versions.
        default_email = node.get("defaultEmailAddress") or {}
        consent = node.get("emailMarketingConsent") or default_email
        raw_email = default_email.get("emailAddress") or node.get("email")
        email = (raw_email or "").strip().lower() or None
        return Customer(
            id=node["id"],
            email=email,
            first_name=unescape(node.get("firstName") or "").strip(),
            last_name=unescape(node.get("lastName") or "").strip(),
            marketing_state=consent.get("marketingState"),
            company=unescape(addr.get("company") or "").strip(),
            city=unescape(addr.get("city") or "").strip(),
            orders_count=int(node.get("numberOfOrders") or 0),
            created_at=_parse_dt(node.get("createdAt")) if node.get("createdAt") else None,
            updated_at=_parse_dt(node.get("updatedAt")) if node.get("updatedAt") else None,
        )

    # ---- orders (sales-based ranking) ----
    def product_sales(self, since: Optional[datetime] = None) -> dict[str, int]:
        """Return {product_gid: total_quantity_sold}. Optional since-date filter."""
        q = None
        if since is not None:
            q = f"created_at:>={since.date().isoformat()}"
        totals: dict[str, int] = {}
        cursor: Optional[str] = None
        while True:
            data = self._post(_ORDERS_QUERY, {"cursor": cursor, "q": q})
            block = data["orders"]
            for order in block["nodes"]:
                for li in order.get("lineItems", {}).get("nodes", []):
                    variant = li.get("variant") or {}
                    product = variant.get("product") or {}
                    pid = product.get("id")
                    if pid:
                        totals[pid] = totals.get(pid, 0) + int(li.get("quantity") or 0)
            if not block["pageInfo"]["hasNextPage"]:
                break
            cursor = block["pageInfo"]["endCursor"]
        return totals


def _parse_dt(value: Optional[str]) -> datetime:
    from datetime import timezone

    if not value:
        return datetime.now(timezone.utc)
    # Shopify ISO-8601, e.g. 2026-05-30T10:15:00Z
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
