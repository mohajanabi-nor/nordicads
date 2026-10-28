/**
 * Invoice control: does the spec file add up to the paper invoice?
 *
 * A reader that drops or merges a line makes every number downstream wrong without
 * any error, so this is the safety net — it ships with the import, not after it.
 *
 * Checks are returned as data (severity + Norwegian text) rather than thrown, because
 * a mismatch is something the operator decides about, not something that stops them.
 */
import { splitPdfExtras } from "./suppliers/stanro";
import type { ExtraLine, InvoiceLine, InvoiceTotals, ParsedInvoice } from "./types";

export type Severity = "ok" | "info" | "warn" | "block";

export interface ControlCheck {
  code: string;
  severity: Severity;
  text: string;
}

export interface ControlResult {
  checks: ControlCheck[];
  extraLines: ExtraLine[];
  /** Sum of the spec file's line values. */
  linesValue: number;
  /** What the shipment's separate (non-product) costs add up to, in the invoice currency. */
  extraValue: number;
  /** True when nothing is blocking. */
  ok: boolean;
}

const fmt = (n: number) => n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Sanctions screening is the client's rule: origin Russia or Belarus gets a mark. */
export const SANCTIONED_ORIGINS = ["RU", "BY"] as const;

/** Rounding tolerance: supplier lines are rounded to the cent one by one, so the sum drifts a little. */
export function valueTolerance(lineCount: number): number {
  return 0.02 + 0.001 * lineCount;
}

export function controlInvoice(parsed: ParsedInvoice, totals: InvoiceTotals | null): ControlResult {
  const checks: ControlCheck[] = [];
  const lines = parsed.lines;
  const linesValue = lines.reduce((a, l) => a + (l.lineValue ?? 0), 0);

  if (!totals) {
    checks.push({
      code: "NO_PDF",
      severity: "warn",
      text: "Ingen faktura-PDF lastet opp – summene kan ikke kontrolleres mot fakturaen.",
    });
    return { checks, extraLines: [], linesValue, extraValue: 0, ok: true };
  }

  if (totals.invoiceNo && totals.invoiceNo !== parsed.invoiceNo) {
    checks.push({
      code: "INVOICE_NO",
      severity: "block",
      text: `Fakturanummeret er ulikt: filen ${parsed.invoiceNo}, PDF ${totals.invoiceNo}.`,
    });
  }

  // Line-by-line: every spec line must be on the PDF with the same quantity.
  const byNo = new Map(totals.items.map((i) => [i.no, i]));
  const qtyMismatch: string[] = [];
  const notOnPdf: number[] = [];
  for (const l of lines) {
    const p = byNo.get(l.no);
    if (!p) {
      notOnPdf.push(l.no);
      continue;
    }
    const unitOk = (l.unit === "pcs" && (p.unit === "pcs" || p.unit.startsWith("szt"))) || (l.unit === "kilo" && p.unit === "kg");
    if (Math.abs(p.qty - l.qty) > 0.0005 || !unitOk) qtyMismatch.push(`linje ${l.no} (fil ${l.qty}, PDF ${p.qty})`);
  }
  if (!totals.items.length) {
    checks.push({ code: "PDF_EMPTY", severity: "block", text: "Ingen varelinjer kunne leses fra PDF-en." });
  }
  if (notOnPdf.length) {
    checks.push({ code: "NOT_ON_PDF", severity: "block", text: `Linjer i filen som ikke finnes i PDF-en: ${notOnPdf.join(", ")}.` });
  }
  if (qtyMismatch.length) {
    checks.push({ code: "QTY_MISMATCH", severity: "block", text: `Antall er ulikt mellom fil og PDF: ${qtyMismatch.slice(0, 8).join("; ")}.` });
  }

  const derived = splitPdfExtras(parsed, totals);
  const missingFromCsv = derived.missingFromCsv;
  // Lines a reader marked as costs outright (the PDF-only path), plus any the PDF shows that the spec lacks.
  const extraLines = [...totals.extraLines, ...derived.extraLines.filter((d) => !totals.extraLines.some((e) => e.no === d.no))];
  if (missingFromCsv.length) {
    checks.push({
      code: "MISSING_FROM_FILE",
      severity: "block",
      text: `Varer på PDF-en som mangler i filen: ${missingFromCsv.map((m) => `${m.no} ${m.name}`).join("; ")}.`,
    });
  }
  const extraValue = extraLines.reduce((a, e) => a + e.value, 0);
  if (extraLines.length) {
    checks.push({
      code: "EXTRA_LINES",
      severity: "info",
      text: `Kostnader som ikke er varer (føres som egne forsendelseskostnader, ikke fordelt på varene): ${extraLines
        .map((e) => `${e.name} ${fmt(e.value)}`)
        .join("; ")}.`,
    });
  }

  // Totals.
  if (totals.netTotal !== null) {
    const diff = linesValue + extraValue - totals.netTotal;
    const tol = valueTolerance(lines.length);
    if (Math.abs(diff) <= tol) {
      checks.push({
        code: "TOTAL",
        severity: "ok",
        text: `Summen stemmer med fakturaen (${fmt(totals.netTotal)} ${totals.currency ?? ""}${
          Math.abs(diff) >= 0.005 ? `, avrundingsforskjell ${fmt(diff)}` : ""
        }).`,
      });
    } else {
      checks.push({
        code: "TOTAL",
        severity: "block",
        text: `Summen stemmer ikke: linjer ${fmt(linesValue)} + kostnader ${fmt(extraValue)} mot faktura ${fmt(totals.netTotal)} (forskjell ${fmt(diff)}).`,
      });
    }
  }

  // VAT on an export invoice should be zero; if the supplier charged some it has to be credited.
  if (totals.vatTotal !== null && totals.vatTotal > 0.005) {
    checks.push({
      code: "FOREIGN_VAT",
      severity: "warn",
      text: `Leverandøren har fakturert mva ${fmt(totals.vatTotal)} ${totals.currency ?? ""} på en eksportfaktura – denne skal krediteres.`,
    });
  }

  // Weights. The PDF's net weight includes pallets, so a difference is information, not an error.
  const fileWeight = lines.reduce((a, l) => a + (l.netWeightKg ?? 0), 0);
  if (totals.netWeightKg !== null && fileWeight > 0) {
    const diff = totals.netWeightKg - fileWeight;
    if (Math.abs(diff) > 0.01) {
      checks.push({
        code: "WEIGHT",
        severity: "info",
        text: `Nettovekt: varelinjene ${fmt(fileWeight)} kg mot fakturaen ${fmt(totals.netWeightKg)} kg (forskjell ${fmt(diff)} kg – ofte paller). Frakt fordeles på vekten til varene.`,
      });
    }
  }

  return { checks, extraLines, linesValue, extraValue, ok: !checks.some((c) => c.severity === "block") };
}

