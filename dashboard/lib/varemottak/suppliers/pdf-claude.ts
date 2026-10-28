/**
 * A supplier invoice that arrives as a PDF only — read with Claude.
 *
 * This is the fallback for suppliers who send no spec file. It is the least trustworthy
 * way in (a model can drop, merge or mis-read a line), so the invoice-control step that
 * follows every import is mandatory here: the sum of the lines must equal the invoice
 * total, or the import says so.
 *
 * Output is compact — one array per line, not one object — because a 270-line invoice
 * has to fit in a single response. A response that does not parse (cut off, or wrapped
 * in prose) is refused rather than repaired: half an invoice must not look like a whole one.
 */
import { callClaude } from "../../price-extraction";
import { num } from "../text";
import type { InvoiceLine, InvoiceTotals, ParsedInvoice, Unit } from "../types";

const PROMPT = `You read a supplier invoice (PDF) for a Norwegian wholesaler that imports food.

Return ONLY valid JSON, no explanation, no markdown fences, exactly this shape:
{
  "invoice_no": "string",
  "invoice_date": "YYYY-MM-DD or null",
  "currency": "EUR | PLN | USD | ... (ISO code)",
  "net_total": number or null,        // invoice total excl. VAT as printed
  "vat_total": number or null,        // VAT charged by the supplier; 0 if none
  "net_weight_kg": number or null,    // total net weight if printed
  "lines": [
    [no, "article_number", "description", quantity, "pcs|kg", unit_price, line_value, "tariff_number or null", "origin ISO-2 or null", net_weight_kg or null, cartons or null]
  ],
  "services": [ ["description", line_value] ]   // costs that are NOT goods: transport, customs clearance, pallets, deposits
}

Rules:
- One entry in "lines" for EVERY goods line. Never summarise, never skip, never merge lines.
- Numbers are plain JSON numbers with a dot as decimal separator ("1.234,50" -> 1234.5).
- "article_number" is the supplier's own article/item number exactly as printed. If a line has none, use null — do not invent one.
- Use "kg" as unit only when the line is sold by weight; otherwise "pcs".
- Put non-goods lines in "services", not in "lines".
- Do not guess a field that is not on the invoice: use null.`;

export type CallClaude = (content: Array<{ type: string; [k: string]: unknown }>, maxTokens?: number, opts?: { stream?: boolean; retries?: number; noThinking?: boolean }) => Promise<{ text: string; model: string }>;

interface Raw {
  invoice_no?: unknown;
  invoice_date?: unknown;
  currency?: unknown;
  net_total?: unknown;
  vat_total?: unknown;
  net_weight_kg?: unknown;
  lines?: unknown;
  services?: unknown;
}

const asNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return num(v);
  return null;
};
const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export interface PdfExtraction {
  parsed: ParsedInvoice;
  totals: InvoiceTotals;
  model: string;
}

export async function extractInvoiceFromPdf(
  bytes: Uint8Array,
  opts: { supplier: string; currency?: string; invoiceNo?: string; call?: CallClaude },
): Promise<PdfExtraction> {
  const call = opts.call ?? callClaude;
  const { text, model } = await call(
    [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") } },
      { type: "text", text: PROMPT },
    ],
    32000,
    // A whole invoice is a long answer: stream it, and do not pay for three full attempts.
    { stream: true, retries: 2, noThinking: true },
  );
  return mapExtraction(text, model, opts);
}

/** Separated from the API call so it can be tested with canned responses. */
export function mapExtraction(text: string, model: string, opts: { supplier: string; currency?: string; invoiceNo?: string }): PdfExtraction {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: Raw;
  try {
    raw = JSON.parse(body) as Raw;
  } catch {
    throw new Error("PDF-en kunne ikke leses fullstendig (svaret fra Claude var avkortet eller ugyldig). Last opp spesifikasjonsfilen i stedet, eller del opp PDF-en.");
  }
  if (!Array.isArray(raw.lines) || !raw.lines.length) throw new Error("Fant ingen varelinjer i PDF-en");

  const warnings: string[] = ["Linjene er lest fra PDF med AI – sjekk fakturakontrollen nøye"];
  const currency = (asStr(raw.currency) || opts.currency || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Fant ikke fakturaens valuta – oppgi den");
  if (opts.currency && currency !== opts.currency.toUpperCase()) {
    throw new Error(`Valutaen i PDF-en (${currency}) er ikke den du oppga (${opts.currency.toUpperCase()})`);
  }
  const invoiceNo = opts.invoiceNo || asStr(raw.invoice_no) || "PDF";

  const lines: InvoiceLine[] = [];
  const missingIdx: number[] = [];
  const items: InvoiceTotals["items"] = [];
  (raw.lines as unknown[]).forEach((entry, i) => {
    if (!Array.isArray(entry)) return;
    const [no, idx, name, qty, unit, unitPrice, value, hs, country, netKg, cartons] = entry;
    const lineNo = asNum(no) ?? i + 1;
    const q = asNum(qty);
    if (q === null || q <= 0) {
      warnings.push(`Linje ${lineNo}: antall kunne ikke leses og linjen er utelatt`);
      return;
    }
    const idxStr = asStr(idx);
    if (!idxStr) {
      missingIdx.push(lineNo);
      return;
    }
    const u: Unit = /^kg/i.test(asStr(unit)) ? "kilo" : "pcs";
    const v = asNum(value) ?? (asNum(unitPrice) !== null ? Math.round((asNum(unitPrice) as number) * q * 10000) / 10000 : null);
    lines.push({
      no: lineNo,
      idx: idxStr,
      name: asStr(name),
      qty: q,
      unit: u,
      cartons: asNum(cartons),
      country: asStr(country).toUpperCase().slice(0, 2),
      hs: asStr(hs).replace(/\D/g, "") || null,
      netWeightKg: asNum(netKg),
      grossWeightKg: null,
      lineValue: v,
      invoiceNo,
    });
    items.push({ no: lineNo, name: asStr(name), qty: q, unit: u === "kilo" ? "kg" : "pcs", unitPrice: asNum(unitPrice) ?? (v !== null ? v / q : NaN), value: v ?? NaN });
  });
  if (missingIdx.length) {
    throw new Error(`Linje ${missingIdx.slice(0, 10).join(", ")}${missingIdx.length > 10 ? " …" : ""} har ikke varenummer i PDF-en. Uten varenummer kan varene ikke kobles til Shopify – last opp spesifikasjonsfilen.`);
  }
  if (!lines.length) throw new Error("Ingen varelinjer med antall og varenummer kunne leses fra PDF-en");

  const services = Array.isArray(raw.services) ? (raw.services as unknown[]) : [];
  const extraLines = services
    .filter((s): s is unknown[] => Array.isArray(s))
    .map((s, i) => ({ no: 1000 + i, name: asStr(s[0]), qty: 1, unit: "pcs", value: asNum(s[1]) ?? 0 }))
    .filter((e) => e.value !== 0);

  const totals: InvoiceTotals = {
    invoiceNo: asStr(raw.invoice_no) || null,
    invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(asStr(raw.invoice_date)) ? asStr(raw.invoice_date) : null,
    currency,
    netTotal: asNum(raw.net_total),
    vatTotal: asNum(raw.vat_total),
    grossTotal: null,
    netWeightKg: asNum(raw.net_weight_kg),
    items,
    extraLines,
  };
  return { parsed: { supplier: opts.supplier, invoiceNo, currency, lines, warnings }, totals, model };
}
