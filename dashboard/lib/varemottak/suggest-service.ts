/**
 * The picker's two data sources: what the system proposes for a row it is unsure about, and a free
 * search for the product the operator already knows.
 *
 * Both are reads. Choosing a product is a separate step (setMatch in service.ts) and only that step
 * changes anything.
 */
import type { LineRow } from "./lines";
import { NotFoundError, type Ctx } from "./service";
import type { ShopProduct } from "./shopify/types";
import { rankCandidates, searchWords } from "./suggest";

export interface ProposedProduct extends ShopProduct {
  score: number;
  reasons: string[];
  /** The article number of another row in this shipment that already points at this product. */
  usedBy: string | null;
}

const wholeOrNull = (n: number) => (Math.abs(n - Math.round(n)) <= 0.02 && Math.round(n) >= 1 ? Math.round(n) : null);

/**
 * Candidates for one row, best first. The pool is wider than what the import looked at: besides the
 * import's own proposal and any product sharing the EAN or the article number, it searches the shop
 * for the distinctive words of the invoice name — so a product with a different spelling, or a
 * tag that is missing, can still turn up.
 */
export async function suggestForLine(ctx: Ctx, lineId: string): Promise<ProposedProduct[]> {
  const [line] = await ctx.db.select<LineRow>("vm_lines", { id: `eq.${lineId}`, limit: 1 });
  if (!line) throw new NotFoundError("Fant ikke raden");

  const pool = new Map<string, ShopProduct>();
  const add = (products: Iterable<ShopProduct>) => {
    for (const p of products) pool.set(p.id, p);
  };

  // 1. What the import itself proposed.
  const ids = Array.from(new Set([line.shopify_product_id, ...line.match_candidates].filter((x): x is string => !!x)));
  if (ids.length) add((await ctx.shopify.productsByIds(ids)).values());

  // 2. Anything that shares the barcode or the article number.
  const eans = [line.ean, line.ean_box].filter((e): e is string => !!e);
  if (eans.length) add(await ctx.shopify.productsByBarcodes(eans));
  add(await ctx.shopify.productsByTags([line.idx]));

  // 3. The shop's own search, on the distinctive words of the invoice name.
  const words = searchWords(line.name);
  for (const w of words) add(await ctx.shopify.searchProducts(w, 25));
  if (words.length >= 2) add(await ctx.shopify.searchProducts(words.slice(0, 2).join(" "), 25));

  const ranked = rankCandidates(
    { idx: line.idx, name: line.name, ean: line.ean, eanBox: line.ean_box, pcsPerCarton: line.unit === "pcs" && line.cartons ? wholeOrNull(Number(line.qty) / Number(line.cartons)) : null },
    Array.from(pool.values()),
    8,
  );

  // Flag a product another row of this shipment already points at: choosing it twice is blocked later.
  const others = await ctx.db.select<Pick<LineRow, "id" | "idx" | "shopify_product_id">>("vm_lines", { shipment_id: `eq.${line.shipment_id}`, select: "id,idx,shopify_product_id" });
  const usedBy = new Map(others.filter((o) => o.id !== line.id && o.shopify_product_id).map((o) => [o.shopify_product_id as string, o.idx]));

  return ranked.map((r) => ({ ...r.product, score: r.score, reasons: r.reasons, usedBy: usedBy.get(r.product.id) ?? null }));
}

/**
 * Free search for the product the operator knows. Words search the titles; a number (4–14 digits)
 * is looked up as an article-number tag and as a barcode, because that is what people paste.
 */
export async function searchForPicker(ctx: Ctx, query: string): Promise<ShopProduct[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  if (/^\d{4,14}$/.test(q)) {
    const found = new Map<string, ShopProduct>();
    for (const p of await ctx.shopify.productsByTags([q])) found.set(p.id, p);
    for (const p of await ctx.shopify.productsByBarcodes([q])) found.set(p.id, p);
    return Array.from(found.values());
  }
  return ctx.shopify.searchProducts(q, 12);
}
