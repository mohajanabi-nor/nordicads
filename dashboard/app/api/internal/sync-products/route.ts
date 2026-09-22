/**
 * Receive a fetched product catalogue and replace the picker's cache.
 *
 * Posted by the Actions runner after `worker products`. The fetch takes 20-35
 * seconds against Shopify's GraphQL API and needs the Python client, so it
 * cannot happen inside a serverless request — the picker reads this cache
 * instead and loads instantly.
 *
 * Machine-authenticated with the shared worker token, like the customer sync.
 */
import { sbRpc } from "@/lib/supabase";
import { logError, logInfo } from "@/lib/eventlog";
import { setAppState } from "@/lib/app-state";
import type { PickerProduct } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Where the picker looks for the cache timestamp (see app/api/products). */
const PRODUCTS_STATE_KEY = "products.cache";

function authorized(req: Request): boolean {
  const expected = process.env.WORKER_SERVICE_TOKEN || "";
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "ugyldig token" }, { status: 401 });
  }

  let payload: { products?: PickerProduct[]; store_domain?: string; count?: number };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "ugyldig JSON" }, { status: 400 });
  }

  const products = payload.products ?? [];
  if (!products.length) {
    // Replacing the cache with nothing would empty the picker on a bad fetch.
    await logError("worker", "products.empty", "Produkthenting returnerte ingen varer — cachen beholdes.");
    return Response.json({ error: "ingen produkter i payload" }, { status: 400 });
  }

  try {
    const rows = products.map((p) => ({
      id: p.id,
      title: p.title,
      vendor: p.vendor,
      price_label: p.price_label,
      image_url: p.image_url,
      inventory_quantity: p.inventory_quantity,
      in_stock: p.in_stock,
      country_code: p.country_code,
      country_name_no: p.country_name_no ?? null,
      collections: p.collections ?? [],
      created_at: p.created_at,
      updated_at: p.updated_at,
      inventory_updated_at: p.inventory_updated_at,
      restock_increase: p.restock_increase,
      is_offer: p.is_offer,
    }));

    const inserted = await sbRpc<number>("replace_product_cache", { p_rows: rows });

    await setAppState(PRODUCTS_STATE_KEY, {
      fetchedAt: new Date().toISOString(),
      count: products.length,
      storeDomain: payload.store_domain ?? null,
    });

    await logInfo("worker", "products.cached", `Produktcache oppdatert: ${products.length} varer.`, {
      count: products.length,
    });

    return Response.json({ ok: true, count: inserted ?? products.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logError("worker", "products.cacheFailed", `Kunne ikke lagre produktcache: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
