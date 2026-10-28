/**
 * Purchase price history: what we paid per supplier + article number last time, and
 * what changed.
 *
 *   price up    → red row
 *   price down  → green row
 *   price up while our shop price did not move → "Supplier raised price – check our
 *   price", with the new suggested price shown next to it
 *
 * Prices are compared in the invoice currency: a krone-converted comparison would mix a
 * supplier's price change with an exchange-rate change, which is not what the client asked.
 */

export interface PreviousPurchase {
  unit_price: number;
  currency: string;
  /** Our price per unit when that shipment was priced. */
  our_price: number | null;
  cost_incl_vat: number | null;
  invoice_no: string | null;
  occurred_on: string;
}

export type PriceDirection = "up" | "down" | "same" | "new" | "other-currency";

export interface PriceChange {
  direction: PriceDirection;
  previousUnitPrice: number | null;
  previousDate: string | null;
  /** (new − old) ÷ old, e.g. 0.12 = +12 %. */
  changePct: number | null;
  /** Supplier raised the price and our shop price is the same as last time. */
  raisedWhileOurPriceUnchanged: boolean;
}

/** Moves smaller than this are rounding on the supplier's side, not a price change. */
const NOISE = 0.005;

export function compareToHistory(
  newUnitPrice: number | null,
  currency: string,
  previous: PreviousPurchase | null,
  /** Shopify's current unit price (productType) for an ACTIVE product, else null. */
  currentOurPrice: number | null,
): PriceChange {
  if (!previous || newUnitPrice === null) {
    return { direction: "new", previousUnitPrice: null, previousDate: null, changePct: null, raisedWhileOurPriceUnchanged: false };
  }
  if (previous.currency !== currency) {
    return { direction: "other-currency", previousUnitPrice: previous.unit_price, previousDate: previous.occurred_on, changePct: null, raisedWhileOurPriceUnchanged: false };
  }
  const changePct = previous.unit_price > 0 ? (newUnitPrice - previous.unit_price) / previous.unit_price : null;
  const direction: PriceDirection =
    changePct === null || Math.abs(changePct) <= NOISE ? "same" : changePct > 0 ? "up" : "down";
  const raised =
    direction === "up" &&
    currentOurPrice !== null &&
    previous.our_price !== null &&
    Math.abs(currentOurPrice - previous.our_price) < 0.005;
  return {
    direction,
    previousUnitPrice: previous.unit_price,
    previousDate: previous.occurred_on,
    changePct,
    raisedWhileOurPriceUnchanged: raised,
  };
}

export interface ImportSummary {
  total: number;
  up: number;
  down: number;
  same: number;
  new: number;
  /** The biggest increases, largest first. */
  largestIncreases: Array<{ idx: string; name: string; changePct: number }>;
  /** Rows whose margin falls below the threshold at the suggested/current price. */
  belowMargin: Array<{ idx: string; name: string; margin: number }>;
  raisedWithoutPriceChange: number;
}

export function summarizeImport(
  rows: Array<{ idx: string; name: string; change: PriceChange; margin: number | null }>,
  marginThreshold: number,
  top = 5,
): ImportSummary {
  const out: ImportSummary = {
    total: rows.length,
    up: 0,
    down: 0,
    same: 0,
    new: 0,
    largestIncreases: [],
    belowMargin: [],
    raisedWithoutPriceChange: 0,
  };
  for (const r of rows) {
    if (r.change.direction === "up") out.up++;
    else if (r.change.direction === "down") out.down++;
    else if (r.change.direction === "same") out.same++;
    else out.new++;
    if (r.change.raisedWhileOurPriceUnchanged) out.raisedWithoutPriceChange++;
    if (r.margin !== null && r.margin < marginThreshold) out.belowMargin.push({ idx: r.idx, name: r.name, margin: r.margin });
  }
  out.largestIncreases = rows
    .filter((r) => r.change.direction === "up" && r.change.changePct !== null)
    .map((r) => ({ idx: r.idx, name: r.name, changePct: r.change.changePct as number }))
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, top);
  out.belowMargin.sort((a, b) => a.margin - b.margin);
  return out;
}

// ---------------------------------------------------------------------------------------- price increase alert

/** The client's thresholds (module 6, step 12): supplier price up 10 % or more, or cost incl. VAT up 15 % or more. */
export const ALERT_SUPPLIER_PCT = 0.1;
export const ALERT_COST_PCT = 0.15;
/** A cost of exactly this was set when a product was created, not paid: it is never a real "previous cost". */
const PLACEHOLDER_COSTS = [8];

export interface PriceAlert {
  /** (new − old) ÷ old of the supplier's price, when it is at or over the threshold. */
  supplierPct: number | null;
  /** The same for our cost incl. VAT, when it is at or over the threshold. */
  costPct: number | null;
}

/**
 * Whether a product's cost moved enough against the previous purchase to be looked at. Compared per unit in the
 * invoice currency for the supplier's price, and in kroner for the cost. A placeholder previous cost is ignored.
 */
export function priceAlert(change: PriceChange | null | undefined, previous: PreviousPurchase | null | undefined, costInclVat: number | null): PriceAlert | null {
  if (!previous) return null;
  const supplierPct = change && change.direction === "up" && change.changePct !== null && change.changePct >= ALERT_SUPPLIER_PCT - 1e-9 ? change.changePct : null;
  const prev = previous.cost_incl_vat;
  const real = prev !== null && prev > 0 && !PLACEHOLDER_COSTS.some((p) => Math.abs(prev - p) < 0.005);
  const rise = real && costInclVat !== null ? (costInclVat - (prev as number)) / (prev as number) : null;
  const costPct = rise !== null && rise >= ALERT_COST_PCT - 1e-9 ? rise : null;
  return supplierPct === null && costPct === null ? null : { supplierPct, costPct };
}
