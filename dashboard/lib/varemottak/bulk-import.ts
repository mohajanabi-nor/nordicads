/**
 * One-off loads of the client's existing data: the customs rates (CN8 and per product) and the
 * purchase-price history. Each reads a CSV or Excel file with the same header detection as the
 * supplier files, reports what it skipped and why, and can be run again (a rate for the same key
 * replaces the old one; a history line already there is not added twice).
 */
import { lookupDuty, type CustomsRate } from "./customs";
import type { RateAsk } from "./questions";
import { listRates, rateRow } from "./customs-service";
import type { LineRow, ShipmentRow } from "./lines";
import { matchLine } from "./match";
import { saveProductSettings, type Ctx } from "./service";
import { detectDecimalStyle, dotNum, norm, toGrid } from "./suppliers/generic";
import { cleanCell, num } from "./text";

type Cols<K extends string> = Record<K, number>;

function findColumns<K extends string>(grid: string[][], aliases: Record<K, string[]>, required: K[], labels: Record<K, string>) {
  for (let i = 0; i < Math.min(grid.length, 25); i++) {
    const row = grid[i].map(norm);
    const col = {} as Cols<K>;
    for (const k of Object.keys(aliases) as K[]) {
      col[k] = -1;
      for (const a of aliases[k]) {
        const at = row.indexOf(a);
        if (at >= 0) {
          col[k] = at;
          break;
        }
      }
    }
    if (required.every((k) => col[k] >= 0)) return { index: i, col };
  }
  const widest = grid.slice(0, 25).sort((a, b) => b.filter(Boolean).length - a.filter(Boolean).length)[0] ?? [];
  throw new Error(
    `Fant ikke kolonnene for ${required.map((k) => labels[k]).join(", ")}. Overskrifter i filen: ${widest.map((h) => h.trim()).filter(Boolean).join(" | ") || "(ingen)"}.`,
  );
}

