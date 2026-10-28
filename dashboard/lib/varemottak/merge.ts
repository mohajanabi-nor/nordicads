/**
 * Step 1 of the pricing process: merge invoice lines that share an article number,
 * repair customs numbers that lost a leading zero, and notice when the "same" product
 * was invoiced at two different prices.
 *
 * Nothing is resolved silently. A price conflict keeps every price it saw and the
 * operator picks; a repaired HS code is marked so the screen can highlight it.
 */
import { round } from "./text";
import type { InvoiceLine, MergedLine } from "./types";

/**
 * Customs tariff numbers are 8 digits (CN8) or 10 (TARIC) and the 2-digit chapters 01–09
 * start with 0, so a number that went through a spreadsheet as a plain number arrives
 * one digit short. Add the zero only for exactly that shape — 7 or 9 digits — and say
 * so. A full-length code is never touched: the spec's looser rule would also rewrite
 * valid non-food codes (lighters 9613…, soap 3401…, toys 9503…) on the same invoice.
 */
export function fixHs(raw: string | null | undefined): { hs: string | null; fixed: boolean } {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return { hs: null, fixed: false };
  if (digits.length === 7 || digits.length === 9) return { hs: `0${digits}`, fixed: true };
  return { hs: digits, fixed: false };
}

/** Two unit prices are "the same" when they agree to within invoice rounding. */
function samePrice(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.003, Math.max(Math.abs(a), Math.abs(b)) * 0.005);
}

export function mergeLines(lines: InvoiceLine[]): MergedLine[] {
  const byIdx = new Map<string, InvoiceLine[]>();
  for (const l of lines) byIdx.set(l.idx, [...(byIdx.get(l.idx) ?? []), l]);

  const out: MergedLine[] = [];
  for (const [idx, group] of Array.from(byIdx)) {
    const first = group[0];
    const issues: string[] = [];

    if (group.some((l) => l.unit !== first.unit)) {
      issues.push(`Linjene har ulik enhet (${group.map((l) => `${l.no}: ${l.unit}`).join(", ")})`);
    }
    const countries = Array.from(new Set(group.map((l) => l.country).filter(Boolean)));
    if (countries.length > 1) issues.push(`Ulikt opprinnelsesland på samme varenummer: ${countries.join(", ")}`);

    const hsRaw = Array.from(new Set(group.map((l) => l.hs).filter((h): h is string => !!h)));
    if (hsRaw.length > 1) issues.push(`Ulike tollnummer på samme varenummer: ${hsRaw.join(", ")}`);
    const { hs, fixed } = fixHs(hsRaw[0] ?? null);

    const sum = (pick: (l: InvoiceLine) => number | null) => {
      const values = group.map(pick);
      return values.every((v) => v === null) ? null : round(values.reduce<number>((a, v) => a + (v ?? 0), 0));
    };
    const qty = round(group.reduce((a, l) => a + l.qty, 0));
    const cartons = sum((l) => l.cartons);
    const lineValue = sum((l) => l.lineValue);
    const netWeightKg = sum((l) => l.netWeightKg);

    // Cluster the source lines by unit price; more than one cluster is a conflict.
    const clusters: Array<{ unitPrice: number; qty: number; lines: number[] }> = [];
    for (const l of group) {
      if (l.lineValue === null || !(l.qty > 0)) continue;
      const p = l.lineValue / l.qty;
      const hit = clusters.find((c) => samePrice(c.unitPrice, p));
      if (hit) {
        hit.qty = round(hit.qty + l.qty);
        hit.lines.push(l.no);
      } else clusters.push({ unitPrice: round(p, 4), qty: l.qty, lines: [l.no] });
    }

    // Pieces per carton from this invoice. Only meaningful for pieces, and only when it
    // comes out whole: 6048 pcs ÷ 84 cartons = 72. A kg line's "carton" says nothing
    // about how many sales boxes it holds.
    let pcsPerCartonInvoice: number | null = null;
    if (first.unit === "pcs" && cartons && cartons > 0) {
      const ratio = qty / cartons;
      if (Math.abs(ratio - Math.round(ratio)) <= 0.02) pcsPerCartonInvoice = Math.round(ratio);
      else issues.push(`Antall per kartong går ikke opp (${round(ratio, 2)})`);
    }

    out.push({
      idx,
      name: first.name,
      unit: first.unit,
      qty,
      cartons,
      country: countries[0] ?? "",
      hs,
      hsFixed: fixed,
      netWeightKg,
      lineValue,
      unitPrice: lineValue !== null && qty > 0 ? round(lineValue / qty, 4) : null,
      priceConflict: clusters.length > 1 ? clusters : null,
      pcsPerCartonInvoice,
      ean: group.map((l) => l.ean ?? null).find((e) => e) ?? null,
      eanBox: group.map((l) => l.eanBox ?? null).find((e) => e) ?? null,
      lines: group.map((l) => l.no),
      issues,
    });
  }
  return out;
}

/** Customs-register lookups and Shopify matching key on the plain article number. */
export const sourceKey = (supplier: string, idx: string) => `${supplier.toLowerCase()}::${idx}`;
