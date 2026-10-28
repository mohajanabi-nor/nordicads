/**
 * A fake Shopify: the same interface as the live store, backed by memory.
 *
 * Writes land here, so the whole push — batching, userErrors per row, re-push,
 * DRAFT → ACTIVE — can be developed and tested with no risk to the shop.
 *
 * It behaves like the real thing where it matters:
 *  - the products it starts with are a read-only snapshot of real products, with a
 *    share of them turned back into DRAFTs carrying the placeholder values a duplicated
 *    template gives (price 1000, productType 125, cost 101,17);
 *  - it rejects what Shopify rejects (a non-positive price, an unknown product);
 *  - a product whose title contains FAKE_ERROR returns a userError, to exercise the
 *    per-row error path;
 *  - stock and tags are never exposed by the interface, and `inventorySnapshot()` lets a
 *    test prove they were not changed.
 */
import { formatDecimal, parseUnitPrice } from "./payloads";
import type { PriceUpdate, PushResult, ShopProduct, ShopifyPort, UserError } from "./types";

export const PLACEHOLDER = { variantPrice: 1000, productType: "125", unitCost: 101.17 } as const;

interface FakeRaw {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  productType: string;
  tags: string[];
  featuredImage?: { url: string } | null;
  variants: { nodes: Array<{ id: string; price: string; barcode?: string | null; inventoryQuantity?: number; inventoryItem?: { id: string; unitCost?: { amount: string } | null } | null }> };
  metafields?: { nodes: Array<{ namespace: string; key: string; value: string }> };
}

export interface FakeSeedOptions {
  /** Every Nth product becomes a DRAFT with placeholder values. 0 = none. Default 5. */
  draftEvery?: number;
}

const numericId = (g: string) => g.split("/").pop() ?? g;
const copy = (p: ShopProduct): ShopProduct => ({ ...p, tags: [...p.tags] });

export class FakeShopify implements ShopifyPort {
  readonly mode = "fake" as const;
  private products = new Map<string, ShopProduct>();
  /** Stock and tags as they were seeded, so a test can prove a push did not move them. */
  private stock = new Map<string, number>();
  private tagSnapshot = new Map<string, string[]>();
  /** Every mutation payload received, for assertions. */
  readonly calls: PriceUpdate[][] = [];
  private onChange: (() => void) | null = null;

  constructor(seed: ShopProduct[] = [], stock: Record<string, number> = {}) {
    for (const p of seed) this.add(p, stock[p.id] ?? 0);
  }

  private add(p: ShopProduct, stock: number) {
    this.products.set(p.id, { ...p, tags: [...p.tags] });
    this.stock.set(p.id, stock);
    this.tagSnapshot.set(p.id, [...p.tags]);
  }

  /** Build from a snapshot file's contents (see scripts/snapshot-shopify.mjs). */
  static fromSnapshot(snapshot: { products: FakeRaw[] }, opts: FakeSeedOptions = {}): FakeShopify {
    const every = opts.draftEvery ?? 5;
    const fake = new FakeShopify();
    snapshot.products.forEach((raw, i) => {
      const v = raw.variants.nodes[0];
      const draft = every > 0 && i % every === every - 1;
      const country = raw.metafields?.nodes.find((m) => m.namespace === "custom" && m.key === "country_name")?.value ?? null;
      fake.add(
        {
          id: numericId(raw.id),
          title: raw.title,
          handle: raw.handle,
          status: draft ? "DRAFT" : (raw.status as ShopProduct["status"]),
          vendor: raw.vendor,
          productType: draft ? PLACEHOLDER.productType : raw.productType,
          tags: draft && !raw.tags.includes("nyhet") ? [...raw.tags, "nyhet"] : raw.tags,
          imageUrl: raw.featuredImage?.url ?? null,
          variantId: v ? numericId(v.id) : "",
          variantCount: raw.variants.nodes.length,
          variantPrice: draft ? PLACEHOLDER.variantPrice : v ? Number.parseFloat(v.price) : null,
          unitCost: draft ? PLACEHOLDER.unitCost : v?.inventoryItem?.unitCost ? Number.parseFloat(v.inventoryItem.unitCost.amount) : null,
          inventoryItemId: v?.inventoryItem ? numericId(v.inventoryItem.id) : null,
          countryName: draft ? null : country,
          barcodes: raw.variants.nodes.map((n) => n.barcode ?? "").filter(Boolean),
        },
        draft ? 0 : v?.inventoryQuantity ?? 0,
      );
    });
    return fake;
  }

