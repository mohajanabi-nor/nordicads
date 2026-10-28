/**
 * Any supplier's spec or invoice as a CSV or Excel file.
 *
 * Header names are recognised in English, Norwegian, Polish and German. If a supplier
 * names a column something else, pass `mapping` ({ field: "their header" }) — it is
 * saved per supplier by the caller, so the mapping is done once.
 *
 * Nothing is inferred beyond reading what is there: a missing required column stops the
 * import with the list of headers the file does have, instead of a guess.
 */
import * as XLSX from "xlsx";
import { cleanCell, decodeSupplierText, num, splitCsvLine } from "../text";
import type { InvoiceLine, ParsedInvoice, Unit } from "../types";

import { NO_COLUMN, REQUIRED_FIELDS, type Field } from "./fields";
export { FIELD_LABELS, NO_COLUMN, REQUIRED_FIELDS, type Field } from "./fields";

const ALIASES: Record<Field, string[]> = {
  no: ["no", "no.", "lp", "lp.", "line", "line no", "pos", "pos.", "nr"],
  idx: ["product number", "art.nr", "art.nr.", "artnr", "art nr", "article", "article no", "article number", "item no", "item number", "sku", "index", "indeks", "varenummer", "artikelnummer", "artikelnr", "code", "kod"],
  // English first: a file with both NAME (Polish) and NAME_ENG should be read in English.
  name: ["name eng", "name english", "description", "product", "product name", "name", "item", "nazwa", "beskrivelse", "vare", "varenavn", "bezeichnung", "artikel"],
  qty: ["quantity", "qty", "antall", "menge", "ilość", "ilosc", "pcs", "units"],
  unit: ["unit", "unit of measurement", "uom", "enhet", "einheit", "jm", "unit of measure"],
  cartons: ["packaging", "number of boxes", "boxes", "cartons", "packages", "kartons", "opakowania", "pack", "colli", "kolli"],
  country: ["country of origin", "origin", "country", "opprinnelsesland", "ursprungsland", "kraj pochodzenia", "kraj"],
  hs: ["tariff number", "code intrastat", "intrastat code", "intrastat", "hs code", "hs", "cn", "cn code", "commodity code", "customs code", "tolltariff", "tolltariffnummer", "zolltarifnummer", "kod cn"],
  netWeight: ["net weight", "netto", "net wt", "nettovekt", "nettogewicht", "waga netto", "netto kg"],
  grossWeight: ["gross weight", "brutto", "bruttovekt", "bruttogewicht", "waga brutto", "brutto kg"],
  netValue: ["net value", "line value", "line total", "amount", "total", "value", "wartość", "wartosc", "nettowert", "verdi", "sum", "betrag"],
  unitPrice: ["unit price", "price", "price per unit", "net price", "preis", "cena", "pris", "enhetspris", "einzelpreis"],
  currency: ["currency", "waluta", "valuta", "cur"],
  ean: ["ean pcs", "ean", "ean piece", "ean szt", "gtin", "barcode"],
  eanBox: ["ean box", "ean carton", "ean kartong", "ean karton", "gtin box"],
  invoice: ["invoice number", "invoice no", "invoice", "numer faktury", "fakturanummer", "rechnungsnummer"],
};


// Underscores read as spaces: NET_VALUE and "net value" are the same header.
export const norm = (h: string) => h.trim().toLowerCase().replace(/_+/g, " ").replace(/\s+/g, " ");

export type Mapping = Partial<Record<Field, string>>;



