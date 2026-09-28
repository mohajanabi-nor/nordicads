"""Subscribe the dashboard to the Shopify webhooks the wishlist alerts need.

products/update and inventory_levels/update are sent to the dashboard's
/api/inbound/shopify, which checks saved wishlist items within seconds of a price or
stock change (see dashboard/lib/wishlist-alerts.ts). Run once, after that route is
deployed — Shopify drops a subscription whose address keeps failing.

    python scripts/register_wishlist_webhooks.py            # show what exists / would change
    python scripts/register_wishlist_webhooks.py --apply    # create the missing ones

Safe to re-run: existing subscriptions to the same address are left alone.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from nordic_catalogue.shopify_client import ShopifyClient  # noqa: E402

CALLBACK = "https://ads.nordicengros.no/api/inbound/shopify"
TOPICS = ["PRODUCTS_UPDATE", "INVENTORY_LEVELS_UPDATE"]

_LIST = """
query { webhookSubscriptions(first: 100) { nodes {
  id topic
  endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
} } }"""

_CREATE = """
mutation($topic: WebhookSubscriptionTopic!, $url: URL!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) {
    webhookSubscription { id topic }
    userErrors { field message }
  }
}"""


def main() -> int:
    apply = "--apply" in sys.argv
    client = ShopifyClient()
    existing = client._post(_LIST, {})["webhookSubscriptions"]["nodes"]
    have = {
        n["topic"]
        for n in existing
        if (n.get("endpoint") or {}).get("callbackUrl") == CALLBACK
    }
    print("Existing subscriptions:")
    for n in existing:
        print(f"  {n['topic']:<28} {(n.get('endpoint') or {}).get('callbackUrl')}")
    missing = [t for t in TOPICS if t not in have]
    if not missing:
        print("\nAll wishlist webhooks are in place.")
        return 0
    print(f"\nMissing: {', '.join(missing)}")
    if not apply:
        print("Run with --apply to create them.")
        return 0
    for topic in missing:
        r = client._post(_CREATE, {"topic": topic, "url": CALLBACK})["webhookSubscriptionCreate"]
        if r["userErrors"]:
            print(f"  {topic}: FAILED {r['userErrors']}")
        else:
            print(f"  {topic}: created {r['webhookSubscription']['id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
