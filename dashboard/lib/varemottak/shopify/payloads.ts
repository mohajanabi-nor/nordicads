/**
 * The GraphQL Varemottak sends, built as plain data so a dry run can show exactly what
 * a push would send without sending it.
 *
 * Per product, up to three mutations, aliased so ~20 products share one request:
 *   productUpdate                — productType (our unit price), status, country metafield
 *   productVariantsBulkUpdate    — case price and unit cost
 *   publishablePublish           — Online Store, when a DRAFT becomes ACTIVE
 *
 * What is NOT here is the point: no inventory, no tags, no arrival_date, no collections.
 */
import type { PriceUpdate } from "./types";

export const BATCH_SIZE = 20;

const gid = (kind: string, id: string) => `gid://shopify/${kind}/${id}`;

export interface BuiltRequest {
  query: string;
  variables: Record<string, unknown>;
  /** Which product ids the aliases m0, m1… stand for, in order. */
  productIds: string[];
}

/** Online Store publication id, when a batch publishes. */
export function buildBatchRequest(updates: PriceUpdate[], onlineStorePublicationId: string | null): BuiltRequest {
  const defs: string[] = [];
  const bodies: string[] = [];
  const variables: Record<string, unknown> = {};

  updates.forEach((u, i) => {
    const p = `p${i}`;
    const v = `v${i}`;
    defs.push(`$${p}: ProductUpdateInput!`, `$${v}Product: ID!`, `$${v}: [ProductVariantsBulkInput!]!`);

    const product: Record<string, unknown> = { id: gid("Product", u.productId), productType: u.productType };
    if (u.activate) product.status = "ACTIVE";
    if (u.countryName) {
      product.metafields = [
        { namespace: "custom", key: "country_name", type: "single_line_text_field", value: u.countryName },
      ];
    }
    variables[p] = product;
    variables[`${v}Product`] = gid("Product", u.productId);
    variables[v] = [
      {
        id: gid("ProductVariant", u.variantId),
        price: u.casePrice,
        inventoryItem: { cost: u.unitCost },
      },
    ];

    bodies.push(
      `m${i}_product: productUpdate(product: $${p}) { product { id } userErrors { field message } }`,
      `m${i}_variant: productVariantsBulkUpdate(productId: $${v}Product, variants: $${v}) { userErrors { field message } }`,
    );
    if (u.activate && onlineStorePublicationId) {
      bodies.push(
        `m${i}_publish: publishablePublish(id: "${gid("Product", u.productId)}", input: [{ publicationId: "${onlineStorePublicationId}" }]) { userErrors { field message } }`,
      );
    }
  });

  return {
    query: `mutation VaremottakPush(${defs.join(", ")}) {\n  ${bodies.join("\n  ")}\n}`,
    variables,
    productIds: updates.map((u) => u.productId),
  };
}

export function chunk<T>(items: T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "28" for whole kroner, "28,5" for halves: Norwegian decimals, as the client prefers. */
export function formatProductType(unitPrice: number): string {
  const rounded = Math.round(unitPrice * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
}

/** Plain decimal with a dot, which is what Shopify's Money/Decimal fields take. */
export const formatDecimal = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Parse productType back to a number: both "8,5" and "8.5" exist in the store today. */
export function parseUnitPrice(productType: string | null | undefined): number | null {
  const raw = (productType ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