/** Spreadsheet or CSV bytes → a grid of strings, whatever the container. */
export function toGrid(bytes: Uint8Array, filename: string): { grid: string[][]; encoding: string } {
  const isExcel = /\.(xlsx|xlsm|xls)$/i.test(filename);
  if (isExcel) {
    const wb = XLSX.read(bytes, { type: "buffer", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
    return { grid: grid.map((r) => r.map((c) => String(c ?? ""))), encoding: "xlsx" };
  }
  const { text, encoding } = decodeSupplierText(bytes);
  const rows = text.split(/\r?\n/).filter((l) => l.trim());
  // A title block above the header can have no delimiter at all, so judge by the whole top
  // of the file: the delimiter that appears most is the one the table uses.
  const head = rows.slice(0, 25).join("\n");
  const delim = [";", "\t", ","].map((d) => ({ d, n: head.split(d).length - 1 })).sort((a, b) => b.n - a.n)[0].d;
  return { grid: rows.map((l) => splitCsvLine(l, delim)), encoding };
}

/** The first row that contains at least the required columns is the header (files often have a title above it). */
function findHeader(grid: string[][], mapping: Mapping): { index: number; col: Record<Field, number> } | null {
  for (let i = 0; i < Math.min(grid.length, 25); i++) {
    const row = grid[i].map(norm);
    const col = {} as Record<Field, number>;
    for (const f of Object.keys(ALIASES) as Field[]) {
      // A mapped header counts only if the file has it, so a supplier profile's mapping never breaks a file with other names.
      const mapped = mapping[f];
      const wanted = mapped === NO_COLUMN ? [] : mapped && row.includes(norm(mapped)) ? [norm(mapped)] : ALIASES[f];
      // The first alias in the list that is a header wins, not the first matching column in the file.
      col[f] = -1;
      for (const a of wanted) {
        const at = row.indexOf(a);
        if (at >= 0) {
          col[f] = at;
          break;
        }
      }
    }
    if (REQUIRED_FIELDS.every((f) => col[f] >= 0)) return { index: i, col };
  }
  return null;
}

/**
 * Which decimal style does this file use? "1.234" is 1234 in a Polish/Norwegian file and 1.234 in an
 * English one, and guessing wrong makes weights 1000× too big. Decide from the file itself: any cell
 * like 21.6 or 116.48 proves dot decimals; any like 12,5 proves comma decimals.
 */
export function detectDecimalStyle(cells: string[]): "dot" | "comma" | "unknown" {
  let dot = false;
  let comma = false;
  for (const raw of cells) {
    const c = raw.trim();
    if (/^-?\d+\.\d{1,2}$/.test(c) || /^-?\d+\.\d{4,}$/.test(c) || /^-?\d{1,3}(,\d{3})+\.\d+$/.test(c)) dot = true;
    if (/^-?\d+,\d{1,2}$/.test(c) || /^-?\d+,\d{4,}$/.test(c) || /^-?\d{1,3}(\.\d{3})+,\d+$/.test(c)) comma = true;
  }
  return dot && !comma ? "dot" : comma && !dot ? "comma" : "unknown";
}

/** A barcode is digits only (6–14 of them); anything else in the cell is not one. */
const eanOf = (raw: string): string | null => {
  const d = cleanCell(raw).replace(/\s/g, "");
  return /^\d{6,14}$/.test(d) ? d : null;
};

export const dotNum = (s: string | null | undefined): number | null => {
  if (s == null) return null;
  const t = String(s).trim().replace(/\s/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function parseGenericSpec(
  bytes: Uint8Array,
  filename: string,
  opts: { supplier: string; currency: string | null; invoiceNo?: string; mapping?: Mapping },
): ParsedInvoice {
  const { grid, encoding } = toGrid(bytes, filename);
  const header = findHeader(grid, opts.mapping ?? {});
  if (!header) {
    // Show the widest of the first rows: that is the header, not a title line above it.
    const widest = grid.slice(0, 25).sort((a, b) => b.filter(Boolean).length - a.filter(Boolean).length)[0] ?? [];
    const seen = widest.map((h) => h.trim()).filter(Boolean).join(" | ");
    throw new Error(
      `${filename}: fant ikke kolonnene for varenummer, navn og antall. Overskrifter i filen: ${seen || "(ingen)"}. Angi hvilke kolonner som er hvilke.`,
    );
  }
  const { col } = header;
  const warnings: string[] = [];
  const style = detectDecimalStyle(grid.slice(header.index + 1).flat());
  const parse = style === "dot" ? dotNum : num;
  if (grid.flat().some((c) => c.includes("�"))) warnings.push(`Filen har tegn som ikke kan leses (lest som ${encoding})`);
  for (const [f, label] of [["hs", "tollnummer"], ["netWeight", "nettovekt"]] as const) {
    if (col[f] < 0) warnings.push(`Kolonnen for ${label} mangler – fylles inn for hånd`);
  }
  if (col.netValue < 0 && col.unitPrice < 0) warnings.push("Hverken linjeverdi eller enhetspris finnes – pris må fylles inn");

  const lines: InvoiceLine[] = [];
  const invoiceNos = new Set<string>();
  const currencies = new Set<string>();
  let auto = 0;
  // Rows that carry an article number but no readable quantity are dropped (they are usually spacers or totals), but never
  // silently: a real product lost here would be missing from every number downstream.
  const dropped: string[] = [];
  const oddUnits = new Set<string>();

  for (let r = header.index + 1; r < grid.length; r++) {
    const f = grid[r];
    const get = (field: Field) => (col[field] >= 0 ? f[col[field]] ?? "" : "");
    const idx = cleanCell(get("idx"));
    const name = get("name").trim();
    const qty = parse(get("qty"));
    // Blank spacer rows and total rows have no article number or no quantity.
    if (!idx || qty === null) {
      if (idx && /\S/.test(get("qty")) ) dropped.push(idx);
      continue;
    }

    const unitRaw = get("unit").trim().toLowerCase();
    const unit: Unit = /^(kg|kgs|kilo|kilos|kilogram)$/.test(unitRaw) ? "kilo" : "pcs";
    if (unitRaw && !/^(kg|kgs|kilo|kilos|kilogram|pcs|pc|pcs\.|stk|stk\.|st|szt|szt\.|sztuk|piece|pieces|each|ea|unit|units|stück|stuck)$/.test(unitRaw)) oddUnits.add(unitRaw);
    const unitPrice = parse(get("unitPrice"));
    const value = parse(get("netValue")) ?? (unitPrice !== null ? Math.round(unitPrice * qty * 10000) / 10000 : null);
    const no = parse(get("no"));
    const inv = get("invoice").trim();
    if (inv) invoiceNos.add(inv);
    const cur = get("currency").trim().toUpperCase();
    if (cur) currencies.add(cur);

    lines.push({
      no: no !== null && Number.isInteger(no) ? no : ++auto,
      idx,
      name,
      qty,
      unit,
      cartons: parse(get("cartons")),
      country: get("country").trim().toUpperCase().slice(0, 2),
      hs: cleanCell(get("hs")).replace(/\D/g, "") || null,
      netWeightKg: parse(get("netWeight")),
      grossWeightKg: parse(get("grossWeight")),
      lineValue: value,
      invoiceNo: inv,
      ean: eanOf(get("ean")),
      eanBox: eanOf(get("eanBox")),
    });
  }
  if (!lines.length) throw new Error(`${filename}: ingen varelinjer`);
  if (dropped.length) {
    warnings.push(`${dropped.length} rader med varenummer ble hoppet over fordi antallet ikke kunne leses som et tall: ${dropped.slice(0, 6).join(", ")}${dropped.length > 6 ? " …" : ""}. Sjekk filen.`);
  }
  if (oddUnits.size) {
    warnings.push(`Ukjent enhet i filen (${Array.from(oddUnits).slice(0, 4).map((u) => `«${u}»`).join(", ")}) – regnet som stk. Er noe solgt per kg, må enheten være kg.`);
  }

  const dup = lines.map((l) => l.no).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) {
    // Line numbers are only a trail back to the file; renumber rather than refuse.
    lines.forEach((l, i) => (l.no = i + 1));
    warnings.push("Linjenummerne i filen var ikke unike og er nummerert på nytt");
  }

  const stem = filename.replace(/\.[^.]+$/, "");
  const nos = Array.from(invoiceNos);
  // One file can carry several invoices. They are imported together under one combined number so the
  // duplicate-import guard still works; without a PDF per invoice there is nothing to check each against.
  const invoiceNo = opts.invoiceNo || (nos.length === 1 ? nos[0] : nos.length > 1 ? nos.join(" + ") : stem);
  if (nos.length > 1) {
    warnings.push(`Filen inneholder ${nos.length} fakturaer (${nos.join(", ")}). De importeres samlet; summene kan ikke kontrolleres per faktura.`);
  }
  const parts =
    nos.length > 1
      ? nos.map((no) => {
          const own = lines.filter((l) => l.invoiceNo === no);
          return {
            invoiceNo: no,
            lines: own.length,
            value: Math.round(own.reduce((a, l) => a + (l.lineValue ?? 0), 0) * 100) / 100,
            netWeightKg: Math.round(own.reduce((a, l) => a + (l.netWeightKg ?? 0), 0) * 1000) / 1000,
          };
        })
      : undefined;
  lines.forEach((l) => (l.invoiceNo = invoiceNo));

  // A currency column is a fact about the file: it must agree with what the operator chose.
  const fileCurrencies = Array.from(currencies);
  if (fileCurrencies.length > 1) throw new Error(`${filename}: filen blander valutaer (${fileCurrencies.join(", ")}). Del den opp per valuta.`);
  if (fileCurrencies.length === 1 && opts.currency && fileCurrencies[0] !== opts.currency.toUpperCase()) {
    throw new Error(`${filename}: filen sier valuta ${fileCurrencies[0]}, men leverandøren er satt opp med ${opts.currency.toUpperCase()}. Kontroller valget.`);
  }
  const currency = opts.currency ?? fileCurrencies[0] ?? null;
  if (style === "unknown") warnings.push("Kunne ikke avgjøre desimalformatet i filen – tall som 1.234 er lest som tusen. Kontroller vekter og beløp.");

  return { supplier: opts.supplier, invoiceNo, currency, lines, warnings, parts };
}

export interface SpecInspection {
  /** The header row's cells, as written in the file (the options for each field). */
  headers: string[];
  /** The header each field was found under, with the mapping and aliases applied. */
  found: Partial<Record<Field, string>>;
  missingRequired: Field[];
  /** The first rows under the header, for a preview. */
  sample: string[][];
  rows: number;
}

/**
 * What the reader would do with this file, without importing it: which header each field was found
 * under and which required ones are missing. Powers the column-mapping screen.
 */
export function inspectSpec(bytes: Uint8Array, filename: string, mapping: Mapping = {}): SpecInspection {
  const { grid } = toGrid(bytes, filename);
  const header = findHeader(grid, mapping);
  if (!header) {
    // The widest early row is the header, not a title line above it.
    const index = Math.max(0, grid.slice(0, 25).map((r) => r.filter(Boolean).length).reduce((best, n, i, a) => (n > a[best] ? i : best), 0));
    const headers = (grid[index] ?? []).map((h) => h.trim());
    const found: Partial<Record<Field, string>> = {};
    for (const f of Object.keys(ALIASES) as Field[]) {
      const m = mapping[f];
      const wanted = m === NO_COLUMN ? [] : m ? [norm(m)] : ALIASES[f];
      const at = wanted.map((a) => headers.map(norm).indexOf(a)).find((i) => i >= 0);
      if (at !== undefined) found[f] = headers[at];
    }
    return { headers, found, missingRequired: REQUIRED_FIELDS.filter((f) => !found[f]), sample: grid.slice(index + 1, index + 6), rows: Math.max(0, grid.length - index - 1) };
  }
  const headers = grid[header.index].map((h) => h.trim());
  const found: Partial<Record<Field, string>> = {};
  for (const f of Object.keys(header.col) as Field[]) if (header.col[f] >= 0) found[f] = headers[header.col[f]];
  return { headers, found, missingRequired: [], sample: grid.slice(header.index + 1, header.index + 6), rows: grid.length - header.index - 1 };
}
