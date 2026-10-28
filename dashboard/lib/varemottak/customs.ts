/**
 * The customs register: duty in NOK per kg, so the same rate is never typed twice.
 *
 * Lookup order (the client's, and never guessed from a product name or an HS "family"):
 *   1. a verified rate from a customs declaration for the same CN8 code;
 *   2. the same product (supplier + article number) from an earlier shipment;
 *   3. a verified rate for the same HS6 — only when every verified rate under that HS6
 *      agrees, because two CN8 codes under one HS6 can carry different duty;
 *   4. nothing. The cell stays empty and highlighted for the operator to fill in.
 *
 * Each rate keeps its source (declaration number, or "typed by us, estimate") and date.
 * A declaration always beats an estimate.
 */

export type RateScope = "cn8" | "product" | "hs6";
export type RateSourceKind = "declaration" | "estimate";

export interface CustomsRate {
  scope: RateScope;
  cn8: string | null;
  hs6: string | null;
  supplier: string | null;
  idx: string | null;
  duty_per_kg: number;
  /** A rate charged on the goods value instead (0.19 = 19 %); duty_per_kg is then 0 and not used. Product rates only. */
  duty_pct?: number | null;
  source_kind: RateSourceKind;
  source_ref: string;
  /** ISO date; later wins. */
  source_date: string;
}

/** How a line's rate was found — shown next to the number so the operator knows how far to trust it. */
// "product" is only what older saved rows carry: a rate for the same product, whatever its source.
export type DutyKind = "declaration" | "cn8" | "hs6" | "estimate" | "product";

export interface DutyLookup {
  /** Null when the product's rate is a percentage of value (dutyPct). */
  dutyPerKg: number | null;
  dutyPct?: number | null;
  kind: DutyKind;
  /** "Deklarasjon 25NO12345", "Samme vare, forrige sending (typed by us, estimate)", … */
  source: string;
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const latest = (rows: CustomsRate[]) => [...rows].sort((a, b) => (a.source_date < b.source_date ? 1 : -1))[0];

/**
 * The client's lookup order (module 5 handoff), first hit wins:
 *   1. the same product in a customs declaration         (green)
 *   2. the same CN8 in a declaration, when ALL declared rates for it agree   (blue)
 *   3. the same HS6, when all verified rates under it agree  (blue, "reserve")
 *   4. the rate typed for that product earlier (an estimate) (yellow)
 *   5. nothing: the cell stays empty, never 0.
 * A CN8 that has been declared at two different rates (sausages 0 or 84,31 kr/kg by tariff quota; croissants
 * by milk and sugar content) is ambiguous and is never applied by itself: only a product's own rate counts.
 */
export function lookupDuty(
  line: { supplier: string; idx: string; hs: string | null },
  rates: CustomsRate[],
): DutyLookup | null {
  const hs = digits(line.hs);
  const supplier = line.supplier.toLowerCase();
  const own = rates.filter((r) => r.scope === "product" && (r.supplier ?? "").toLowerCase() === supplier && r.idx === line.idx);

  // 1. The same product in a declaration.
  const declared = latest(own.filter((r) => r.source_kind === "declaration"));
  if (declared) return { dutyPerKg: declared.duty_pct != null ? null : declared.duty_per_kg, dutyPct: declared.duty_pct ?? null, kind: "declaration", source: `Deklarasjon ${declared.source_ref}` };

  // 2. The same CN8, declared, and unambiguous.
  if (hs.length >= 8) {
    const cn8 = hs.slice(0, 8);
    const seen = rates.filter((r) => r.scope === "cn8" && r.source_kind === "declaration" && digits(r.cn8) === cn8);
    if (seen.length && new Set(seen.map((r) => r.duty_per_kg.toFixed(4))).size === 1) {
      const hit = latest(seen);
      return { dutyPerKg: hit.duty_per_kg, kind: "cn8", source: `Register CN8 ${cn8} (deklarasjon ${hit.source_ref})` };
    }
  }

  // 3. The same HS6, only if the verified rates under it agree.
  if (hs.length >= 6) {
    const hs6 = hs.slice(0, 6);
    const verified = rates.filter(
      (r) =>
        r.source_kind === "declaration" &&
        ((r.scope === "cn8" && digits(r.cn8).startsWith(hs6)) || (r.scope === "hs6" && digits(r.hs6) === hs6)),
    );
    if (verified.length && new Set(verified.map((r) => r.duty_per_kg.toFixed(4))).size === 1) {
      const hit = latest(verified);
      return { dutyPerKg: hit.duty_per_kg, kind: "hs6", source: `Samme HS6 ${hs6} (${hit.source_ref})` };
    }
  }

  // 4. A rate typed for this product earlier.
  const estimate = latest(own.filter((r) => r.source_kind === "estimate"));
  if (estimate) {
    return { dutyPerKg: estimate.duty_pct != null ? null : estimate.duty_per_kg, dutyPct: estimate.duty_pct ?? null, kind: "estimate", source: `Samme vare tidligere (${estimate.source_ref}, ${estimate.source_date})` };
  }
  return null;
}

/** The rate a declaration item implies: duty paid ÷ net weight. */
export function dutyPerKgFromDeclaration(dutyNok: number, netWeightKg: number): number | null {
  return netWeightKg > 0 && dutyNok >= 0 ? Math.round((dutyNok / netWeightKg) * 10000) / 10000 : null;
}