/** Per-line sanity checks that need no PDF. */
export function lineWarnings(lines: InvoiceLine[]): ControlCheck[] {
  const checks: ControlCheck[] = [];
  const sanctioned = lines.filter((l) => (SANCTIONED_ORIGINS as readonly string[]).includes(l.country));
  if (sanctioned.length) {
    checks.push({
      code: "SANCTIONS",
      severity: "warn",
      text: `Varer fra Russland/Belarus – sanksjonssjekk nødvendig: ${sanctioned.map((l) => `${l.no} ${l.idx}`).join(", ")}.`,
    });
  }
  return checks;
}

/**
 * Net weight per piece that looks wrong. Duty and freight both follow net weight, so a
 * supplier's typo (100 lighters at 0.1 kg) silently moves the cost. Compare against the
 * grams in the product name when there are any ("220g", "1kg", "0,5l").
 */
export function weightPerUnitLooksWrong(
  name: string,
  unit: "pcs" | "kilo",
  qty: number,
  netWeightKg: number | null,
  grossWeightKg: number | null = null,
): string | null {
  if (netWeightKg === null || !(qty > 0)) return null;
  // Gross weight is net plus packaging. Display-heavy toy sweets can run to ~5× (real
  // example: 1.2 kg net, 5.6 kg gross), so only a wild ratio is a typo: 0.1 kg net with
  // 10 kg gross is 100×.
  if (grossWeightKg !== null && netWeightKg > 0 && grossWeightKg / netWeightKg > 10) {
    return `Nettovekt ${netWeightKg} kg mot bruttovekt ${grossWeightKg} kg – en av dem er trolig feil`;
  }
  if (unit === "kilo") {
    return Math.abs(netWeightKg - qty) > qty * 0.02 + 0.05 ? `Nettovekt ${netWeightKg} kg for ${qty} kg solgt` : null;
  }
  const t = name.toLowerCase().replace(/(\d),(\d)/g, "$1.$2");
  // A name that describes a multi-pack ("2400 g (200 Pieces)", "90g/18pcs", "(3 x 25 g)")
  // does not say what one sold piece weighs, so the size in it proves nothing.
  // "20*2G" and "8*29G" are the same multi-pack written with a star.
  if (/\/\s*\d+\s*(pcs|psc|pieces|s)\b|\(\s*\d+\s*(pieces|pcs)|\d\s*[x*×]\s*\d/.test(t)) return null;
  const m = t.match(/(?<![\d.x])(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  const grams = m[2] === "kg" ? n * 1000 : m[2] === "g" ? n : m[2] === "l" ? n * 1000 : m[2] === "cl" ? n * 10 : n;
  if (!(grams > 0)) return null;
  const perUnitG = (netWeightKg * 1000) / qty;
  const ratio = perUnitG / grams;
  // Packaging adds a little and liquids are not 1 g/ml, so allow 0.3×–3×; anything beyond is a typo.
  return ratio < 0.3 || ratio > 3
    ? `Vekt per stk ${Math.round(perUnitG)} g, men navnet sier ${Math.round(grams)} g`
    : null;
}
