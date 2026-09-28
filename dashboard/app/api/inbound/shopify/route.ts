/**
 * Shopify webhooks: products/update and inventory_levels/update.
 *
 * This is what makes wishlist alerts arrive within seconds of a price or stock change
 * rather than on the next hourly check. Most deliveries are about products nobody has
 * saved and are answered straight away; for a saved one the check (and the email to
 * instant customers) happens before we reply.
 *
 * Open in middleware (under /api/inbound/); the HMAC Shopify signs every delivery with,
 * keyed on the app's client secret, is checked against the raw body before anything
 * is parsed. Shopify retries anything that isn't a 2xx, and a retry is harmless — the
 * check claims each change once (see lib/wishlist-alerts.ts).
 */
import crypto from "node:crypto";
import { eq, inList, sbSelect } from "@/lib/supabase";
import { shopifyConfig } from "@/lib/shopify-admin";
import { checkProducts } from "@/lib/wishlist-alerts";
import { logError } from "@/lib/eventlog";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function verified(raw: string, header: string | null): boolean {
  const secret = shopifyConfig().clientSecret;
  if (!secret || !header) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verified(raw, req.headers.get("x-shopify-hmac-sha256"))) {
    return Response.json({ error: "signaturen stemmer ikke" }, { status: 401 });
  }
  if (req.headers.get("x-shopify-shop-domain") !== shopifyConfig().storeDomain) {
    return Response.json({ error: "feil butikk" }, { status: 401 });
  }

  const topic = req.headers.get("x-shopify-topic") ?? "";
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "ugyldig JSON" }, { status: 400 });
  }

  try {
    let productIds: string[] = [];
    if (topic === "products/update" && body.id != null) {
      const id = String(body.id);
      const saved = await sbSelect<{ product_id: string }>("wishlist_items", {
        product_id: eq(id),
        select: "product_id",
        limit: 1,
      });
      productIds = saved.map((s) => s.product_id);
    } else if (topic === "inventory_levels/update" && body.inventory_item_id != null) {
      const saved = await sbSelect<{ product_id: string }>("wishlist_items", {
        inventory_item_id: inList([String(body.inventory_item_id)]),
        select: "product_id",
      });
      productIds = saved.map((s) => s.product_id);
    }
    if (productIds.length) await checkProducts(productIds);
  } catch (err) {
    // Still a 200: the hourly check will pick the change up, and a retry storm from
    // Shopify wouldn't help while (say) Supabase is down.
    const message = err instanceof Error ? err.message : String(err);
    await logError("wishlist", "wishlist.webhookFailed", `Shopify-webhook (${topic}) feilet: ${message}`);
  }
  return Response.json({ ok: true });
}
