"""Find out whether a wishlist app stores its lists where our Admin API can read them.

Step 1 of the wishlist plan: save a couple of products to the wishlist as a test
customer (on an unpublished theme copy), then run this against that customer.
Read-only — it only runs GraphQL queries, never mutations.

    python scripts/inspect_wishlist_metafields.py 1234567890      # customer id from the admin URL
    python scripts/inspect_wishlist_metafields.py you@example.com # or search by email

It prints every customer metafield, the customer's tags, shop metafields and any
metaobject types. If the saved product/variant ids show up anywhere, the app's
data is readable (plan path A). Note: metafields in an app-reserved namespace
("app--<id>--...") are private to that app and will NOT appear here even if they
exist — an empty result means "not readable by us", which is what matters.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from nordic_catalogue.shopify_client import ShopifyClient, ShopifyError  # noqa: E402

_CUSTOMER_FIELDS = """
  id
  tags
  metafields(first: 100) { nodes { namespace key type value updatedAt } }
"""

_BY_ID = "query($id: ID!) { customer(id: $id) {" + _CUSTOMER_FIELDS + "} }"
_BY_EMAIL = (
    "query($q: String) { customers(first: 1, query: $q) { nodes {"
    + _CUSTOMER_FIELDS + "} } }"
)
_SHOP = "query { shop { metafields(first: 100) { nodes { namespace key type value } } } }"
_METAOBJECTS = "query { metaobjectDefinitions(first: 50) { nodes { type name metaobjectsCount } } }"


def _find_customer(client: ShopifyClient, arg: str) -> dict | None:
    if "@" in arg:
        nodes = client._post(_BY_EMAIL, {"q": f"email:{arg}"})["customers"]["nodes"]
        return nodes[0] if nodes else None
    gid = arg if arg.startswith("gid://") else f"gid://shopify/Customer/{arg}"
    return client._post(_BY_ID, {"id": gid})["customer"]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    client = ShopifyClient()

    customer = _find_customer(client, sys.argv[1])
    if not customer:
        print(f"No customer found for {sys.argv[1]!r}.")
        return 1
    print(f"Customer {customer['id']}")
    print(f"  tags: {customer['tags'] or '(none)'}")
    metafields = customer["metafields"]["nodes"]
    print(f"  metafields: {len(metafields)}")
    for m in metafields:
        print(f"    {m['namespace']}.{m['key']} [{m['type']}] {m['updatedAt']}")
        print(f"      {m['value'][:500]}")

    shop = client._post(_SHOP, {})
    print("\nShop metafields:")
    for m in shop["shop"]["metafields"]["nodes"]:
        print(f"  {m['namespace']}.{m['key']} [{m['type']}] {m['value'][:200]}")
    print("\nMetaobject types:")
    for d in (shop.get("metaobjectDefinitions") or {}).get("nodes", []):
        print(f"  {d['type']} ({d['name']}): {d['metaobjectsCount']} entries")

    blob = json.dumps({"customer": customer, "shop": shop}).lower()
    hit = "wishlist" in blob or "gid://shopify/product" in blob
    print("\nVerdict:", "wishlist-looking data FOUND — likely path A"
          if hit else "nothing wishlist-like readable — path B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