/** "2026-09-24", "24.09.2026" and "24/09/2026" become ISO dates; anything else is not a date. */
export function parseDate(raw: string): string | null {
  const t = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

const readNumbers = (grid: string[][], from: number) => (detectDecimalStyle(grid.slice(from).flat()) === "dot" ? dotNum : num);

// ------------------------------------------------------------------------------------------ customs rates

type RateField = "code" | "idx" | "supplier" | "duty" | "source" | "date" | "note";
const RATE_ALIASES: Record<RateField, string[]> = {
  code: ["cn8", "cn 8", "cn code", "cn", "hs code", "hs", "tariff number", "tariff", "customs code", "commodity code", "tolltariffnummer", "tolltariff", "tollnummer", "kod cn"],
  idx: ["art.nr", "art.nr.", "artnr", "art nr", "article", "article number", "product number", "item number", "varenummer", "index", "sku"],
  supplier: ["supplier", "leverandør", "leverandor", "lieferant"],
  duty: ["duty per kg", "duty kr/kg", "duty kr kg", "duty", "duty rate", "toll kr/kg", "toll kr kg", "toll pr kg", "toll per kg", "toll", "tollsats", "rate", "sats", "kr/kg", "kr per kg"],
  source: ["source", "kilde", "declaration", "deklarasjon", "declaration no", "deklarasjonsnummer", "declaration number"],
  date: ["date", "dato", "source date", "declaration date"],
  note: ["info: note", "note", "notat", "notes", "name", "navn", "product name", "produktnavn", "produkt", "product", "description", "beskrivelse"],
};
const RATE_LABELS: Record<RateField, string> = { code: "tollnummer (CN8)", idx: "varenummer", supplier: "leverandør", duty: "toll kr/kg", source: "kilde", date: "dato", note: "notat" };

export interface RateImportResult {
  rows: number;
  added: number;
  replaced: number;
  /** Rows left out. `ask` is set where the app needs an answer to use the row: the screen turns it into a question with a fix. */
  skipped: Array<{ row: number; reason: string; ask?: RateAsk }>;
  /** Rates whose date the file did not give ("not available"); they count as older than any dated rate. */
  undated: number;
  /** Rows of still-open shipments whose empty duty was filled in from the new rates. */
  filledOpenLines: number;
}

const isUnknown = (v: string) => !v.trim() || v.trim().toLowerCase() === "not available";
/** A rate without a date loses to every dated rate when "latest wins". */
const UNDATED = "2000-01-01";
const CHUNK = 250;

const chunks = <T,>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/**
 * Load rates from a file. A row with an article number is a product rate (needs a supplier: from the
 * file or `supplier`); a row with only an 8-digit code is a CN8 rate. CN8 rates are verified by
 * definition. A product rate is a declaration rate when its source names a declaration, and an
 * estimate when the source says "estimate" or is empty.
 *
 * The same file again changes nothing: for every key the file mentions, the rows already in the register
 * are replaced by the file's rows. Many rates can share a CN8 (one per declaration), and all of them stay.
 */
export async function importRates(ctx: Ctx, file: { bytes: Uint8Array; name: string }, opts: { supplier?: string } = {}): Promise<RateImportResult> {
  const { grid } = toGrid(file.bytes, file.name);
  const { index, col } = findColumns<RateField>(grid, RATE_ALIASES, ["duty"], RATE_LABELS);
  if (col.code < 0 && col.idx < 0) throw new Error("Filen trenger en kolonne for tollnummer (CN8) eller varenummer.");
  const parse = readNumbers(grid, index + 1);
  const cell = (r: string[], k: RateField) => (col[k] >= 0 ? cleanCell(r[col[k]] ?? "") : "");

  const existing = await listRates(ctx);
  const keyOf = (r: { scope: string; cn8: string | null; supplier: string | null; idx: string | null; source_kind: string }) =>
    r.scope === "cn8" ? `c|${r.cn8}` : `p|${(r.supplier ?? "").toLowerCase()}|${r.idx}|${r.source_kind}`;
  const existingKeys = new Set(existing.map(keyOf));

  const result: RateImportResult = { rows: 0, added: 0, replaced: 0, skipped: [], undated: 0, filledOpenLines: 0 };
  const pending: Array<{ key: string; row: Record<string, unknown> }> = [];
  for (let r = index + 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.every((c) => !c.trim())) continue;
    result.rows++;
    const n = r + 1;
    const rawDuty = (row[col.duty] ?? "").trim();
    const code = cell(row, "code").replace(/[^0-9]/g, "");
    const idx = cell(row, "idx");
    const rawSupplier = cell(row, "supplier");
    const supplier = isUnknown(rawSupplier) ? opts.supplier || "" : rawSupplier;
    const source = cell(row, "source");
    const rawDate = cell(row, "date");
    const note = cell(row, "note");
    let date = parseDate(rawDate) ?? undefined;
    const undatedRow = !date && col.date >= 0 && !!rawDate;
    if (undatedRow) date = UNDATED;
    // What the screen needs to ask about this row and save the answer.
    // "Product name: what the note says" – the part before the colon is the product
    const noteParts = /^([^:]*):(.*)$/s.exec(note) ?? [];
    const rateKind = !source || /^estimate/i.test(source) ? "estimate" : "declaration";
    const ask = (kind: RateAsk["kind"], options: number[] = []): RateAsk | undefined =>
      idx || code.length === 8
        ? {
            kind,
            scope: idx ? "product" : "cn8",
            cn8: code.length === 8 ? code : null,
            idx: idx || null,
            supplier: supplier || null,
            // a note with no colon is a name when it is short, otherwise a remark about the row
            name: (noteParts[1] ?? (note.length <= 60 ? note : "")).trim(),
            note: (noteParts[2] ?? (note.length <= 60 ? "" : note)).trim(),
            options,
            rateKind: idx ? rateKind : "declaration",
            sourceRef: rateKind === "estimate" && idx ? "" : source || "importert fil",
            date: date ?? UNDATED,
            guesses: [],
          }
        : undefined;
    if (rawDuty.includes("/")) {
      const options = rawDuty.split("/").map((p) => parse(p.trim())).filter((v): v is number => v !== null && v >= 0);
      result.skipped.push({ row: n, reason: `To satser i samme celle (${rawDuty}) – oppgi én sats per vare`, ask: options.length > 1 ? ask("two-rates", options) : undefined });
      continue;
    }
    const duty = parse(rawDuty);
    if (duty === null || duty < 0) {
      result.skipped.push({ row: n, reason: "Toll kr/kg mangler eller er ugyldig", ask: ask("duty") });
      continue;
    }
    if (undatedRow) result.undated++;
    try {
      if (idx) {
        if (!supplier) {
          const a = ask("supplier", [duty]);
          result.skipped.push({ row: n, reason: "Leverandør mangler (egen kolonne, eller velg leverandør)", ask: a });
          continue;
        }
        const kind = !source || /^estimate/i.test(source) ? "estimate" : "declaration";
        const record = rateRow(ctx, { scope: "product", supplier, idx, dutyPerKg: duty, kind, sourceRef: kind === "estimate" ? undefined : source || "importert fil", date });
        pending.push({ key: keyOf({ scope: "product", cn8: null, supplier, idx, source_kind: kind }), row: record });
      } else {
        if (code.length !== 8) throw new Error(code.length === 6 ? "Bare 8-sifret CN8 støttes (6-sifret HS6 utledes fra CN8-satser)" : "Tollnummeret må ha 8 siffer");
        const record = rateRow(ctx, { scope: "cn8", cn8: code, dutyPerKg: duty, kind: "declaration", sourceRef: source || "importert fil", date });
        pending.push({ key: keyOf({ scope: "cn8", cn8: code, supplier: null, idx: null, source_kind: "declaration" }), row: record });
      }
    } catch (err) {
      result.skipped.push({ row: n, reason: (err as Error).message });
    }
  }

  await suggestSuppliers(ctx, result.skipped, existing, pending.map((p) => p.row));

  // Replace what the file mentions, then insert it: a few calls however large the file is.
  const keys = new Set(pending.map((p) => p.key));
  const stale = existing.filter((x) => keys.has(keyOf(x))).map((x) => x.id);
  for (const group of chunks(stale, CHUNK)) await ctx.db.remove("vm_customs_rates", { id: `in.(${group.join(",")})` });
  for (const group of chunks(pending.map((p) => p.row), CHUNK)) await ctx.db.insert("vm_customs_rates", group);
  for (const p of pending) {
    if (existingKeys.has(p.key)) result.replaced++;
    else result.added++;
  }
  result.filledOpenLines = await fillOpenDuties(ctx);
  await ctx.log("info", "varemottak.rates.imported", `Tollsatser importert av ${ctx.who}: ${result.added} nye, ${result.replaced} erstattet, ${result.skipped.length} hoppet over`, { file: file.name });
  return result;
}

