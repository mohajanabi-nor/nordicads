/**
 * The pricing engine for a shipment — steps 3–11 of the Nordic Ads pricing spec.
 *
 * Pure: no I/O, no clock, no framework. The review screen runs it in the browser on
 * every keystroke and the server runs the same function again before a push, so the
 * number on screen and the number sent to Shopify cannot drift apart.
 *
 * Money is carried as plain numbers and rounded only where the spec rounds (the
 * suggested price, up to the nearest 0.5). Nothing here guesses: a missing duty rate
 * stays null and the row is flagged, because a landed cost built on an invented rate
 * is worse than an empty cell.
 */

/** HS headings the spec treats as drinks: no duty, flat packaging cost per unit. */
export const DRINK_HS_PREFIXES = ["2202", "2201", "2009", "2204", "2205", "2206"] as const;

export type MarkupMode = "markup" | "margin";

export interface ShipmentSettings {
  /** "markup": price = cost × (1 + value).  "margin": price = cost ÷ (1 − value). */
  markupMode: MarkupMode;
  /** 0.30 = 30 %. */
  markupValue: number;
  /** Rows below this margin are flagged. 0.23 = 23 %. */
  marginThreshold: number;
  /** Flat packaging cost per drink unit, NOK. */
  drinkPackagingNok: number;
  /** VAT rate for food and for products tagged mva-25. */
  vatFood: number;
  vatMva25: number;
}

export const DEFAULT_SETTINGS: ShipmentSettings = {
  markupMode: "markup",
  markupValue: 0.3,
  marginThreshold: 0.23,
  drinkPackagingNok: 2,
  vatFood: 0.15,
  vatMva25: 0.25,
};

export type InvoiceUnit = "pcs" | "kilo";

export interface LineInput {
  /** NOK per one unit of the invoice currency, for this line's invoice. */
  rateToNok: number;
  quantity: number;
  unit: InvoiceUnit;
  /** Line value in the invoice currency. */
  lineValue: number;
  /** Net weight of the whole line, kg. */
  netWeightKg: number;
  hs: string | null;
  /** Duty NOK per kg, or null when unknown. */
  dutyPerKg: number | null;
  /** Duty as a share of the goods value (0.19 = 19 %), for goods the tariff charges by value (Cedevita powder). Beats dutyPerKg. */
  dutyPctOfValue?: number | null;
  /** The duty rate came from a customs declaration for this very product: then it counts even on a drink (a dairy drink pays TL). */
  dutyDeclared?: boolean;
  /** Packaging NOK per unit typed or declared for this line; beats the flat drink fee (and gives 0 to a drink with no fee). */
  packagingOverride?: number | null;
  pcsPerCarton: number | null;
  /** Kg products sold per box: the box size in kg. Null for everything else. */
  salesUnitKg: number | null;
  mva25: boolean;
  /** VAT the operator set for this line (0.15 or 0.25), beating the tag and the code rule; null = automatic. */
  vatOverride?: number | null;
  /** "ACTIVE" → our price defaults to what Shopify has; anything else → the suggestion. */
  shopifyStatus: string | null;
  /** Shopify's current price per unit (productType), when known and trustworthy. */
  shopifyUnitPrice: number | null;
  /** Shopify's current variant price (the case price), for an ACTIVE product. */
  shopifyCasePrice: number | null;
  /** The operator's override of our price per unit, if they typed one. */
  ourPriceOverride: number | null;
}

export interface ShipmentTotals {
  /** Freight for the whole shipment, already converted to NOK. */
  freightNok: number;
  /** Sum of net weight across all product lines, kg — what freight is spread over. */
  totalNetWeightKg: number;
}

export interface LineFlags {
  missingDuty: boolean;
  marginBelowThreshold: boolean;
  priceBelowCost: boolean;
  missingWeight: boolean;
  missingQuantity: boolean;
}

export interface LineResult {
  isDrink: boolean;
  /** How many sold units the line holds (invoice units, or boxes for a kg product). */
  soldUnits: number;
  /** All per-unit amounts below are NOK per sold unit. */
  goodsNok: number;
  /** null while the duty rate is unknown. */
  dutyNok: number | null;
  packagingNok: number;
  freightNok: number;
  landedCost: number | null;
  costInclVat: number | null;
  suggestedPrice: number | null;
  ourPrice: number | null;
  casePrice: number | null;
  /**
   * Shopify's own prices do not multiply out (productType × pcs per carton ≠ variant price —
   * e.g. loose goods priced per kg in a 2.4 kg box), so Shopify's case price is kept rather
   * than replaced with an invented one. Only a price the operator types changes it.
   */
  casePriceKept: boolean;
  /** (our − cost) ÷ our, or null when either side is unknown. */
  margin: number | null;
  vatRate: number;
  flags: LineFlags;
}

