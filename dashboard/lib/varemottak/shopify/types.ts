/**
 * What Varemottak needs from Shopify, as an interface with two implementations:
 * the live store (live.ts) and an in-memory fake (fake.ts) for developing and testing
 * writes without ever touching the shop.
 *
 * The interface is deliberately narrow. There is NO operation that changes stock, tags,
 * `custom.arrival_date` or collection order — those belong to the goods-receipt tool and
 * to tripletex-shopify. The only writes Varemottak can express are the price fields and
 * the DRAFT → ACTIVE switch, so it cannot fight the other two systems by construction.
 */

export type ShopStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

export interface ShopProduct {
  /** Numeric id, as a string. */
  id: string;
  title: string;
  handle: string;
  status: ShopStatus;
  /** The brand, e.g. "Krakus". Art.nr tags collide between suppliers, so the vendor disambiguates. */
  vendor: string;
  /** Our price per unit, as text ("28", "28,5"). Meaningless on a DRAFT: the template's placeholder. */
  productType: string;
  tags: string[];
  imageUrl: string | null;
  /** The first (and in practice only) variant. */
  variantId: string;
  variantCount: number;
  /** Variant price = the case price. */
  variantPrice: number | null;
  /** Unit cost (per piece) from the inventory item. */
  unitCost: number | null;
  inventoryItemId: string | null;
  /** custom.country_name, when set. */
  countryName: string | null;
  /** Every variant barcode — what an invoice EAN is compared with. */
  barcodes: string[];
}

/** The only fields Varemottak ever sends. */
export interface PriceUpdate {
  productId: string;
  variantId: string;
  /** Our price per unit, formatted for productType ("28" or "28,5"). */
  productType: string;
  /** Case price = unit price × pieces per carton, as a plain decimal string ("196.00"). */
  casePrice: string;
  /** Cost incl. VAT per unit, plain decimal string. */
  unitCost: string;
  /** DRAFT → ACTIVE (and publish to the Online Store). False for products already ACTIVE. */
  activate: boolean;
  /** Origin in English; sent only when the product has none yet. */
  countryName: string | null;
}

export interface UserError {
  field: string[] | null;
  message: string;
}

export interface PushResult {
  productId: string;
  ok: boolean;
  userErrors: UserError[];
}

export interface ShopifyPort {
  readonly mode: "live" | "fake";
  /** Products carrying any of these tags (art.nr tags), including DRAFTs. */
  productsByTags(tags: string[]): Promise<ShopProduct[]>;
  productsByIds(ids: string[]): Promise<Map<string, ShopProduct>>;
  /** Products whose barcode is any of these (the invoice's EANs). */
  productsByBarcodes(codes: string[]): Promise<ShopProduct[]>;
  /** Free-text search for the manual match picker. */
  searchProducts(text: string, limit?: number): Promise<ShopProduct[]>;
  /** Apply price updates. Live mode refuses unless live writes were switched on. */
  pushBatch(updates: PriceUpdate[]): Promise<PushResult[]>;
}

export class LiveWritesDisabledError extends Error {
  constructor() {
    super(
      "Skriving mot den ekte Shopify-butikken er avslått. Sett VAREMOTTAK_LIVE_WRITES=1 bare når eieren har gitt tillatelse; bruk SHOPIFY_FAKE=1 for testing.",
    );
    this.name = "LiveWritesDisabledError";
  }
}