/**
 * For rows that came without a supplier: who sells this article number, as far as the app already knows. It looks in
 * the purchase history, in the rates already in the register, in the rest of the same file, and in the lines of
 * shipments on the screen. The answer is only a suggestion the person confirms.
 */
async function suggestSuppliers(
  ctx: Ctx,
  skipped: RateImportResult["skipped"],
  existing: Array<{ scope: string; supplier: string | null; idx: string | null }>,
  fromFile: Array<Record<string, unknown>>,
) {
  const asks = skipped.map((s) => s.ask).filter((a): a is RateAsk => !!a && a.kind === "supplier" && !!a.idx);
  if (!asks.length) return;
  const wanted = [...new Set(asks.map((a) => a.idx as string))];
  const found = new Map<string, Set<string>>();
  const add = (idx: string | null, supplier: string | null) => {
    if (!idx || !supplier || !wanted.includes(idx)) return;
    found.set(idx, (found.get(idx) ?? new Set()).add(supplier));
  };
  for (const r of existing) if (r.scope === "product") add(r.idx, r.supplier);
  for (const r of fromFile) add(r.idx as string | null, r.supplier as string | null);
  const shipments = await ctx.db.select<{ id: string; supplier_name: string }>("vm_shipments", {});
  const supplierOf = new Map(shipments.map((s) => [s.id, s.supplier_name]));
  for (const group of chunks(wanted, 100)) {
    const quoted = group.map((i) => `"${i.replace(/"/g, "")}"`).join(",");
    for (const h of await ctx.db.select<{ idx: string; supplier: string }>("vm_price_history", { idx: `in.(${quoted})` })) add(h.idx, h.supplier);
    for (const l of await ctx.db.select<{ idx: string; shipment_id: string }>("vm_lines", { idx: `in.(${quoted})` })) add(l.idx, supplierOf.get(l.shipment_id) ?? null);
  }
  for (const a of asks) a.guesses = [...(found.get(a.idx as string) ?? [])];
}