/**
 * Non-food carries 25 % import VAT, not 15 %: toys (9503), cosmetics and hygiene (3305, 3401, 3402) and brushes (9603).
 * The client's rule from the price sheets. Lighters and other non-food that these codes do not catch are set by hand
 * (the mva-25 tag in Shopify) or from the declaration.
 */
const NON_FOOD_VAT_PREFIXES = ["9503", "3305", "3401", "3402", "9603"];
export function isNonFoodVatHs(hs: string | null | undefined): boolean {
  const digits = (hs ?? "").replace(/\D/g, "");
  return NON_FOOD_VAT_PREFIXES.some((p) => digits.startsWith(p));
}

export function isDrinkHs(hs: string | null | undefined): boolean {
  const digits = (hs ?? "").replace(/\D/g, "");
  return DRINK_HS_PREFIXES.some((p) => digits.startsWith(p));
}

/** Round UP to the nearest 0.5, tolerant of float noise (28.000000001 stays 28). */
export function roundUpHalf(value: number): number {
  return Math.ceil(value * 2 - 1e-9) / 2;
}

const orNull = (n: number) => (Number.isFinite(n) ? n : null);

export function suggestPrice(
  costInclVat: number,
  s: Pick<ShipmentSettings, "markupMode" | "markupValue">,
): number {
  const raw = s.markupMode === "margin" ? costInclVat / (1 - s.markupValue) : costInclVat * (1 + s.markupValue);
  return roundUpHalf(raw);
}

export function calcLine(line: LineInput, totals: ShipmentTotals, settings: ShipmentSettings): LineResult {
  const isDrink = isDrinkHs(line.hs);
  const vatRate = line.vatOverride ?? (line.mva25 || isNonFoodVatHs(line.hs) ? settings.vatMva25 : settings.vatFood);
  const qty = line.quantity;
  const missingQuantity = !(qty > 0);
  const missingWeight = !(line.netWeightKg > 0);

  // A kg product invoiced per kg but sold per box of N kg: every per-unit amount is
  // per kg, so multiply by the box size to get the cost of one box.
  const factor = line.unit === "kilo" && line.salesUnitKg && line.salesUnitKg > 0 ? line.salesUnitKg : 1;
  const soldUnits = missingQuantity ? 0 : qty / factor;

  // Steps 3–5, per invoice unit, before the box factor.
  const goodsPerUnit = missingQuantity ? 0 : (line.lineValue * line.rateToNok) / qty;
  const packagingPerUnit = line.packagingOverride ?? (isDrink ? settings.drinkPackagingNok : 0);
  const freightPerUnit =
    missingQuantity || !(totals.totalNetWeightKg > 0)
      ? 0
      : (totals.freightNok / totals.totalNetWeightKg) * (line.netWeightKg / qty);

  let dutyPerUnit: number | null;
  // Drinks (HS 2201, 2202, 2009, 2204, 2205, 2206): duty 0 even when the code carries a small rate (the client's
  // rule of 27.10.2026). Their cost is the packaging fee instead.
  // Once a declaration has priced the product itself, what it charged counts (a milk drink pays TL and no packaging fee).
  if (isDrink && !(line.dutyDeclared && (line.dutyPerKg != null || line.dutyPctOfValue != null))) dutyPerUnit = 0;
  else if (missingQuantity) dutyPerUnit = null;
  else if (line.dutyPctOfValue != null) dutyPerUnit = goodsPerUnit * line.dutyPctOfValue;
  else if (line.dutyPerKg === null) dutyPerUnit = null;
  else dutyPerUnit = (line.dutyPerKg * line.netWeightKg) / qty;

  const goodsNok = goodsPerUnit * factor;
  const packagingNok = packagingPerUnit * factor;
  const freightNok = freightPerUnit * factor;
  const dutyNok = dutyPerUnit === null ? null : dutyPerUnit * factor;

  const landedCost = dutyNok === null ? null : goodsNok + dutyNok + packagingNok + freightNok;
  const costInclVat = landedCost === null ? null : landedCost * (1 + vatRate);
  const suggestedPrice = costInclVat === null ? null : suggestPrice(costInclVat, settings);

  // Step 9: ACTIVE → keep what the shop sells it for; otherwise the suggestion.
  // A price the operator typed beats both.
  const fromShopify =
    line.shopifyStatus === "ACTIVE" && line.shopifyUnitPrice !== null ? line.shopifyUnitPrice : null;
  let ourPrice = line.ourPriceOverride ?? fromShopify ?? suggestedPrice;
  let casePrice = ourPrice !== null && line.pcsPerCarton ? orNull(ourPrice * line.pcsPerCarton) : null;

  // An ACTIVE product whose own prices do not multiply out is not something to "correct" silently:
  // keep what the shop charges per case, and judge the margin on that.
  let casePriceKept = false;
  // Also when the shop gives no usable unit price at all (an ACTIVE product with an empty productType,
  // typically "price per kg" goods): inventing a suggested price there would overwrite a price that is
  // right for a reason this tool cannot see. Keep it until the operator types one.
  const activeWithoutUnitPrice =
    line.shopifyStatus === "ACTIVE" && line.shopifyUnitPrice === null && line.shopifyCasePrice !== null;
  if (
    line.ourPriceOverride === null &&
    line.shopifyCasePrice !== null &&
    line.pcsPerCarton &&
    (activeWithoutUnitPrice ||
      (fromShopify !== null &&
        casePrice !== null &&
        Math.abs(casePrice - line.shopifyCasePrice) > Math.max(0.5, line.shopifyCasePrice * 0.005)))
  ) {
    casePriceKept = true;
    casePrice = line.shopifyCasePrice;
    ourPrice = line.shopifyCasePrice / line.pcsPerCarton;
  }
  const margin =
    ourPrice !== null && costInclVat !== null && ourPrice > 0 ? orNull((ourPrice - costInclVat) / ourPrice) : null;

  return {
    isDrink,
    soldUnits,
    goodsNok,
    dutyNok,
    packagingNok,
    freightNok,
    landedCost,
    costInclVat,
    suggestedPrice,
    ourPrice,
    casePrice,
    casePriceKept,
    margin,
    vatRate,
    flags: {
      missingDuty: dutyNok === null,
      marginBelowThreshold: margin !== null && margin < settings.marginThreshold,
      priceBelowCost: ourPrice !== null && costInclVat !== null && ourPrice < costInclVat,
      missingWeight,
      missingQuantity,
    },
  };
}

