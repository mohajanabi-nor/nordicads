/**
 * The live store. Reads freely; writes only when VAREMOTTAK_LIVE_WRITES=1.
 *
 * That switch is off by default and is turned on by the shop owner, never by the code.
 * Every write method checks it first, so a bug elsewhere cannot reach the shop by
 * accident — the worst a mistaken call can do against a default configuration is throw.
 */
import { shopifyConfig, shopifyGraphQL } from "../../shopify-admin";
import { BATCH_SIZE, buildBatchRequest, chunk } from "./payloads";
import {
  LiveWritesDisabledError,
  type PriceUpdate,
  type PushResult,
  type ShopProduct,
  type ShopStatus,
  type ShopifyPort,
  type UserError,
} from "./types";

export const liveWritesEnabled = () => process.env.VAREMOTTAK_LIVE_WRITES === "1";

/** productUpdate(product: …) exists from API 2024-10. */
export function apiVersionSupportsProductUpdateInput(version: string): boolean {
  const m = version.match(/^(\d{4})-(\d{2})/);
  if (!m) return false;
  return Number(m[1]) * 100 + Number(m[2]) >= 202410;
}

const PRODUCT_FIELDS = `
  id title handle status vendor productType tags
  featuredImage { url }
  variants(first: 5) { nodes { id price barcode inventoryItem { id unitCost { amount } } } }
  metafield(namespace: "custom", key: "country_name") { value }`;

interface RawProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  productType: string;
  tags: string[];
  featuredImage: { url: string } | null;
  variants: {
    nodes: Array<{ id: string; price: string; barcode: string | null; inventoryItem: { id: string; unitCost: { amount: string } | null } | null }>;
  };
  metafield: { value: string } | null;
}

const numericId = (g: string) => g.split("/").pop() ?? g;

export function toShopProduct(p: RawProduct): ShopProduct {
  const v = p.variants.nodes[0];
  return {
    id: numericId(p.id),
    title: p.title,
    handle: p.handle,
    status: (["ACTIVE", "DRAFT", "ARCHIVED"].includes(p.status) ? p.status : "DRAFT") as ShopStatus,
    vendor: p.vendor,
    productType: p.productType,
    tags: p.tags,
    imageUrl: p.featuredImage?.url ?? null,
    variantId: v ? numericId(v.id) : "",
    variantCount: p.variants.nodes.length,
    variantPrice: v ? Number.parseFloat(v.price) : null,
    unitCost: v?.inventoryItem?.unitCost ? Number.parseFloat(v.inventoryItem.unitCost.amount) : null,
    inventoryItemId: v?.inventoryItem ? numericId(v.inventoryItem.id) : null,
    countryName: p.metafield?.value ?? null,
    barcodes: p.variants.nodes.map((n) => n.barcode ?? "").filter(Boolean),
  };
}

let onlineStoreId: string | null | undefined;

async function onlineStorePublicationId(): Promise<string | null> {
  if (onlineStoreId !== undefined) return onlineStoreId;
  const data = await shopifyGraphQL<{ publications: { nodes: Array<{ id: string; name: string }> } }>(
    `{ publications(first: 20) { nodes { id name } } }`,
  );
  onlineStoreId = data.publications.nodes.find((n) => n.name === "Online Store")?.id ?? null;
  return onlineStoreId;
}

export class LiveShopify implements ShopifyPort {
  readonly mode = "live" as const;