/**
 * Lines of shipments still being worked on that have no duty yet get the register's rate, if it has one.
 * A rate someone typed or a declaration already applied is never overwritten.
 */
export async function fillOpenDuties(ctx: Ctx): Promise<number> {
  const rates = (await listRates(ctx)) as unknown as CustomsRate[];
  const shipments = await ctx.db.select<ShipmentRow>("vm_shipments", {});
  let filled = 0;
  for (const s of shipments.filter((x) => x.status !== "archived")) {
    const lines = await ctx.db.select<LineRow>("vm_lines", { shipment_id: `eq.${s.id}`, duty_per_kg: "is.null", duty_pct: "is.null" });
    for (const l of lines.filter((x) => !x.pushed_at)) {
      const hit = lookupDuty({ supplier: s.supplier_name, idx: l.idx, hs: l.hs }, rates);
      if (!hit) continue;
      await ctx.db.update("vm_lines", { id: `eq.${l.id}` }, { duty_per_kg: hit.dutyPerKg, duty_pct: hit.dutyPct ?? null, duty_source: hit.source, duty_source_kind: hit.kind });
      filled++;
    }
  }
  return filled;
}

// ------------------------------------------------------------------------------------- purchase history

type HistField = "supplier" | "idx" | "price" | "currency" | "invoice" | "date" | "cost" | "ourPrice";
const HIST_ALIASES: Record<HistField, string[]> = {
  supplier: ["supplier", "leverandør", "leverandor", "lieferant"],
  idx: ["art.nr", "art.nr.", "artnr", "art nr", "article", "article number", "product number", "item number", "varenummer", "index", "sku"],
  price: ["unit price", "price", "price per unit", "net price", "innkjøpspris", "innkjopspris", "enhetspris", "pris", "cena", "preis"],
  currency: ["currency", "valuta", "waluta", "cur"],
  invoice: ["invoice", "invoice no", "invoice number", "fakturanr", "fakturanummer", "faktura", "numer faktury"],
  date: ["date", "dato", "invoice date", "fakturadato", "data"],
  cost: ["cost incl vat", "cost incl. vat", "kost inkl mva", "kost inkl. mva", "cost", "kost"],
  ourPrice: ["our price", "vår pris", "var pris", "din pris", "sale price"],
};
const HIST_LABELS: Record<HistField, string> = { supplier: "leverandør", idx: "varenummer", price: "pris per enhet", currency: "valuta", invoice: "fakturanr", date: "dato", cost: "kost", ourPrice: "vår pris" };

export interface HistoryImportResult {
  rows: number;
  added: number;
  duplicates: number;
  skipped: Array<{ row: number; reason: string }>;
  /** Lines the file gave no date for: treated as the supplier's newest purchases (the day after its latest dated one). */
  undated: number;
}

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** Used only when a supplier has no dated line at all in the file. */
const NO_DATE_AT_ALL = "2026-01-01";

/**
 * Load earlier purchases (supplier, article number, unit price, currency, date, invoice) so the first new
 * shipment already has something to compare with.
 *
 * Some invoices have no date ("not available"). Their lines are imported anyway and treated as the supplier's
 * newest purchases, ordered by invoice number, because invoice numbers run in time order and the missing dates
 * belong to the latest deliveries. The result says how many lines that applied to.
 */