  /** Persist after every write (local development only; a serverless disk is not durable). */
  persistTo(save: (state: { products: ShopProduct[]; stock: Record<string, number> }) => void) {
    this.onChange = () => save(this.dump());
    return this;
  }

  dump() {
    return { products: Array.from(this.products.values()), stock: Object.fromEntries(this.stock) };
  }

  get(id: string): ShopProduct | undefined {
    return this.products.get(id);
  }

  all(): ShopProduct[] {
    return Array.from(this.products.values());
  }

  /** Stock and tags exactly as seeded — a test asserts these equal the current ones. */
  inventorySnapshot() {
    return {
      stock: Object.fromEntries(this.stock),
      tags: Object.fromEntries(Array.from(this.products.values()).map((p) => [p.id, p.tags])),
      seededTags: Object.fromEntries(this.tagSnapshot),
    };
  }

  async productsByTags(tags: string[]): Promise<ShopProduct[]> {
    const wanted = new Set(tags.map((t) => t.toLowerCase()));
    return this.all().filter((p) => p.tags.some((t) => wanted.has(t.toLowerCase()))).map(copy);
  }

  async productsByIds(ids: string[]): Promise<Map<string, ShopProduct>> {
    const out = new Map<string, ShopProduct>();
    for (const id of ids) {
      const p = this.products.get(id);
      // A copy, like a fresh read from Shopify: a later write must not rewrite what was already read.
      if (p) out.set(id, copy(p));
    }
    return out;
  }

  async productsByBarcodes(codes: string[]): Promise<ShopProduct[]> {
    const wanted = new Set(codes);
    return this.all().filter((p) => p.barcodes.some((b) => wanted.has(b))).map(copy);
  }

  async searchProducts(text: string, limit = 10): Promise<ShopProduct[]> {
    const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
    return this.all()
      .filter((p) => words.every((w) => p.title.toLowerCase().includes(w)))
      .slice(0, limit)
      .map(copy);
  }

  async pushBatch(updates: PriceUpdate[]): Promise<PushResult[]> {
    this.calls.push(updates.map((u) => ({ ...u })));
    const results = updates.map((u): PushResult => {
      const errors: UserError[] = [];
      const p = this.products.get(u.productId);
      if (!p) return { productId: u.productId, ok: false, userErrors: [{ field: ["id"], message: "Product does not exist" }] };

      const price = Number.parseFloat(u.casePrice);
      if (!(price > 0)) errors.push({ field: ["variants", "0", "price"], message: "Price must be greater than 0" });
      if (!(Number.parseFloat(u.unitCost) >= 0)) errors.push({ field: ["variants", "0", "inventoryItem", "cost"], message: "Cost must be zero or greater" });
      // Shopify accepts any text here, including the empty text of a product priced per kg that we leave unchanged.
      if (u.productType !== "" && parseUnitPrice(u.productType) === null) errors.push({ field: ["productType"], message: "Product type is not a price" });
      if (p.title.includes("FAKE_ERROR")) errors.push({ field: ["title"], message: "Simulated Shopify error" });
      if (errors.length) return { productId: u.productId, ok: false, userErrors: errors };

      p.productType = u.productType;
      p.variantPrice = Number.parseFloat(formatDecimal(price));
      p.unitCost = Number.parseFloat(u.unitCost);
      if (u.activate) p.status = "ACTIVE";
      if (u.countryName && !p.countryName) p.countryName = u.countryName;
      return { productId: u.productId, ok: true, userErrors: [] };
    });
    this.onChange?.();
    return results;
  }
}
