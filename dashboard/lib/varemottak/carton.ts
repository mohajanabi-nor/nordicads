/**
 * Pieces per carton, resolved from the two places that know it.
 *
 * The invoice says it (quantity ÷ cartons). Shopify says it too: in the title ("x 24",
 * "8x1L", "10 x 1 kg") and in the arithmetic of the product (variant price ÷ productType).
 *
 * Decision (the client's): for an ACTIVE product, Shopify's figure wins and a mismatch
 * is shown as a warning with the invoice's figure; the operator can edit it. A DRAFT is
 * different — it was duplicated from a template product, so its price and often its title
 * carry the template's numbers, not this product's. There the invoice's figure is used.
 */
import { parseUnitPrice } from "./shopify/payloads";
import type { ShopProduct } from "./shopify/types";

/**
 * The carton count written in a Shopify title. Shapes seen in the store:
 *   "Krakus Polsk Sour Rye soup 8x1L"            → 8
 *   "Red Bull Energy Classic Drink Boks 250Ml x 24" → 24
 *   "Diamant Sugar Crystal 10 x 1 kg"            → 10
 *   "Zine Alsham Pickles 4 x 2,8 kg"             → 4
 *   "Dega Homemade Vegetable Salad XXL 4 x 1 Kg" → 4
 * and the unfinished "300g X" a template leaves behind → null.
 */
export function titlePackCount(title: string): number | null {
  const t = title.toLowerCase().replace(/(\d),(\d)/g, "$1.$2");
  // "<count> x <size><unit>" — count first
  const first = t.match(/(?<![\d.])(\d{1,3})\s*x\s*\d+(?:\.\d+)?\s*(?:kg|g|gr|l|ltr|ml|cl|dl|stk|pcs)\b/);
  if (first) return Number(first[1]);
  // "<size><unit> x <count>" — count last
  const last = t.match(/\d+(?:\.\d+)?\s*(?:kg|g|gr|l|ltr|ml|cl|dl)\s*x\s*(\d{1,3})(?![\d.])/);
  if (last) return Number(last[1]);
  // a bare trailing "x 12"
  const bare = t.match(/\bx\s*(\d{1,3})\s*$/);
  return bare ? Number(bare[1]) : null;
}

/** The carton size implied by the product's own prices, when it comes out whole. */
export function impliedPackFromPrices(variantPrice: number | null, productType: string): number | null {
  const unit = parseUnitPrice(productType);
  if (variantPrice === null || unit === null || unit <= 0) return null;
  const ratio = variantPrice / unit;
  return Math.abs(ratio - Math.round(ratio)) < 0.02 && Math.round(ratio) >= 1 ? Math.round(ratio) : null;
}

export type CartonSource = "shopify" | "invoice" | "title" | "typed" | "none";

export interface CartonResolution {
  value: number | null;
  source: CartonSource;
  /** What Shopify says, for the screen to show next to a mismatch. */
  shopify: number | null;
  invoice: number | null;
  warnings: string[];
}

export function resolveCarton(
  product: Pick<ShopProduct, "status" | "title" | "variantPrice" | "productType"> | null,
  invoicePcs: number | null,
): CartonResolution {
  const warnings: string[] = [];
  if (!product) return { value: invoicePcs, source: invoicePcs ? "invoice" : "none", shopify: null, invoice: invoicePcs, warnings };

  const fromTitle = titlePackCount(product.title);
  const fromPrices = product.status === "ACTIVE" ? impliedPackFromPrices(product.variantPrice, product.productType) : null;
  // The price arithmetic is the product's own selling maths and the more reliable of the two:
  // on the real Stanro shipment it agrees with the invoice for 221 of 223 products, while the
  // title count is wrong for ~8 % ("20g/144pcs" is the inner count, the carton is 24).
  const shopify = fromPrices ?? fromTitle;

  if (product.status === "ACTIVE") {
    if (fromTitle !== null && fromPrices !== null && fromTitle !== fromPrices) {
      warnings.push(`Shopify er ikke konsekvent: tittelen sier ${fromTitle}, men pris ÷ stk-pris gir ${fromPrices}`);
    }
    if (shopify !== null) {
      if (invoicePcs !== null && invoicePcs !== shopify) {
        warnings.push(`Kartongstørrelse: Shopify ${shopify}, faktura ${invoicePcs} – Shopify er brukt`);
      }
      return { value: shopify, source: "shopify", shopify, invoice: invoicePcs, warnings };
    }
    return { value: invoicePcs, source: invoicePcs ? "invoice" : "none", shopify: null, invoice: invoicePcs, warnings };
  }

  // DRAFT: the template's price arithmetic is not this product's. Trust the invoice, but say so
  // when the title already carries a different count.
  if (fromTitle !== null && invoicePcs !== null && fromTitle !== invoicePcs) {
    warnings.push(`Tittelen sier ${fromTitle} per kartong, fakturaen ${invoicePcs} – fakturaen er brukt`);
  }
  // The invoice cannot say (a kg line, or cartons that do not divide evenly): fall back to
  // the count in the title, which the goods-receipt tool writes from the invoice. Flagged.
  if (invoicePcs === null && fromTitle !== null) {
    warnings.push(`Stk per kartong (${fromTitle}) er hentet fra tittelen – fakturaen sier det ikke`);
    return { value: fromTitle, source: "title", shopify: fromTitle, invoice: null, warnings };
  }
  return { value: invoicePcs, source: invoicePcs ? "invoice" : "none", shopify: fromTitle, invoice: invoicePcs, warnings };
}

/**
 * ACTIVE products only: productType (our unit price) × pieces per carton should equal
 * the variant price (the case price). When it does not, someone changed one without the
 * other and the row is flagged.
 */
export function priceConsistencyWarning(
  p: Pick<ShopProduct, "status" | "variantPrice" | "productType">,
  pcsPerCarton: number | null,
): string | null {
  if (p.status !== "ACTIVE" || p.variantPrice === null || !pcsPerCarton) return null;
  const unit = parseUnitPrice(p.productType);
  if (unit === null) return `Produkttype «${p.productType}» er ikke en pris`;
  const expected = unit * pcsPerCarton;
  return Math.abs(expected - p.variantPrice) > Math.max(0.5, p.variantPrice * 0.005)
    ? `Stk-pris ${p.productType} × ${pcsPerCarton} = ${expected.toFixed(2)}, men Shopify-prisen er ${p.variantPrice.toFixed(2)}`
    : null;
}
