/**
 * List store products for the product-picker (spec: manual select flow).
 *
 * The worker's read-only `products` command fetches Shopify and prints one
 * `PRODUCTS_JSON <json>` line (most-recently-edited first). Fetching the whole
 * catalogue is slow (~20s), so we fetch the FULL list ONCE, cache it in-process
 * for a few minutes, and do the window / search / limit filtering here in Node.
 * That makes the first load a single fetch and every window switch instant.
 *
 * Query params: ?since=<days>&limit=<n>&query=<term>
 */
import { runWorker } from "@/lib/worker";
import type { PickerProduct } from "@/lib/types";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CACHE_TTL_MS = 5 * 60 * 1000;
// Fetch ONE superset covering the widest picker window, then derive every
// shorter window (3/7/14/30) by filtering it in Node. That way only the very
// first load waits on Shopify (~20-30s); switching windows afterwards is
// instant — no per-window cold fetch. 90 = the widest button in the picker.
const SUPERSET_DAYS = 90;
type Loaded = { products: PickerProduct[]; storeDomain: string };

// Store the cache on globalThis, not a module const. In Next.js dev, editing
// ANY file recompiles the server module and resets module-level state — which
// would wipe the cache and force a fresh ~25s Shopify fetch on the next reload.
// globalThis survives hot-reload, so the warm cache persists across edits (and
// this is harmless in production, where the module isn't reloaded).
const _g = globalThis as unknown as {
  _pickerCache?: Map<number, { data: Loaded; at: number }>;
  _pickerInflight?: Map<number, Promise<Loaded>>;
};
const _cache = (_g._pickerCache ??= new Map());
const _inflight = (_g._pickerInflight ??= new Map());

async function loadWindow(sinceDays: number): Promise<Loaded> {
  const hit = _cache.get(sinceDays);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let p = _inflight.get(sinceDays);
  if (!p) {
    p = (async () => {
      const args = sinceDays > 0 ? ["products", "--since", String(sinceDays)] : ["products"];
      const { code, stdout, stderr } = await runWorker(args, 110_000);
      if (code !== 0) throw new Error(`worker exited ${code}: ${stderr.slice(-500)}`);
      const line = stdout.split("\n").find((l) => l.startsWith("PRODUCTS_JSON "));
      if (!line) throw new Error("no PRODUCTS_JSON in worker output");
      const payload = JSON.parse(line.slice("PRODUCTS_JSON ".length));
      const data: Loaded = {
        products: payload.products ?? [],
        storeDomain: payload.store_domain ?? "",
      };
      _cache.set(sinceDays, { data, at: Date.now() });
      return data;
    })().finally(() => {
      _inflight.delete(sinceDays);
    });
    _inflight.set(sinceDays, p);
  }
  return p;
}

function ms(t: string | null): number {
  return t ? new Date(t).getTime() : 0;
}

/**
 * "Fresh" for the picker window = genuinely new OR genuinely restocked — NOT
 * merely last-edited. `updated_at` bumps whenever anything on the product
 * changes (including a sale), so a product we only SOLD in the window would
 * wrongly show up. The operator wants products they can advertise as arrived:
 *   - NEW:       created within the window, or
 *   - RESTOCKED: stock went up by >= minRestock vs the last baseline AND that
 *                inventory change happened within the window.
 * restock_increase is null when there's no baseline for the SKU (first run /
 * never-seen product) — that's "unknown", never a confirmed restock.
 */
function isFresh(p: PickerProduct, cutoff: number, minRestock: number): boolean {
  const isNew = ms(p.created_at) >= cutoff;
  const restocked =
    p.restock_increase != null &&
    p.restock_increase >= minRestock &&
    ms(p.inventory_updated_at) >= cutoff;
  return isNew || restocked;
}

/**
 * Order a windowed list the way the operator reads the cards: NEW ARRIVALS
 * first (newest created_at on top), then RESTOCKS (most recent restock on top).
 *
 * We deliberately do NOT rank by a single "max(created, inventory_updated)"
 * timestamp: this store's whole catalogue often gets its inventory touched on
 * the same day (a bulk sync), so inventory_updated_at is "today" for nearly
 * every product and collapses to a useless tie — which just leaves the raw
 * Shopify order (looks scrambled). Grouping by signal keeps each card's visible
 * date monotonic within its group, so the order reads as sorted.
 */
function freshCompare(a: PickerProduct, b: PickerProduct, cutoff: number): number {
  const aNew = ms(a.created_at) >= cutoff;
  const bNew = ms(b.created_at) >= cutoff;
  if (aNew !== bNew) return aNew ? -1 : 1; // new arrivals before restocks
  // Within a group, newest relevant event first: created_at for new arrivals,
  // inventory_updated_at (the restock moment) for restocks.
  const at = aNew ? ms(a.created_at) : ms(a.inventory_updated_at);
  const bt = bNew ? ms(b.created_at) : ms(b.inventory_updated_at);
  return bt - at;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const since = sp.get("since") ? parseInt(sp.get("since")!, 10) : 0;
  const limit = sp.get("limit") ? parseInt(sp.get("limit")!, 10) : null;
  const minRestock = sp.get("minRestock") ? parseInt(sp.get("minRestock")!, 10) : 5;
  const query = (sp.get("query") || "").trim().toLowerCase();

  try {
    // Load the wide superset once (cached 5 min), then filter the requested
    // window here — so only the first visit waits, and window switches are
    // instant. We never fetch a window wider than the superset.
    const { products, storeDomain } = await loadWindow(SUPERSET_DAYS);
    let out = products;

    if (since && since > 0) {
      const cutoff = Date.now() - since * 24 * 60 * 60 * 1000;
      out = out.filter((p) => isFresh(p, cutoff, minRestock));
      // Order: new arrivals (newest first) then restocks (latest first). Sort
      // BEFORE the limit slice so the top N are genuinely the freshest, not an
      // arbitrary 500 that then get truncated.
      out = [...out].sort((a, b) => freshCompare(a, b, cutoff));
    }
    if (query) {
      out = out.filter((p) => `${p.title} ${p.vendor}`.toLowerCase().includes(query));
    }
    if (limit && limit > 0) out = out.slice(0, limit);

    return Response.json({
      store_domain: storeDomain,
      count: out.length,
      cached: _cache.has(SUPERSET_DAYS),
      products: out,
    });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
