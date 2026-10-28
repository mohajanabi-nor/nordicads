/**
 * Stanro (MPT Stanro Sp. z o.o.) — the specification CSV and the paper invoice PDF.
 *
 * The CSV is the data source: cp1250, ';' separated, decimal comma, article numbers
 * wrapped as ="71806000AXE". It carries tariff number, weights and net value, which the
 * goods-receipt tool ignores but pricing needs. It has no unit price (value ÷ quantity)
 * and no EAN.
 *
 * The PDF is the paper invoice. It carries what the CSV leaves out: the totals, and
 * lines that are not products (export customs clearance, pallets). Those are read here
 * so invoice control can reconcile the two.
 *
 * Ported from the shape of the supplier-automation tool's reader (same column names,
 * same encodings) so a fix to Stanro's format can be carried across either way.
 */
import { cleanCell, decodeSupplierText, num, splitCsvLine } from "../text";
import type { ExtraLine, InvoiceLine, InvoiceTotals, ParsedInvoice, Unit } from "../types";

const HEADERS = {
  no: ["no", "lp", "lp."],
  idx: ["product number", "index", "indeks"],
  name: ["description", "nazwa"],
  qty: ["quantity", "ilość", "ilosc"],
  unit: ["unit", "jm"],
  cartons: ["packaging", "opakowania"],
  country: ["country of origin", "kraj pochodzenia"],
  hs: ["tariff number", "numer taryfowy", "kod cn"],
  netWeight: ["net weight", "waga netto"],
  grossWeight: ["gross weight", "waga brutto"],
  netValue: ["net value", "wartość netto", "wartosc netto"],
  invoice: ["invoice number", "numer faktury"],
} as const;

/** Columns the pricing needs beyond what receiving needs. A file without them is refused, not guessed at. */
const REQUIRED = ["no", "idx", "name", "qty", "unit", "invoice"] as const;

export const STANRO_CURRENCY = "PLN";

export function parseStanroCsv(bytes: Uint8Array, filename: string): ParsedInvoice {
  const { text, encoding } = decodeSupplierText(bytes);
  const warnings: string[] = [];
  if (text.includes("�")) {
    warnings.push(`Filen har tegn som ikke kan leses (lest som ${encoding}); polske bokstaver kan være feil`);
  }
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rows.length < 2) throw new Error(`${filename}: ingen datalinjer`);

  const header = splitCsvLine(rows[0]).map((h) => h.trim().toLowerCase());
  const col = {} as Record<keyof typeof HEADERS, number>;
  for (const [key, names] of Object.entries(HEADERS) as [keyof typeof HEADERS, readonly string[]][]) {
    col[key] = header.findIndex((h) => names.includes(h));
    if (col[key] < 0 && (REQUIRED as readonly string[]).includes(key)) {
      throw new Error(`${filename}: kolonnen "${names[0]}" mangler. Overskrift: ${header.join(" | ")}`);
    }
  }
  for (const key of ["hs", "netWeight", "netValue"] as const) {
    if (col[key] < 0) warnings.push(`Kolonnen "${HEADERS[key][0]}" mangler – ${key === "hs" ? "tollnummer" : key === "netWeight" ? "vekt" : "verdi"} må fylles inn for hånd`);
  }

  const cell = (f: string[], key: keyof typeof HEADERS) => (col[key] >= 0 ? f[col[key]] ?? "" : "");
  const lines: InvoiceLine[] = [];
  const invoiceNos = new Set<string>();

  for (let r = 1; r < rows.length; r++) {
    const f = splitCsvLine(rows[r]);
    if (f.length < 6 || f.every((x) => !x.trim())) continue;
    const where = `rad ${r + 1}`;
    if (!cell(f, "no").trim()) {
      if (cleanCell(cell(f, "idx"))) throw new Error(`${filename} ${where}: ${cleanCell(cell(f, "idx"))} har ikke linjenummer`);
      continue;
    }
    const no = Number(cell(f, "no").trim());
    const idx = cleanCell(cell(f, "idx"));
    const qty = num(cell(f, "qty"));
    const unitRaw = cell(f, "unit").trim().toLowerCase();
    const unit: Unit | null =
      unitRaw === "pcs" || unitRaw === "szt" ? "pcs" : unitRaw === "kilo" || unitRaw === "kg" ? "kilo" : null;
    if (!Number.isInteger(no)) throw new Error(`${filename} ${where}: linjenummer "${cell(f, "no")}" er ikke et tall`);
    if (!idx) throw new Error(`${filename} ${where} (linje ${no}): tomt varenummer`);
    if (qty == null) throw new Error(`${filename} ${where} (linje ${no}): antall er ikke et tall`);
    if (!unit) throw new Error(`${filename} ${where} (linje ${no}): ukjent enhet "${cell(f, "unit")}"`);

    const inv = cell(f, "invoice").trim();
    if (inv) invoiceNos.add(inv);
    const hsDigits = cleanCell(cell(f, "hs")).replace(/\D/g, "");
    lines.push({
      no,
      idx,
      name: cell(f, "name").trim(),
      qty,
      unit,
      cartons: num(cell(f, "cartons")),
      country: cell(f, "country").trim().toUpperCase(),
      hs: hsDigits || null,
      netWeightKg: num(cell(f, "netWeight")),
      grossWeightKg: num(cell(f, "grossWeight")),
      lineValue: num(cell(f, "netValue")),
      invoiceNo: inv,
    });
  }

  if (!lines.length) throw new Error(`${filename}: ingen fakturalinjer`);
  if (invoiceNos.size !== 1) {
    throw new Error(`${filename}: forventet ett fakturanummer, fant ${invoiceNos.size ? [...invoiceNos].join(", ") : "ingen"}`);
  }
  const dup = lines.map((l) => l.no).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) throw new Error(`${filename}: linjenummer forekommer to ganger: ${[...new Set(dup)].join(", ")}`);

  return { supplier: "Stanro", invoiceNo: [...invoiceNos][0], currency: STANRO_CURRENCY, lines, warnings };
}

