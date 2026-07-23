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

// Collections that sit on (nearly) every product and carry no category meaning —
// they must never be used to cluster. The DO-NOT-DELETE search collection,
// storefront root, and the "latest arrivals" smart collection are store-wide.
const NOISE_COLLECTION_RE = /DO NOT DELETE/i;
const NOISE_COLLECTION_NAMES = new Set(["Hovedside", "Siste Ankomst"]);
// A collection carried by ≥ this fraction of the catalogue is effectively
// universal (a store-wide bucket), so it's noise for clustering purposes too.
const NEAR_UNIVERSAL = 0.8;

function collectionFreq(all: PickerProduct[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const p of all) for (const c of p.collections ?? []) freq.set(c, (freq.get(c) ?? 0) + 1);
  return freq;
}

function isNoiseCollection(name: string, freq: Map<string, number>, total: number): boolean {
  if (NOISE_COLLECTION_RE.test(name)) return true;
  if (NOISE_COLLECTION_NAMES.has(name)) return true;
  return (freq.get(name) ?? 0) >= total * NEAR_UNIVERSAL;
}

// The store tags hot drinks under several overlapping collections, so coffee
// gets split into tiny fragments (Kaffe & Cappucino / Varmedrikker / Te & kaffe
// (AR)). Fold those into ONE canonical cluster so all coffee & tea sit together.
// Applied AFTER specificity selection, so a coffee also tagged in a big generic
// bucket still resolves to its coffee collection first, then normalizes here.
const CATEGORY_ALIASES: Record<string, string> = {
  "Kaffe & Cappucino": "Kaffe & te",
  "Varmedrikker": "Kaffe & te",
  "Te & kaffe (AR)": "Kaffe & te",
};

/**
 * The single category we CLUSTER a product under = its most SPECIFIC real
 * collection (smallest catalogue-wide membership), after dropping the universal
 * noise buckets. "Most specific" is what the operator means by like-with-like:
 * a Tiger drink tagged both "Juice & Drikkevarer" (93) and "Energidrikker" (16)
 * clusters as Energidrikker, so energy drinks sit together instead of being
 * diluted into the generic drinks bucket. Products with no real collection fall
 * into a trailing "Annet" group (the ￿ prefix sorts it last, name-wise).
 */
function categoryOf(p: PickerProduct, freq: Map<string, number>, total: number): string {
  const cats = (p.collections ?? []).filter((c) => !isNoiseCollection(c, freq, total));
  if (cats.length === 0) return "￿Annet";
  cats.sort((a, b) => (freq.get(a)! - freq.get(b)!) || a.localeCompare(b));
  return CATEGORY_ALIASES[cats[0]] ?? cats[0];
}

/**
 * Cutoff for a window of `days`, snapped to the START of the local day so the
 * buttons mean calendar days, not rolling 24h clocks. "I dag" (1) = since local
 * midnight today; "Siste 2 dager" (2) = since midnight yesterday; and so on
 * (days-1 whole days before today's midnight). Without this, a product added
 * late yesterday would wrongly show under "I dag".
 */
function windowCutoff(days: number): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.getTime() - (days - 1) * 24 * 60 * 60 * 1000;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const since = sp.get("since") ? parseInt(sp.get("since")!, 10) : 0;
  const limit = sp.get("limit") ? parseInt(sp.get("limit")!, 10) : null;
  const minRestock = sp.get("minRestock") ? parseInt(sp.get("minRestock")!, 10) : 5;
  const query = (sp.get("query") || "").trim().toLowerCase();
  // Offer view: every product with a førpris (compare_at_price), regardless of
  // the new/restock freshness rule. A price change only bumps updated_at, which
  // isFresh deliberately ignores — so campaign products would otherwise be
  // invisible here. This is the view for building a tilbud campaign.
  const offersOnly = sp.get("offers") === "1";
  // Let the operator force a refetch after editing prices in Shopify, instead of
  // waiting out the 5-minute cache TTL.
  const forceRefresh = sp.get("refresh") === "1";

  try {
    // Load the wide superset once (cached 5 min), then filter the requested
    // window here — so only the first visit waits, and window switches are
    // instant. We never fetch a window wider than the superset.
    // The offers view must scan the WHOLE catalogue, not the 90-day superset: a
    // førpris set months ago is still an active tilbud, and filtering the recent
    // window silently dropped those (they looked "ignored"). sinceDays=0 makes
    // the worker fetch every product; it's cached separately under key 0.
    const windowKey = offersOnly ? 0 : SUPERSET_DAYS;
    if (forceRefresh) _cache.delete(windowKey);
    const { products, storeDomain } = await loadWindow(windowKey);
    let out = products;

    if (offersOnly) {
      // Most recently edited first — the prices you just changed land on top.
      out = out.filter((p) => p.is_offer);
      out = [...out].sort((a, b) => ms(b.updated_at) - ms(a.updated_at));
    } else if (since && since > 0) {
      const cutoff = windowCutoff(since);
      out = out.filter((p) => isFresh(p, cutoff, minRestock));

      // CLUSTER like-with-like: the operator reads the grid by product family
      // (all drinks together, all chocolates together), so category is the
      // PRIMARY order key — not date. Categories themselves are ordered by their
      // freshest arrival so the newest stuff still surfaces near the top; within
      // a category we keep new-before-restock + newest-first, then group by brand
      // so e.g. all Najjar coffees sit next to each other. Sorting happens BEFORE
      // the limit slice so the kept N are the freshest whole categories.
      const freq = collectionFreq(products); // over the full superset — stable
      const total = products.length;
      const cat = new Map<string, string>(); // product id -> cluster category
      const catCreated = new Map<string, number>(); // category -> freshest created_at
      const catInv = new Map<string, number>(); // category -> freshest restock
      for (const p of out) {
        const c = categoryOf(p, freq, total);
        cat.set(p.id, c);
        catCreated.set(c, Math.max(catCreated.get(c) ?? 0, ms(p.created_at)));
        catInv.set(c, Math.max(catInv.get(c) ?? 0, ms(p.inventory_updated_at)));
      }
      out = [...out].sort((a, b) => {
        const ca = cat.get(a.id)!, cb = cat.get(b.id)!;
        if (ca !== cb) {
          // Category order: freshest genuine arrival first, then freshest
          // restock, then name — so a category with a brand-new product leads.
          return (
            (catCreated.get(cb)! - catCreated.get(ca)!) ||
            (catInv.get(cb)! - catInv.get(ca)!) ||
            ca.localeCompare(cb)
          );
        }
        const f = freshCompare(a, b, cutoff);
        if (f !== 0) return f;
        return (a.vendor || "").localeCompare(b.vendor || "") || a.title.localeCompare(b.title);
      });
    }
    if (query) {
      out = out.filter((p) => `${p.title} ${p.vendor}`.toLowerCase().includes(query));
    }
    if (limit && limit > 0) out = out.slice(0, limit);

    return Response.json({
      store_domain: storeDomain,
      count: out.length,
      cached: _cache.has(offersOnly ? 0 : SUPERSET_DAYS),
      products: out,
    });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