export async function importHistory(
  ctx: Ctx,
  file: { bytes: Uint8Array; name: string },
  opts: { supplier?: string; currency?: string } = {},
): Promise<HistoryImportResult> {
  const { grid } = toGrid(file.bytes, file.name);
  const { index, col } = findColumns<HistField>(grid, HIST_ALIASES, ["idx", "price"], HIST_LABELS);
  const parse = readNumbers(grid, index + 1);
  const cell = (r: string[], k: HistField) => (col[k] >= 0 ? cleanCell(r[col[k]] ?? "") : "");

  const existing = await ctx.db.select<{ supplier: string; idx: string; occurred_on: string; invoice_no: string | null }>("vm_price_history", { shipment_id: "is.null" });
  const seen = new Set(existing.map((e) => `${e.supplier.toLowerCase()}|${e.idx}|${e.occurred_on}|${e.invoice_no ?? ""}`));

  const result: HistoryImportResult = { rows: 0, added: 0, duplicates: 0, skipped: [], undated: 0 };
  interface Parsed {
    row: Record<string, unknown>;
    date: string | null;
    supplier: string;
    invoice: string;
    idx: string;
  }
  const parsed: Parsed[] = [];
  const latestDated = new Map<string, string>();
  for (let r = index + 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.every((c) => !c.trim())) continue;
    result.rows++;
    const n = r + 1;
    const idx = cell(row, "idx");
    const price = parse(row[col.price] ?? "");
    const date = parseDate(cell(row, "date"));
    const rawSupplier = cell(row, "supplier");
    const supplier = isUnknown(rawSupplier) ? opts.supplier || "" : rawSupplier;
    const currency = (cell(row, "currency") || opts.currency || "").toUpperCase();
    const reason = !idx
      ? "Varenummer mangler"
      : price === null || price < 0
        ? "Pris mangler eller er ugyldig"
        : !supplier
          ? "Leverandør mangler (egen kolonne, eller velg leverandør)"
          : !/^[A-Z]{3}$/.test(currency)
            ? "Valuta mangler (egen kolonne, eller velg valuta)"
            : null;
    if (reason || price === null) {
      result.skipped.push({ row: n, reason: reason ?? "Ugyldig rad" });
      continue;
    }
    if (date && date > (latestDated.get(supplier.toLowerCase()) ?? "")) latestDated.set(supplier.toLowerCase(), date);
    parsed.push({
      supplier,
      idx,
      invoice: cell(row, "invoice"),
      date,
      row: {
        supplier,
        idx,
        currency,
        unit_price: price,
        cost_incl_vat: col.cost >= 0 ? parse(row[col.cost] ?? "") : null,
        our_price: col.ourPrice >= 0 ? parse(row[col.ourPrice] ?? "") : null,
        invoice_no: cell(row, "invoice") || null,
        shipment_id: null,
      },
    });
  }

  const toInsert: Array<Record<string, unknown>> = [];
  for (const p of parsed) {
    let occurred = p.date;
    if (!occurred) {
      const newest = latestDated.get(p.supplier.toLowerCase());
      occurred = newest ? nextDay(newest) : NO_DATE_AT_ALL;
      result.undated++;
    }
    const key = `${p.supplier.toLowerCase()}|${p.idx}|${occurred}|${p.invoice}`;
    if (seen.has(key)) {
      result.duplicates++;
      continue;
    }
    seen.add(key);
    toInsert.push({ ...p.row, occurred_on: occurred });
  }
  for (const group of chunks(toInsert, 500)) await ctx.db.insert("vm_price_history", group);
  result.added = toInsert.length;
  await ctx.log("info", "varemottak.history.imported", `Innkjøpshistorikk importert av ${ctx.who}: ${result.added} linjer (${result.undated} uten dato), ${result.duplicates} fantes fra før, ${result.skipped.length} hoppet over`, { file: file.name });
  return result;
}

// ------------------------------------------------------------------------------- products sold by kg

export interface KgImportResult {
  rows: number;
  /** Products whose selling unit was saved. */
  applied: number;
  skipped: Array<{ row: number; reason: string }>;
  /** Kg rows of shipments still being worked on that got their selling unit from the file. */
  filledKgLines: number;
}

/**
 * Load which products are sold per kg and how big the unit is (the client's file "5_products_sold_by_kg").
 * Columns: article number(s) ("8623 / 714540001TX" – several suppliers' numbers on one product), product name, box size.
 *
 * The unit the shop sells is what the engine needs: per kg (models A and B – the case price is then price × pieces, which
 * the shop already holds) is 1 kg; a fixed box priced as a box (model C, the Halwa exception – "price per BOX") is the box
 * size. Saved once per Shopify product, so every later invoice from any supplier uses it, and open kg rows get it now.
 * The file's text columns can hold semicolons, so only the first columns and the words in the rest of the row are read.
 */