// ---------------------------------------------------------------- PDF

/** Rebuild text lines from PDF text items, grouped by baseline (like `pdftotext -layout`). */
export async function pdfTextLines(bytes: Uint8Array): Promise<string[]> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string; w: number }[]>();
    for (const it of content.items as { str: string; transform: number[]; width: number }[]) {
      if (!("str" in it) || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] * 2) / 2;
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      rows.set(key, [...(rows.get(key) ?? []), { x: it.transform[4], s: it.str, w: it.width }]);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const parts = rows.get(y)!.sort((a, b) => a.x - b.x);
      let line = "";
      let end = -Infinity;
      for (const part of parts) {
        line += (line && part.x - end > 1 ? "  " : "") + part.s;
        end = part.x + part.w;
      }
      out.push(line.replace(/\s+$/, ""));
    }
  }
  return out;
}

/** "  12. Name …  240 pcs 4,34 1.041,60" — number, name, qty, unit, unit price, value. */
const PDF_ITEM = /^\s*(\d+)\.\s+(.*?)\s+(\d[\d.]*(?:,\d+)?)\s+(pcs|kg|szt det|szt)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})\s*$/;
const PDF_VAT_ROW = /^\s*(\d+,\d)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})\s*$/;

/** Lines that are costs of getting the goods here rather than goods. */
const NON_PRODUCT = /customs|clearance|odpraw|paleta|pallet|epal|transport|freight|shipping|delivery|dostaw/i;

export function parseStanroPdf(textLines: string[]): InvoiceTotals {
  const totals: InvoiceTotals = {
    invoiceNo: null,
    invoiceDate: null,
    currency: null,
    netTotal: null,
    vatTotal: null,
    grossTotal: null,
    netWeightKg: null,
    items: [],
    extraLines: [],
  };
  for (const raw of textLines) {
    const line = raw.replace(/\s+/g, " ");

    const inv = line.match(/Invoice No\s*:\s*([0-9A-Z/]+)/i);
    if (inv && !totals.invoiceNo) totals.invoiceNo = inv[1];
    const date = line.match(/Date of issue\s*:\s*(\d{4}-\d{2}-\d{2})/i);
    if (date && !totals.invoiceDate) totals.invoiceDate = date[1];

    const item = line.match(PDF_ITEM);
    if (item) {
      totals.items.push({
        no: Number(item[1]),
        name: item[2].trim(),
        qty: num(item[3]) ?? NaN,
        unit: item[4],
        unitPrice: num(item[5]) ?? NaN,
        value: num(item[6]) ?? NaN,
      });
      continue;
    }

    const pay = line.match(/Total to pay\s*:\s*(-?[\d.]+,\d{2})\s*([A-Z]{3})/i);
    if (pay) {
      totals.grossTotal = num(pay[1]);
      totals.currency = pay[2];
    }
    const weight = line.match(/Net weight\s*:\s*([\d.]+,?\d*)\s*kg/i);
    if (weight && totals.netWeightKg === null) totals.netWeightKg = num(weight[1]);

    // The VAT summary row: rate, net, VAT, gross. Only the first (the invoice's own) counts.
    const vat = line.match(PDF_VAT_ROW);
    if (vat && totals.netTotal === null) {
      totals.netTotal = num(vat[2]);
      totals.vatTotal = num(vat[3]);
      if (totals.grossTotal === null) totals.grossTotal = num(vat[4]);
    }
  }
  return totals;
}

/**
 * The PDF's item lines that are not in the CSV, split into services (known kinds of
 * cost, kept as separate shipment costs) and anything else (a product the spec file
 * left out — reported, never silently dropped).
 */
export function splitPdfExtras(
  parsed: ParsedInvoice,
  totals: InvoiceTotals,
): { extraLines: ExtraLine[]; missingFromCsv: Array<{ no: number; name: string; qty: number; value: number }> } {
  const csvNos = new Set(parsed.lines.map((l) => l.no));
  const extraLines: ExtraLine[] = [];
  const missingFromCsv: Array<{ no: number; name: string; qty: number; value: number }> = [];
  for (const p of totals.items) {
    if (csvNos.has(p.no)) continue;
    if (NON_PRODUCT.test(p.name)) extraLines.push({ no: p.no, name: p.name, qty: p.qty, unit: p.unit, value: p.value });
    else missingFromCsv.push({ no: p.no, name: p.name, qty: p.qty, value: p.value });
  }
  return { extraLines, missingFromCsv };
}
