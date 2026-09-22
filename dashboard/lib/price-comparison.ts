/**
 * Who is cheapest — and when that question has no honest answer.
 *
 * The comparison is the whole point of the feature, which makes a
 * confidently-wrong "cheapest" the worst thing it could produce. Two prices are
 * only ranked against each other when they are actually comparable:
 *
 *   currency   — a EUR quote is not cheaper than a NOK one, it is different.
 *   VAT basis  — an ex-VAT price looks 25% better than an inc-VAT one for no
 *                reason at all.
 *   unit       — 50 kr per box against 45 kr per kg ranks the wrong supplier
 *                unless the box weight is known.
 *
 * Where those differ, the row is flagged rather than ranked. "These two are not
 * directly comparable, look at them" is worth more than a number that reads as
 * fact and is not.
 *
 * Server-only.
 */
import { sbSelect } from "./supabase";

export interface SupplierPrice {
  supplierId: string;
  supplierName: string;
  price: number;
  currency: string;
  vatBasis: string;
  vatBasisAssumed: boolean;
  unit: string | null;
  packSize: string | null;
  pricePerBaseUnit: number | null;
  validFrom: string | null;
  observedAt: string;
  isLowest: boolean;
}

export interface ProductComparison {
  productId: string;
  productName: string;
  baseUnit: string | null;
  suppliers: SupplierPrice[];
  /** Why the row could not be ranked, if it could not be. */
  notComparable: string | null;
  lowestSupplierId: string | null;
  savingVsHighest: number | null;
}

interface ObservationRow {
  supplier_id: string;
  product_id: string;
  price: string | number;
  currency: string;
  vat_basis: string;
  vat_basis_assumed: boolean;
  unit: string | null;
  pack_size: string | null;
  price_per_base_unit: string | number | null;
  valid_from: string | null;
  observed_at: string;
}

const num = (v: string | number | null): number | null => {
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The price that counts for each supplier: the most recently VALID one.
 *
 * Deliberately not the most recently inserted. A price list that arrives late,
 * or is re-sent, must not override a newer one just because it was processed
 * second — the document's own date is what says which price is current.
 */
function currentPerSupplier(rows: ObservationRow[]): Map<string, ObservationRow> {
  const best = new Map<string, ObservationRow>();
  for (const row of rows) {
    const existing = best.get(row.supplier_id);
    if (!existing) {
      best.set(row.supplier_id, row);
      continue;
    }
    const a = row.valid_from ?? row.observed_at;
    const b = existing.valid_from ?? existing.observed_at;
    if (a > b) best.set(row.supplier_id, row);
  }
  return best;
}

/** What makes a set of prices unrankable, or null when they can be ranked. */
function comparabilityProblem(prices: SupplierPrice[]): string | null {
  if (prices.length < 2) return null;

  const currencies = new Set(prices.map((p) => p.currency));
  if (currencies.size > 1) {
    return `ulik valuta (${Array.from(currencies).join(", ")}) — ikke sammenlignet`;
  }

  const bases = new Set(prices.map((p) => p.vatBasis));
  if (bases.size > 1) {
    return "noen priser er med mva og noen uten — ikke sammenlignet";
  }

  // Per-unit prices are comparable whatever the pack size; raw prices are only
  // comparable when the pack and unit match.
  const allPerUnit = prices.every((p) => p.pricePerBaseUnit !== null);
  if (!allPerUnit) {
    const units = new Set(prices.map((p) => `${p.unit ?? "?"}|${p.packSize ?? "?"}`));
    if (units.size > 1) {
      return "ulik enhet eller pakningsstørrelse — ikke sammenlignet";
    }
  }
  return null;
}

/**
 * Current prices per product, ranked where ranking is meaningful.
 *
 * Products only one supplier quotes are still included: "only one supplier
 * carries this" is useful to see, and hiding it would make the catalogue look
 * smaller than it is.
 */
export async function buildComparison(limit = 500): Promise<ProductComparison[]> {
  const products = await sbSelect<{ id: string; canonical_name: string; base_unit: string | null }>(
    "products",
    { select: "id,canonical_name,base_unit", order: "canonical_name.asc", limit },
  );
  if (!products.length) return [];

  const suppliers = await sbSelect<{ id: string; name: string }>("suppliers", {
    select: "id,name",
  });
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));

  // One pass over recent observations rather than a query per product.
  const observations = await sbSelect<ObservationRow>("price_observations", {
    select:
      "supplier_id,product_id,price,currency,vat_basis,vat_basis_assumed,unit,pack_size,price_per_base_unit,valid_from,observed_at",
    order: "observed_at.desc",
    limit: 20_000,
  });

  const byProduct = new Map<string, ObservationRow[]>();
  for (const row of observations) {
    const list = byProduct.get(row.product_id);
    if (list) list.push(row);
    else byProduct.set(row.product_id, [row]);
  }

  const out: ProductComparison[] = [];

  for (const product of products) {
    const rows = byProduct.get(product.id);
    if (!rows?.length) continue;

    const prices: SupplierPrice[] = Array.from(currentPerSupplier(rows).values()).map((r) => ({
      supplierId: r.supplier_id,
      supplierName: supplierName.get(r.supplier_id) ?? "ukjent",
      price: num(r.price) ?? 0,
      currency: r.currency,
      vatBasis: r.vat_basis,
      vatBasisAssumed: r.vat_basis_assumed,
      unit: r.unit,
      packSize: r.pack_size,
      pricePerBaseUnit: num(r.price_per_base_unit),
      validFrom: r.valid_from,
      observedAt: r.observed_at,
      isLowest: false,
    }));

    const problem = comparabilityProblem(prices);
    let lowestSupplierId: string | null = null;
    let saving: number | null = null;

    if (!problem && prices.length) {
      const value = (p: SupplierPrice) => p.pricePerBaseUnit ?? p.price;
      const sorted = [...prices].sort((a, b) => value(a) - value(b));
      const cheapest = sorted[0];
      cheapest.isLowest = true;
      lowestSupplierId = cheapest.supplierId;
      if (sorted.length > 1) {
        const dearest = sorted[sorted.length - 1];
        saving = Number((value(dearest) - value(cheapest)).toFixed(2));
      }
    }

    prices.sort((a, b) => {
      const av = a.pricePerBaseUnit ?? a.price;
      const bv = b.pricePerBaseUnit ?? b.price;
      return av - bv;
    });

    out.push({
      productId: product.id,
      productName: product.canonical_name,
      baseUnit: product.base_unit,
      suppliers: prices,
      notComparable: problem,
      lowestSupplierId,
      savingVsHighest: saving,
    });
  }

  // Biggest spread first: the products where the choice of supplier matters
  // most are the ones worth looking at.
  out.sort((a, b) => (b.savingVsHighest ?? -1) - (a.savingVsHighest ?? -1));
  return out;
}