export async function importKgProducts(ctx: Ctx, file: { bytes: Uint8Array; name: string }): Promise<KgImportResult> {
  const { grid } = toGrid(file.bytes, file.name);
  const head = grid.findIndex((r) => /art\.?\s?nr|article/i.test(r[0] ?? ""));
  if (head < 0) throw new Error("Fant ikke kolonnen for varenummer. Første kolonne må hete Art.nr.");
  const result: KgImportResult = { rows: 0, applied: 0, skipped: [], filledKgLines: 0 };

  interface Want { row: number; idx: string; name: string; unitKg: number }
  const wanted: Want[] = [];
  for (let r = head + 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.every((c) => !c.trim())) continue;
    result.rows++;
    const n = r + 1;
    const rest = row.slice(2).join(";");
    const boxMatch = /^\s*(\d+(?:[.,]\d+)?)/.exec(row[2] ?? "");
    if (!boxMatch) {
      result.skipped.push({ row: n, reason: "Salgsenhet (kg per enhet) mangler eller er ikke et tall" });
      continue;
    }
    const box = Number(boxMatch[1].replace(",", "."));
    const unitKg = /per\s*box/i.test(rest) ? box : 1;
    const name = cleanCell(row[1] ?? "");
    const numbers = (row[0] ?? "").split("/").map((x) => cleanCell(x)).filter((x) => x && !/^not available$/i.test(x));
    if (!numbers.length) wanted.push({ row: n, idx: "", name, unitKg });
    for (const idx of numbers) wanted.push({ row: n, idx, name, unitKg });
  }

  const byTag = new Map<string, Awaited<ReturnType<Ctx["shopify"]["productsByTags"]>>>();
  const tagged = await ctx.shopify.productsByTags([...new Set(wanted.map((w) => w.idx).filter(Boolean))]);
  for (const w of wanted) byTag.set(w.idx, tagged.filter((p) => p.tags.some((t) => t.toLowerCase() === w.idx.toLowerCase())));

  const productIds = new Map<string, number>();
  const seenRows = new Set<number>();
  for (const w of wanted) {
    let productId: string | null = null;
    let why = "";
    if (w.idx) {
      const m = matchLine({ idx: w.idx, name: w.name }, byTag.get(w.idx) ?? [], null, []);
      if (m.status === "matched" && m.productId) productId = m.productId;
      else why = m.status === "unmatched" ? `Ingen produkt har varenummeret ${w.idx} som tagg` : `Usikker kobling for ${w.idx} – velg salgsenheten på raden når varen kommer på en faktura`;
    } else {
      // No article number in the file: the product name is the Shopify title, so an exact title is the only safe match.
      const found = await ctx.shopify.searchProducts(w.name, 5);
      const exact = found.filter((p) => p.title.trim().toLowerCase() === w.name.toLowerCase());
      if (exact.length === 1) productId = exact[0].id;
      else why = "Varenummer mangler i filen og tittelen finnes ikke nøyaktig i Shopify – velg salgsenhet på raden når varen kommer på en faktura";
    }
    if (productId) {
      productIds.set(productId, w.unitKg);
      seenRows.add(w.row);
    } else if (!seenRows.has(w.row)) {
      result.skipped.push({ row: w.row, reason: why });
    }
  }
  // A row that found its product through one of several numbers is not a failure for the numbers that did not.
  result.skipped = result.skipped.filter((s) => !seenRows.has(s.row));

  for (const [productId, unitKg] of productIds) {
    await saveProductSettings(ctx, productId, { sales_unit_kg: unitKg });
    result.applied++;
  }

  // Kg rows already on the screen that were waiting for it.
  const shipments = (await ctx.db.select<ShipmentRow>("vm_shipments", {})).filter((x) => x.status !== "archived");
  for (const s of shipments) {
    const lines = await ctx.db.select<LineRow>("vm_lines", { shipment_id: `eq.${s.id}`, unit: "eq.kilo", sales_unit_kg: "is.null" });
    for (const l of lines.filter((x) => !x.pushed_at && x.shopify_product_id && productIds.has(x.shopify_product_id))) {
      await ctx.db.update("vm_lines", { id: `eq.${l.id}` }, { sales_unit_kg: productIds.get(l.shopify_product_id as string), updated_at: ctx.now().toISOString() });
      result.filledKgLines++;
    }
  }
  await ctx.log("info", "varemottak.kg.imported", `Kg-varer importert av ${ctx.who}: ${result.applied} produkter, ${result.skipped.length} hoppet over`, { file: file.name });
  return result;
}