export interface ShipmentSummary {
  /** Sold value of every priced row: our price × units. Incl. VAT, because prices are. */
  salesInclVat: number;
  salesExclVat: number;
  /** Landed cost of the products, plus the shipment's separate costs. */
  costInclVat: number;
  costExclVat: number;
  profitInclVat: number;
  profitExclVat: number;
  marginInclVat: number | null;
  marginExclVat: number | null;
  /** Rows that could not be priced yet (duty missing), left out of the sums. */
  unpricedRows: number;
}

/**
 * Shipment-level numbers. Costs that are not products (customs clearance, pallets)
 * are NOT spread over the products — they are added here as plain shipment costs,
 * so the profit is honest while each product's own cost stays its own.
 */
export function summarize(rows: Array<{ result: LineResult }>, otherCostsNok: number): ShipmentSummary {
  let salesIncl = 0;
  let salesExcl = 0;
  let costIncl = 0;
  let costExcl = 0;
  let unpriced = 0;
  for (const { result: r } of rows) {
    if (r.ourPrice === null || r.costInclVat === null || r.landedCost === null) {
      unpriced++;
      continue;
    }
    salesIncl += r.ourPrice * r.soldUnits;
    salesExcl += (r.ourPrice * r.soldUnits) / (1 + r.vatRate);
    costIncl += r.costInclVat * r.soldUnits;
    costExcl += r.landedCost * r.soldUnits;
  }
  // Separate shipment costs carry no VAT split, so they count the same on both sides.
  costIncl += otherCostsNok;
  costExcl += otherCostsNok;
  return {
    salesInclVat: salesIncl,
    salesExclVat: salesExcl,
    costInclVat: costIncl,
    costExclVat: costExcl,
    profitInclVat: salesIncl - costIncl,
    profitExclVat: salesExcl - costExcl,
    marginInclVat: salesIncl > 0 ? (salesIncl - costIncl) / salesIncl : null,
    marginExclVat: salesExcl > 0 ? (salesExcl - costExcl) / salesExcl : null,
    unpricedRows: unpriced,
  };
}

/** Freight typed in one currency, converted with that currency's own rate. */
export function freightToNok(amount: number, currency: string, rates: Record<string, number>): number | null {
  if (currency === "NOK") return amount;
  const rate = rates[currency];
  return rate && rate > 0 ? amount * rate : null;
}