  async productsByTags(tags: string[]): Promise<ShopProduct[]> {
    const byId = new Map<string, ShopProduct>();
    for (const batch of chunk(Array.from(new Set(tags)), 25)) {
      const q = batch.map((t) => `tag:"${t.replace(/["\\]/g, "")}"`).join(" OR ");
      let after: string | null = null;
      do {
        const data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawProduct[] } } =
          await shopifyGraphQL(
            `query($q: String!, $after: String) { products(first: 100, query: $q, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS} } } }`,
            { q, after },
          );
        for (const p of data.products.nodes) byId.set(numericId(p.id), toShopProduct(p));
        after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
      } while (after);
    }
    return Array.from(byId.values());
  }

  async productsByIds(ids: string[]): Promise<Map<string, ShopProduct>> {
    const out = new Map<string, ShopProduct>();
    for (const batch of chunk(Array.from(new Set(ids)), 100)) {
      const data = await shopifyGraphQL<{ nodes: Array<RawProduct | null> }>(
        `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} } } }`,
        { ids: batch.map((id) => `gid://shopify/Product/${id}`) },
      );
      for (const p of data.nodes) if (p?.id) out.set(numericId(p.id), toShopProduct(p));
    }
    return out;
  }

  async productsByBarcodes(codes: string[]): Promise<ShopProduct[]> {
    const byId = new Map<string, ShopProduct>();
    for (const batch of chunk(Array.from(new Set(codes.filter((c) => /^\d{6,14}$/.test(c)))), 25)) {
      const q = batch.map((c) => `barcode:${c}`).join(" OR ");
      let after: string | null = null;
      do {
        const data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawProduct[] } } = await shopifyGraphQL(
          `query($q: String!, $after: String) { products(first: 100, query: $q, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS} } } }`,
          { q, after },
        );
        for (const p of data.products.nodes) byId.set(numericId(p.id), toShopProduct(p));
        after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
      } while (after);
    }
    return Array.from(byId.values());
  }

  async searchProducts(text: string, limit = 10): Promise<ShopProduct[]> {
    const words = text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2)
      .slice(0, 4);
    if (!words.length) return [];
    const q = words.map((w) => `title:*${w.replace(/["\\*]/g, "")}*`).join(" AND ");
    const data = await shopifyGraphQL<{ products: { nodes: RawProduct[] } }>(
      `query($q: String!, $n: Int!) { products(first: $n, query: $q) { nodes { ${PRODUCT_FIELDS} } } }`,
      { q, n: limit },
    );
    return data.products.nodes.map(toShopProduct);
  }

  async pushBatch(updates: PriceUpdate[]): Promise<PushResult[]> {
    if (!liveWritesEnabled()) throw new LiveWritesDisabledError();
    if (!apiVersionSupportsProductUpdateInput(shopifyConfig().apiVersion)) {
      throw new Error(`SHOPIFY_API_VERSION ${shopifyConfig().apiVersion} er for gammel (kreves 2024-10 eller nyere)`);
    }
    const publicationId = updates.some((u) => u.activate) ? await onlineStorePublicationId() : null;

    const results: PushResult[] = [];
    for (const group of chunk(updates, BATCH_SIZE)) results.push(...(await this.sendGroup(group, publicationId)));
    return results;
  }

  /**
   * One request for a group of products. A request Shopify refuses as too costly is split in
   * halves and retried; any other failure marks just this group's rows as failed, so one bad
   * batch never aborts the rest of the push. Re-sending a row is harmless (prices are set, not added).
   */
  private async sendGroup(group: PriceUpdate[], publicationId: string | null): Promise<PushResult[]> {
    const req = buildBatchRequest(group, publicationId);
    try {
      const data = await shopifyGraphQL<Record<string, { userErrors?: UserError[] } | null>>(req.query, req.variables);
      return group.map((u, i) => {
        const errors = [
          ...(data[`m${i}_product`]?.userErrors ?? []),
          ...(data[`m${i}_variant`]?.userErrors ?? []),
          ...(data[`m${i}_publish`]?.userErrors ?? []),
        ];
        if (u.activate && !publicationId) {
          errors.push({ field: null, message: "Fant ikke Nettbutikk-kanalen – produktet ble aktivert, men ikke publisert" });
        }
        return { productId: u.productId, ok: errors.length === 0, userErrors: errors };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (group.length > 1 && /cost|throttl/i.test(message)) {
        const mid = Math.ceil(group.length / 2);
        return [...(await this.sendGroup(group.slice(0, mid), publicationId)), ...(await this.sendGroup(group.slice(mid), publicationId))];
      }
      return group.map((u) => ({
        productId: u.productId,
        ok: false,
        userErrors: [{ field: null, message: `Shopify avviste kallet: ${message.slice(0, 200)}` }],
      }));
    }
  }
}
