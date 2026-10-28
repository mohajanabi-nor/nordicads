/**
 * Varemottak's business operations: create a shipment, import its invoice, match and
 * edit rows, push prices.
 *
 * Everything takes a `Ctx` (database + Shopify + who is acting) instead of reaching for
 * globals, so the whole flow runs in tests against an in-memory database and the fake
 * Shopify — and in production against Supabase and the live store, where the Shopify
 * port itself refuses to write unless the owner switched that on.
 */
import { calcLine } from "./calc";
import { resolveCarton } from "./carton";
import { lookupDuty, type CustomsRate } from "./customs";
import { getDb, type Db } from "./db";
import { compareToHistory, summarizeImport, type ImportSummary, type PreviousPurchase } from "./history";
import { controlInvoice, lineWarnings, weightPerUnitLooksWrong, type ControlResult } from "./invoice-control";
import {
  calculate,
  countryName,
  needsPush,
  lineInput,
  shipmentWarnings,
  rowChecks,
  settingsOf,
  shipmentTotals,
  shopifyUnitPrice,
  type InvoiceRow,
  type LineRow,
  type ShipmentRow,
  type ShopifySnapshot,
} from "./lines";
import { matchLine } from "./match";
import { mergeLines } from "./merge";
import { getShopify } from "./shopify";
import { BATCH_SIZE, buildBatchRequest, chunk, formatDecimal, formatProductType, parseUnitPrice } from "./shopify/payloads";
import type { PriceUpdate, ShopProduct, ShopifyPort } from "./shopify/types";
import { parseStanroCsv, parseStanroPdf, pdfTextLines } from "./suppliers/stanro";
import { inspectSpec, parseGenericSpec, type Mapping, type SpecInspection } from "./suppliers/generic";
import { profileFor } from "./suppliers/registry";
import { extractInvoiceFromPdf, type CallClaude } from "./suppliers/pdf-claude";
import type { InvoiceTotals, MergedLine, ParsedInvoice } from "./types";
import { logInfo, logWarn } from "../eventlog";
import { currentUser } from "../auth";

export interface Ctx {
  db: Db;
  shopify: ShopifyPort;
  /** The signed-in account — a shared login, so this is the account, not the person. */
  who: string;
  log: (level: "info" | "warn", event: string, message: string, data?: Record<string, unknown>) => Promise<void>;
  now: () => Date;
  /** Replaces the Claude call for PDF-only invoices (tests). */
  claude?: CallClaude;
}

export async function defaultCtx(): Promise<Ctx> {
  const user = await currentUser().catch(() => null);
  return {
    db: getDb(),
    shopify: getShopify(),
    who: user?.email ?? "ukjent",
    log: (level, event, message, data) => (level === "warn" ? logWarn : logInfo)("varemottak", event, message, data),
    now: () => new Date(),
  };
}

const today = (ctx: Ctx) => ctx.now().toISOString().slice(0, 10);

// ======================================================================= shipments

export interface NewShipment {
  name: string;
  supplierName: string;
  arrivalDate?: string | null;
}

export async function createShipment(ctx: Ctx, input: NewShipment): Promise<ShipmentRow> {
  const name = input.name.trim();
  const supplier = input.supplierName.trim();
  if (!name) throw new Error("Forsendelsen trenger et navn");
  if (!supplier) throw new Error("Velg leverandør");
  const now = ctx.now().toISOString();
  const [row] = await ctx.db.insert<ShipmentRow>("vm_shipments", {
    name,
    supplier_id: null,
    supplier_name: supplier,
    arrival_date: input.arrivalDate ? isoDate(input.arrivalDate) : null,
    status: "draft",
    rates: {},
    freight_amount: null,
    freight_currency: "NOK",
    markup_mode: "markup",
    markup_value: 0.3,
    margin_threshold: 0.23,
    drink_packaging_nok: 2,
    created_by: ctx.who,
    updated_at: now,
  });
  await ctx.log("info", "varemottak.shipment.created", `Forsendelse «${name}» (${supplier}) opprettet av ${ctx.who}`, { id: row.id });
  return row;
}

export async function listShipments(ctx: Ctx): Promise<Array<ShipmentRow & { lineCount: number; doneCount: number; pushedCount: number }>> {
  const shipments = await ctx.db.select<ShipmentRow>("vm_shipments", { order: "created_at.desc" });
  const lines = await ctx.db.select<Pick<LineRow, "shipment_id" | "done" | "pushed_at">>("vm_lines", { select: "shipment_id,done,pushed_at" });
  return shipments.map((s) => {
    const mine = lines.filter((l) => l.shipment_id === s.id);
    return { ...s, lineCount: mine.length, doneCount: mine.filter((l) => l.done).length, pushedCount: mine.filter((l) => l.pushed_at).length };
  });
}

export async function getShipment(ctx: Ctx, id: string): Promise<ShipmentRow> {
  const [row] = await ctx.db.select<ShipmentRow>("vm_shipments", { id: `eq.${id}`, limit: 1 });
  if (!row) throw new NotFoundError("Fant ikke forsendelsen");
  return row;
}

export class NotFoundError extends Error {}

const SHIPMENT_EDITABLE = [
  "name", "supplier_name", "arrival_date", "rates", "freight_amount", "freight_currency", "markup_mode", "markup_value",
  "margin_threshold", "drink_packaging_nok", "status",
] as const;

export async function patchShipment(ctx: Ctx, id: string, patch: Record<string, unknown>): Promise<ShipmentRow> {
  const clean: Record<string, unknown> = {};
  for (const key of SHIPMENT_EDITABLE) {
    if (!(key in patch)) continue;
    const v = patch[key];
    switch (key) {
      case "rates": {
        const rates: Record<string, number> = {};
        for (const [cur, rate] of Object.entries((v ?? {}) as Record<string, unknown>)) {
          const n = Number(rate);
          if (!/^[A-Z]{3}$/.test(cur)) throw new Error(`Ugyldig valuta «${cur}»`);
          if (rate !== "" && rate !== null && !(n > 0)) throw new Error(`Kursen for ${cur} må være over 0`);
          if (rate !== "" && rate !== null) rates[cur] = n;
        }
        clean.rates = rates;
        break;
      }
      case "freight_amount":
        clean.freight_amount = v === null || v === "" ? null : numberBetween(v, 0, 100_000_000, "Frakt");
        break;
      case "freight_currency":
        if (!/^[A-Z]{3}$/.test(String(v))) throw new Error("Ugyldig fraktvaluta");
        clean.freight_currency = v;
        break;
      case "markup_mode":
        if (v !== "markup" && v !== "margin") throw new Error("Ugyldig påslagsmodus");
        clean.markup_mode = v;
        break;
      case "markup_value":
        clean.markup_value = numberBetween(v, 0, 0.95, "Påslag");
        break;
      case "margin_threshold":
        clean.margin_threshold = numberBetween(v, 0, 0.95, "Marginterskel");
        break;
      case "drink_packaging_nok":
        clean.drink_packaging_nok = numberBetween(v, 0, 1000, "Emballasje");
        break;
      case "status":
        // "pushed" is set by the push itself, never typed in
        if (!["draft", "review", "archived"].includes(String(v))) throw new Error("Ugyldig status");
        clean.status = v;
        break;
      case "supplier_name": {
        const existing = await ctx.db.select("vm_invoices", { shipment_id: `eq.${id}`, limit: 1 });
        if (existing.length) throw new Error("Leverandøren kan ikke endres etter at en faktura er importert – opprett en ny forsendelse");
        if (!String(v).trim()) throw new Error("Velg leverandør");
        clean.supplier_name = String(v).trim();
        break;
      }
      case "name":
        if (!String(v).trim()) throw new Error("Navnet kan ikke være tomt");
        clean.name = String(v).trim();
        break;
      case "arrival_date":
        clean.arrival_date = v ? isoDate(v) : null;
        break;
    }
  }
  if (!Object.keys(clean).length) return getShipment(ctx, id);
  clean.updated_at = ctx.now().toISOString();
  const [row] = await ctx.db.update<ShipmentRow>("vm_shipments", { id: `eq.${id}` }, clean);
  if (!row) throw new NotFoundError("Fant ikke forsendelsen");
  return row;
}

/** A real calendar date as YYYY-MM-DD, or an error the operator can read. */
function isoDate(v: unknown): string {
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3]) || Number(m[1]) < 2000 || Number(m[1]) > 2100) {
    throw new Error("Ugyldig dato – bruk ÅÅÅÅ-MM-DD");
  }
  return s;
}

function numberAtLeast(v: unknown, min: number, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`${label} må være ${min} eller mer`);
  return n;
}
function numberBetween(v: unknown, min: number, max: number, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} må være mellom ${min} og ${max}`);
  return n;
}

export interface ShipmentView {
  shipment: ShipmentRow;
  invoices: InvoiceRow[];
  lines: LineRow[];
  pushLog: number;
}

export async function getShipmentView(ctx: Ctx, id: string): Promise<ShipmentView> {
  const shipment = await getShipment(ctx, id);
  const [invoices, lines, log] = await Promise.all([
    ctx.db.select<InvoiceRow>("vm_invoices", { shipment_id: `eq.${id}`, order: "invoice_no.asc" }),
    ctx.db.select<LineRow>("vm_lines", { shipment_id: `eq.${id}`, order: "position.asc" }),
    ctx.db.select<{ id: number }>("vm_push_log", { shipment_id: `eq.${id}`, select: "id" }),
  ]);
  return { shipment, invoices, lines, pushLog: log.length };
}

export async function deleteShipment(ctx: Ctx, id: string): Promise<void> {
  const lines = await ctx.db.select<Pick<LineRow, "pushed_at">>("vm_lines", { shipment_id: `eq.${id}`, select: "pushed_at" });
  if (lines.some((l) => l.pushed_at)) throw new Error("Forsendelsen har sendte varer og kan ikke slettes – arkiver den i stedet");
  await ctx.db.remove("vm_shipments", { id: `eq.${id}` });
  // Children go with the shipment (ON DELETE CASCADE); the in-memory store has no cascade.
  for (const t of ["vm_lines", "vm_invoices", "vm_price_history"]) await ctx.db.remove(t, { shipment_id: `eq.${id}` });
  await ctx.log("info", "varemottak.shipment.deleted", `Forsendelse slettet av ${ctx.who}`, { id });
}

// ========================================================================== import


export interface ImportFiles {
  spec?: { bytes: Uint8Array; name: string };
  pdf?: { bytes: Uint8Array; name: string };
  /** Invoice currency. Required for anything but Stanro (always PLN). */
  currency?: string;
  invoiceNo?: string;
  mapping?: Mapping;
}

export interface ImportResult {
  invoiceId: string;
  invoiceNo: string;
  currency: string;
  rawLines: number;
  products: number;
  matched: number;
  doubtful: number;
  unmatched: number;
  control: ControlResult;
  summary: ImportSummary;
  warnings: string[];
}

export async function savedMapping(ctx: Ctx, supplier: string): Promise<Mapping> {
  const [row] = await ctx.db.select<{ mapping: Mapping }>("vm_supplier_mappings", { supplier: `eq.${supplier}`, limit: 1 });
  return row?.mapping ?? {};
}

/** What the reader makes of a file before importing it: headers, what was found, what is missing. */
export async function inspectImport(ctx: Ctx, shipmentId: string, file: { bytes: Uint8Array; name: string }, mapping?: Mapping): Promise<SpecInspection & { mapping: Mapping }> {
  const shipment = await getShipment(ctx, shipmentId);
  const profile = profileFor(shipment.supplier_name);
  const merged: Mapping = { ...profile.mapping, ...(await savedMapping(ctx, shipment.supplier_name)), ...mapping };
  return { ...inspectSpec(file.bytes, file.name, merged), mapping: merged };
}

export async function importInvoice(ctx: Ctx, shipmentId: string, files: ImportFiles): Promise<ImportResult> {
  const shipment = await getShipment(ctx, shipmentId);
  if (!files.spec && !files.pdf) throw new Error("Last opp spesifikasjonsfilen (CSV eller Excel), eller fakturaen som PDF");

  if (files.spec && files.spec.bytes.length > 4 && String.fromCharCode(...files.spec.bytes.subarray(0, 4)) === "%PDF") {
    throw new Error("Filen i spesifikasjonsfeltet er en PDF. Legg PDF-fakturaen i feltet «Faktura (PDF)», og CSV/Excel i spesifikasjonsfeltet.");
  }

  // The supplier chosen for this shipment decides which reader runs and which currency applies.
  const profile = profileFor(shipment.supplier_name);
  const kind = profile.reader;
  let parsed: ParsedInvoice;
  let totals: InvoiceTotals | null = null;
  const warnings: string[] = [];

  if (!files.spec) {
    // PDF only. Stanro's PDF has no article numbers, so it cannot be read this way.
    if (kind === "stanro") throw new Error("Stanro-fakturaen har ikke varenummer – last opp spesifikasjonsfilen (CSV)");
    const currency = (profile.currency ?? files.currency ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Oppgi fakturaens valuta (f.eks. EUR)");
    const ex = await extractInvoiceFromPdf(files.pdf!.bytes, { supplier: shipment.supplier_name, currency, invoiceNo: files.invoiceNo, call: ctx.claude });
    parsed = ex.parsed;
    totals = ex.totals;
  } else if (kind === "stanro") {
    try {
      parsed = parseStanroCsv(files.spec.bytes, files.spec.name);
    } catch (err) {
      throw new Error(`Dette ser ikke ut som Stanro sin spesifikasjonsfil. ${(err as Error).message}`);
    }
    if (files.pdf) totals = parseStanroPdf(await pdfTextLines(files.pdf.bytes));
  } else {
    const currency = (profile.currency ?? files.currency ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Oppgi fakturaens valuta (f.eks. EUR)");
    // What the operator chose now, else what was saved for this supplier, else the profile's own.
    const saved = await savedMapping(ctx, shipment.supplier_name);
    parsed = parseGenericSpec(files.spec.bytes, files.spec.name, {
      supplier: shipment.supplier_name,
      currency,
      invoiceNo: files.invoiceNo,
      mapping: { ...profile.mapping, ...saved, ...files.mapping },
    });
    // It worked, so remember it: the next file from this supplier needs no mapping.
    if (files.mapping && Object.keys(files.mapping).length) {
      await ctx.db.insert("vm_supplier_mappings", { supplier: shipment.supplier_name, mapping: { ...saved, ...files.mapping }, updated_at: ctx.now().toISOString() }, { onConflict: "supplier", merge: true });
    }
    if (files.pdf) warnings.push("PDF-en er lagret, men summene kan ikke leses automatisk for denne leverandøren ennå");
  }
  warnings.push(...parsed.warnings);
  const currency = parsed.currency ?? "NOK";

  const dup = await ctx.db.select<InvoiceRow>("vm_invoices", { shipment_id: `eq.${shipmentId}`, invoice_no: `eq.${parsed.invoiceNo}`, limit: 1 });
  if (dup.length) throw new Error(`Faktura ${parsed.invoiceNo} er allerede importert i denne forsendelsen`);

  const elsewhere = await ctx.db.select<InvoiceRow>("vm_invoices", { invoice_no: `eq.${parsed.invoiceNo}` });
  for (const other of elsewhere) {
    const [os] = await ctx.db.select<ShipmentRow>("vm_shipments", { id: `eq.${other.shipment_id}`, limit: 1 });
    if (os && os.id !== shipmentId && os.supplier_name.toLowerCase() === shipment.supplier_name.toLowerCase()) {
      throw new Error(`Faktura ${parsed.invoiceNo} er allerede importert i forsendelsen «${os.name}» – slett den først, ellers telles varene to ganger (Grønt Punkt, innkjøpshistorikk)`);
    }
  }

  const control = controlInvoice(parsed, totals);
  const extra = lineWarnings(parsed.lines);
  control.checks.push(...extra);
  // One file, several invoices: show each invoice's own lines, value and weight (there is no PDF to check them against).
  for (const part of parsed.parts ?? []) {
    control.checks.push({
      code: "INVOICE_PART",
      severity: "info",
      text: `Faktura ${part.invoiceNo}: ${part.lines} linjer, ${part.value.toLocaleString("nb-NO", { minimumFractionDigits: 2 })} ${currency}, ${part.netWeightKg.toLocaleString("nb-NO")} kg netto`,
    });
  }

  const [invoice] = await ctx.db.insert<InvoiceRow>("vm_invoices", {
    shipment_id: shipmentId,
    invoice_no: parsed.invoiceNo,
    invoice_date: totals?.invoiceDate ?? null,
    currency,
    spec_file: files.spec?.name ?? null,
    pdf_file: files.pdf?.name ?? null,
    net_total: totals?.netTotal ?? null,
    vat_total: totals?.vatTotal ?? null,
    gross_total: totals?.grossTotal ?? null,
    net_weight_kg: totals?.netWeightKg ?? null,
    extra_lines: control.extraLines,
    control: control.checks,
    warnings,
  });
  await ctx.db.insert(
    "vm_invoice_lines",
    parsed.lines.map((l) => ({
      invoice_id: invoice.id,
      line_no: l.no,
      idx: l.idx,
      name: l.name,
      qty: l.qty,
      unit: l.unit,
      cartons: l.cartons,
      country: l.country,
      hs: l.hs,
      net_weight_kg: l.netWeightKg,
      gross_weight_kg: l.grossWeightKg,
      line_value: l.lineValue,
      ean: l.ean ?? null,
      ean_box: l.eanBox ?? null,
    })),
  );

  const merged = mergeLines(parsed.lines);
  const grossByNo = new Map(parsed.lines.map((l) => [l.no, l.grossWeightKg]));
  const existing = await ctx.db.select<Pick<LineRow, "position">>("vm_lines", { shipment_id: `eq.${shipmentId}`, select: "position" });
  const basePosition = existing.reduce((m, l) => Math.max(m, l.position + 1), 0);

  const rows = await buildRows(ctx, shipment, invoice.id, invoice.invoice_no, currency, merged, basePosition, (m) => weightProblem(m, grossByNo));
  await ctx.db.insert("vm_lines", rows.map((r) => r.row));

  // Purchase history: one row per product for this shipment, compared above, written now
  // so the next shipment can compare against this one.
  const occurred = totals?.invoiceDate ?? shipment.arrival_date ?? today(ctx);
  await ctx.db.insert(
    "vm_price_history",
    merged
      .filter((m) => m.unitPrice !== null)
      .map((m) => ({
        supplier: shipment.supplier_name,
        idx: m.idx,
        currency,
        unit_price: m.unitPrice,
        cost_incl_vat: null,
        our_price: null,
        invoice_no: parsed.invoiceNo,
        occurred_on: occurred,
        shipment_id: shipmentId,
      })),
    { onConflict: "shipment_id,supplier,idx", merge: true },
  );

  const calc = calculate(shipment, rows.map((r) => r.row as unknown as LineRow));
  const summary = summarizeImport(
    rows.map((r, i) => ({ idx: r.row.idx, name: r.row.name, change: r.history!.change, margin: calc.rows[i].result.margin })),
    Number(shipment.margin_threshold),
  );

  const result: ImportResult = {
    invoiceId: invoice.id,
    invoiceNo: parsed.invoiceNo,
    currency,
    rawLines: parsed.lines.length,
    products: merged.length,
    matched: rows.filter((r) => r.row.match_status === "matched").length,
    doubtful: rows.filter((r) => r.row.match_status === "doubtful").length,
    unmatched: rows.filter((r) => r.row.match_status === "unmatched").length,
    control,
    summary,
    warnings,
  };
  if (shipment.status === "draft") {
    await ctx.db.update("vm_shipments", { id: `eq.${shipmentId}` }, { status: "review", updated_at: ctx.now().toISOString() });
  }
  await ctx.log("info", "varemottak.invoice.imported", `Faktura ${parsed.invoiceNo} importert av ${ctx.who}: ${result.products} varer (${result.matched} koblet, ${result.doubtful} usikre, ${result.unmatched} uten kobling)`, {
    shipmentId,
    invoiceNo: parsed.invoiceNo,
  });
  return result;
}

function weightProblem(m: MergedLine, grossByNo: Map<number, number | null>): string | null {
  const gross = m.lines.reduce<number | null>((a, no) => {
    const g = grossByNo.get(no) ?? null;
    return g === null ? a : (a ?? 0) + g;
  }, null);
  return weightPerUnitLooksWrong(m.name, m.unit, m.qty, m.netWeightKg, gross);
}

interface BuiltRow {
  row: Omit<LineRow, "id" | "updated_at"> & { shipment_id: string };
  history: NonNullable<LineRow["history"]>;
}

const snapshotOf = (p: ShopProduct): ShopifySnapshot => ({
  title: p.title,
  status: p.status,
  vendor: p.vendor,
  productType: p.productType,
  variantPrice: p.variantPrice,
  unitCost: p.unitCost,
  variantId: p.variantId,
  variantCount: p.variantCount,
  inventoryItemId: p.inventoryItemId,
  imageUrl: p.imageUrl,
  tags: p.tags,
  handle: p.handle,
  countryName: p.countryName,
  barcodes: p.barcodes,
});

async function buildRows(
  ctx: Ctx,
  shipment: ShipmentRow,
  invoiceId: string,
  invoiceNo: string,
  currency: string,
  merged: MergedLine[],
  basePosition: number,
  weightIssue: (m: MergedLine) => string | null,
): Promise<BuiltRow[]> {
  const supplier = shipment.supplier_name;
  const idxs = merged.map((m) => m.idx);

  const eans = merged.flatMap((m) => [m.ean, m.eanBox]).filter((e): e is string => !!e);
  const [tagged, byEan, links, settings, rates, history] = await Promise.all([
    ctx.shopify.productsByTags(idxs),
    eans.length ? ctx.shopify.productsByBarcodes(eans) : Promise.resolve([]),
    selectIn<{ idx: string; shopify_product_id: string }>(ctx, "vm_supplier_links", "idx", idxs, { supplier: `eq.${supplier}` }),
    ctx.db.select<{ shopify_product_id: string; sales_unit_kg: number | null }>("vm_product_settings"),
    ctx.db.select<CustomsRate>("vm_customs_rates"),
    previousPurchases(ctx, supplier, idxs, shipment.id, invoiceNo),
  ]);
  const linkedProducts = await ctx.shopify.productsByIds(links.map((l) => l.shopify_product_id));
  const linkOf = new Map(links.map((l) => [l.idx, linkedProducts.get(l.shopify_product_id) ?? null]));
  const settingOf = new Map(settings.map((s) => [s.shopify_product_id, s]));
  const byId = new Map(tagged.map((p) => [p.id, p]));
  for (const p of byEan) byId.set(p.id, p); // found by barcode only
  for (const p of Array.from(linkedProducts.values())) byId.set(p.id, p);

  return merged.map((m, i) => {
    const match = matchLine({ idx: m.idx, name: m.name, ean: m.ean, eanBox: m.eanBox }, tagged, linkOf.get(m.idx) ?? null, byEan);
    const product = match.productId ? byId.get(match.productId) ?? null : null;
    const carton = resolveCarton(product, m.pcsPerCartonInvoice);
    const duty = lookupDuty({ supplier, idx: m.idx, hs: m.hs }, rates);
    const issues = [...m.issues, ...carton.warnings];
    const wi = weightIssue(m);
    if (wi) issues.push(wi);
    const prev = history.get(m.idx) ?? null;
    const unitPrice = m.unitPrice;
    const ourNow = product?.status === "ACTIVE" ? parseUnitPrice(product.productType) : null;
    const change = compareToHistory(unitPrice, currency, prev, ourNow);
    const salesUnit = m.unit === "kilo" && product ? settingOf.get(product.id)?.sales_unit_kg ?? null : null;

    return {
      history: { previous: prev, change },
      row: {
        shipment_id: shipment.id,
        invoice_id: invoiceId,
        position: basePosition + i,
        currency,
        idx: m.idx,
        name: m.name,
        unit: m.unit,
        qty: m.qty,
        cartons: m.cartons,
        country: m.country,
        hs: m.hs,
        hs_fixed: m.hsFixed,
        net_weight_kg: m.netWeightKg,
        line_value: m.lineValue,
        ean: m.ean,
        ean_box: m.eanBox,
        unit_price: m.unitPrice,
        price_conflict: m.priceConflict,
        source_lines: m.lines,
        issues,
        match_status: match.status,
        match_via: match.via,
        match_reason: match.reason,
        match_candidates: match.candidates,
        shopify_product_id: match.productId,
        shopify: product ? snapshotOf(product) : null,
        // New = it existed as a DRAFT before this shipment; restocked = it was already ACTIVE.
        is_new: product ? product.status !== "ACTIVE" : false,
        mva25: product ? product.tags.some((t) => t.toLowerCase() === "mva-25") : false,
        vat_rate: null,
        history: { previous: prev, change },
        duty_per_kg: duty ? duty.dutyPerKg : null,
        duty_pct: duty?.dutyPct ?? null,
        packaging_nok: null,
        duty_source: duty ? duty.source : null,
        duty_source_kind: duty ? duty.kind : null,
        pcs_per_carton: carton.value,
        pcs_source: carton.source === "none" ? null : carton.source,
        sales_unit_kg: salesUnit,
        price_override: null,
        chosen_unit_price: null,
        done: false,
        pushed_at: null,
        pushed: null,
        push_errors: null,
      },
    };
  });
}

const quote = (s: string) => (/[,()"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/**
 * PostgREST takes filters in the URL, and a gateway refuses request lines over ~8 KB. 238 article
 * numbers or uuids in one in.(…) is 3–9 KB, so long lists go in several requests.
 */
const IN_CHUNK = 60;

async function selectIn<T>(ctx: Ctx, table: string, column: string, values: string[], params: Record<string, string | number> = {}): Promise<T[]> {
  const out: T[] = [];
  for (const group of chunk(Array.from(new Set(values)), IN_CHUNK)) {
    out.push(...(await ctx.db.select<T>(table, { ...params, [column]: `in.(${group.map(quote).join(",")})` })));
  }
  return out;
}

async function previousPurchases(ctx: Ctx, supplier: string, idxs: string[], excludeShipment: string, excludeInvoice: string): Promise<Map<string, PreviousPurchase>> {
  const rows = await selectIn<PreviousPurchase & { idx: string; shipment_id: string }>(ctx, "vm_price_history", "idx", idxs, {
    supplier: `eq.${supplier}`,
    order: "occurred_on.desc",
  });
  // Imported history has no shipment (shipment_id is NULL), and SQL's <> would drop NULL rows, so this shipment's own
  // rows are left out here instead of in the query.
  // A purchase on the very invoice being imported is not an earlier purchase (the client's history file can already
  // contain it), so it must not be compared with itself.
  const others = rows.filter((r) => r.shipment_id !== excludeShipment && !(excludeInvoice && r.invoice_no === excludeInvoice));
  // Newest first; among equal dates (invoices with no date) the higher invoice number is the later delivery.
  others.sort((a, b) => (a.occurred_on === b.occurred_on ? (b.invoice_no ?? "").localeCompare(a.invoice_no ?? "") : a.occurred_on < b.occurred_on ? 1 : -1));
  const out = new Map<string, PreviousPurchase>();
  for (const r of others) if (!out.has(r.idx)) out.set(r.idx, r);
  return out;
}

// ============================================================ matching and editing

/** Re-read the shop: new matches, fresh snapshots. Keeps "new vs restocked" as it was at import. */
export async function rematch(ctx: Ctx, shipmentId: string): Promise<{ updated: number; nowMatched: number }> {
  const shipment = await getShipment(ctx, shipmentId);
  const lines = await ctx.db.select<LineRow>("vm_lines", { shipment_id: `eq.${shipmentId}` });
  const active = lines.filter((l) => !l.pushed_at);
  if (!active.length) return { updated: 0, nowMatched: 0 };

  const idxs = active.map((l) => l.idx);
  const eans = active.flatMap((l) => [l.ean, l.ean_box]).filter((e): e is string => !!e);
  const [tagged, byEan, links] = await Promise.all([
    ctx.shopify.productsByTags(idxs),
    eans.length ? ctx.shopify.productsByBarcodes(eans) : Promise.resolve([]),
    ctx.db.select<{ idx: string; shopify_product_id: string }>("vm_supplier_links", { supplier: `eq.${shipment.supplier_name}` }),
  ]);
  const linked = await ctx.shopify.productsByIds(links.map((l) => l.shopify_product_id));
  const linkOf = new Map(links.map((l) => [l.idx, linked.get(l.shopify_product_id) ?? null]));
  const byId = new Map(tagged.map((p) => [p.id, p]));
  byEan.forEach((p) => byId.set(p.id, p));
  linked.forEach((p) => byId.set(p.id, p));

  let updated = 0;
  let nowMatched = 0;
  for (const l of active) {
    const match = matchLine({ idx: l.idx, name: l.name, ean: l.ean, eanBox: l.ean_box }, tagged, linkOf.get(l.idx) ?? null, byEan);
    const product = match.productId ? byId.get(match.productId) ?? null : null;
    const patch: Record<string, unknown> = {
      match_status: match.status,
      match_via: match.via,
      match_reason: match.reason,
      match_candidates: match.candidates,
      shopify_product_id: match.productId,
      shopify: product ? snapshotOf(product) : null,
      mva25: product ? product.tags.some((t) => t.toLowerCase() === "mva-25") : false,
      updated_at: ctx.now().toISOString(),
    };
    // A product that was a DRAFT at import stays "new" even if it has since been activated.
    if (!l.shopify_product_id && product) patch.is_new = product.status !== "ACTIVE";
    if (product && l.pcs_source !== "typed") {
      const carton = resolveCarton(product, l.cartons && l.unit === "pcs" ? roundWhole(l.qty / l.cartons) : null);
      if (carton.value) {
        patch.pcs_per_carton = carton.value;
        patch.pcs_source = carton.source;
      }
    }
    if (l.match_status !== "matched" && match.status === "matched") nowMatched++;
    await ctx.db.update("vm_lines", { id: `eq.${l.id}` }, patch);
    updated++;
  }
  return { updated, nowMatched };
}

const roundWhole = (n: number) => (Math.abs(n - Math.round(n)) <= 0.02 ? Math.round(n) : null);

/** The operator picks the right product for a row. Remembered for the next shipment. */
export async function setMatch(ctx: Ctx, lineId: string, productId: string): Promise<LineRow> {
  const [line] = await ctx.db.select<LineRow>("vm_lines", { id: `eq.${lineId}`, limit: 1 });
  if (!line) throw new NotFoundError("Fant ikke raden");
  if (line.pushed_at) throw new Error("Raden er allerede sendt til Shopify");
  const shipment = await getShipment(ctx, line.shipment_id);
  const product = (await ctx.shopify.productsByIds([productId])).get(productId);
  if (!product) throw new Error("Fant ikke produktet i Shopify");

  const carton = resolveCarton(product, line.unit === "pcs" && line.cartons ? roundWhole(line.qty / line.cartons) : null);
  const settings = await ctx.db.select<{ sales_unit_kg: number | null }>("vm_product_settings", { shopify_product_id: `eq.${productId}`, limit: 1 });
  const [updated] = await ctx.db.update<LineRow>("vm_lines", { id: `eq.${lineId}` }, {
    match_status: "matched",
    match_via: "link",
    match_reason: `Valgt av ${ctx.who}`,
    match_candidates: [],
    shopify_product_id: productId,
    shopify: snapshotOf(product),
    is_new: product.status !== "ACTIVE",
    mva25: product.tags.some((t) => t.toLowerCase() === "mva-25"),
    pcs_per_carton: line.pcs_source === "typed" ? line.pcs_per_carton : carton.value,
    pcs_source: line.pcs_source === "typed" ? "typed" : carton.source === "none" ? null : carton.source,
    sales_unit_kg: line.sales_unit_kg ?? settings[0]?.sales_unit_kg ?? null,
    updated_at: ctx.now().toISOString(),
  });
  await ctx.db.insert("vm_supplier_links", { supplier: shipment.supplier_name, idx: line.idx, shopify_product_id: productId, title: product.title }, { onConflict: "supplier,idx", merge: true });
  await ctx.log("info", "varemottak.line.matched", `${ctx.who} koblet ${line.idx} til «${product.title}»`, { lineId, productId });
  return updated;
}

const LINE_EDITABLE = ["duty_per_kg", "duty_pct", "packaging_nok", "pcs_per_carton", "net_weight_kg", "sales_unit_kg", "price_override", "chosen_unit_price", "vat_rate", "done"] as const;

export async function patchLine(ctx: Ctx, lineId: string, patch: Record<string, unknown>): Promise<LineRow> {
  const [line] = await ctx.db.select<LineRow>("vm_lines", { id: `eq.${lineId}`, limit: 1 });
  if (!line) throw new NotFoundError("Fant ikke raden");
  const shipment = await getShipment(ctx, line.shipment_id);

  const clean: Record<string, unknown> = {};
  for (const key of LINE_EDITABLE) {
    if (!(key in patch)) continue;
    const v = patch[key];
    const empty = v === null || v === "";
    switch (key) {
      case "duty_per_kg":
        clean.duty_per_kg = empty ? null : numberBetween(v, 0, 5000, "Toll");
        // one basis at a time: typing kr/kg replaces a percentage
        if (!empty) clean.duty_pct = null;
        clean.duty_source_kind = empty ? null : "estimate";
        clean.duty_source = empty ? null : `Lagt inn av ${ctx.who} (anslag)`;
        break;
      case "duty_pct": {
        // a share of the goods value, typed as a fraction (0.19 = 19 %)
        const pct = empty ? null : numberAtLeast(v, 0, "Tollsats i prosent");
        if (pct !== null && pct > 1) throw new Error("Tollsats i prosent må være mellom 0 og 100");
        clean.duty_pct = pct;
        if (pct !== null) clean.duty_per_kg = null;
        clean.duty_source_kind = pct === null ? null : "estimate";
        clean.duty_source = pct === null ? null : `Lagt inn av ${ctx.who} (prosent av verdi)`;
        break;
      }
      case "packaging_nok":
        clean.packaging_nok = empty ? null : numberBetween(v, 0, 1000, "Emballasje");
        break;
      case "pcs_per_carton": {
        if (empty) {
          clean.pcs_per_carton = null;
          clean.pcs_source = null;
        } else {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new Error("Stk per kartong må være et helt tall mellom 1 og 100000");
          clean.pcs_per_carton = n;
          clean.pcs_source = "typed";
        }
        break;
      }
      case "vat_rate": {
        const rate = empty ? null : Number(v);
        if (rate !== null && !(rate >= 0 && rate <= 0.5)) throw new Error("MVA må være mellom 0 og 50 %");
        clean.vat_rate = rate;
        break;
      }
      case "net_weight_kg":
        clean.net_weight_kg = empty ? null : numberBetween(v, 0.001, 10_000_000, "Nettovekt");
        break;
      case "sales_unit_kg":
        clean.sales_unit_kg = empty ? null : numberBetween(v, 0.001, 1000, "Salgsenhet");
        break;
      case "price_override":
        clean.price_override = empty ? null : numberBetween(v, 0.01, 100_000, "Pris");
        break;
      case "chosen_unit_price":
        clean.chosen_unit_price = empty ? null : numberBetween(v, 0, 10_000_000, "Enhetspris");
        break;
      case "done":
        clean.done = Boolean(v);
        break;
    }
  }
  if (line.pushed_at && Object.keys(clean).some((k) => k !== "done")) {
    // Corrections after a push are allowed (and re-pushed); clear the sent marker only on a re-push.
  }
  clean.updated_at = ctx.now().toISOString();
  const [updated] = await ctx.db.update<LineRow>("vm_lines", { id: `eq.${lineId}` }, clean);

  // Remember what only has to be typed once.
  if ("duty_per_kg" in clean && clean.duty_per_kg !== null) {
    await ctx.db.remove("vm_customs_rates", { scope: "eq.product", supplier: `eq.${shipment.supplier_name}`, idx: `eq.${line.idx}`, source_kind: "eq.estimate" });
    await ctx.db.insert("vm_customs_rates", {
      scope: "product",
      cn8: null,
      hs6: null,
      supplier: shipment.supplier_name,
      idx: line.idx,
      title_key: null,
      duty_per_kg: clean.duty_per_kg,
      duty_pct: null,
      source_kind: "estimate",
      source_ref: "typed by us, estimate",
      source_date: today(ctx),
      created_by: ctx.who,
    });
  }
  if ("duty_pct" in clean && clean.duty_pct !== null && clean.duty_pct !== undefined) {
    await ctx.db.remove("vm_customs_rates", { scope: "eq.product", supplier: `eq.${shipment.supplier_name}`, idx: `eq.${line.idx}`, source_kind: "eq.estimate" });
    await ctx.db.insert("vm_customs_rates", {
      scope: "product",
      cn8: null,
      hs6: null,
      supplier: shipment.supplier_name,
      idx: line.idx,
      title_key: null,
      duty_per_kg: 0,
      duty_pct: clean.duty_pct,
      source_kind: "estimate",
      source_ref: "typed by us, estimate",
      source_date: today(ctx),
      created_by: ctx.who,
    });
  }
  if ("sales_unit_kg" in clean && line.shopify_product_id) {
    await saveProductSettings(ctx, line.shopify_product_id, { sales_unit_kg: clean.sales_unit_kg as number | null });
  }
  return updated;
}

export interface ProductSettings {
  shopify_product_id: string;
  sales_unit_kg: number | null;
  gp_code: string | null;
  gp_packaging_kg: number | null;
  updated_at: string;
}

/** Update some of a product's remembered settings without blanking the others. */
export async function saveProductSettings(
  ctx: Ctx,
  productId: string,
  patch: Partial<Pick<ProductSettings, "sales_unit_kg" | "gp_code" | "gp_packaging_kg">>,
): Promise<ProductSettings> {
  const [existing] = await ctx.db.select<ProductSettings>("vm_product_settings", { shopify_product_id: `eq.${productId}`, limit: 1 });
  const row = {
    shopify_product_id: productId,
    sales_unit_kg: existing?.sales_unit_kg ?? null,
    gp_code: existing?.gp_code ?? null,
    gp_packaging_kg: existing?.gp_packaging_kg ?? null,
    ...patch,
    updated_at: ctx.now().toISOString(),
  };
  const [saved] = await ctx.db.insert<ProductSettings>("vm_product_settings", row, { onConflict: "shopify_product_id", merge: true });
  return saved;
}

export async function setDone(ctx: Ctx, shipmentId: string, lineIds: string[], done: boolean): Promise<number> {
  if (!lineIds.length) return 0;
  let updated = 0;
  for (const group of chunk(lineIds, IN_CHUNK)) {
    const rows = await ctx.db.update<LineRow>("vm_lines", { shipment_id: `eq.${shipmentId}`, id: `in.(${group.join(",")})` }, { done, updated_at: ctx.now().toISOString() });
    updated += rows.length;
  }
  return updated;
}

// ============================================================================ push

export interface PreflightRow {
  lineId: string;
  idx: string;
  name: string;
  blocked: string[];
  warnings: string[];
}

export interface PushPlanRow extends PreflightRow {
  update: PriceUpdate | null;
}

const toPreflight = (r: PushPlanRow): PreflightRow => ({ lineId: r.lineId, idx: r.idx, name: r.name, blocked: r.blocked, warnings: r.warnings });

/** What a push of the chosen rows would do, without doing it. */
export async function planPush(ctx: Ctx, shipmentId: string, lineIds?: string[]): Promise<{ shipment: ShipmentRow; rows: PushPlanRow[]; current: Map<string, ShopProduct>; shipmentWarnings: string[] }> {
  const view = await getShipmentView(ctx, shipmentId);
  const calc = calculate(view.shipment, view.lines);
  const calcOf = new Map(calc.rows.map((r) => [r.line.id, r]));
  // Rows that are done and either never sent or edited since — an unchanged sent row is not sent again.
  const wanted = view.lines.filter((l) => (!lineIds || lineIds.includes(l.id)) && needsPush(l, calcOf.get(l.id)!.result));

  // Read the shop as it is now: a product may have been changed or deleted since import.
  const productIds = wanted.map((l) => l.shopify_product_id).filter((x): x is string => !!x);
  const current = await ctx.shopify.productsByIds(productIds);

  const rows = wanted.map((line): PushPlanRow => {
    const c = calcOf.get(line.id)!;
    const blocked = [...c.blocked];
    const warnings = [...c.warnings];
    const product = line.shopify_product_id ? current.get(line.shopify_product_id) : undefined;
    if (line.shopify_product_id && !product) blocked.push("Produktet finnes ikke lenger i Shopify");
    if (product && product.variantCount > 1) blocked.push("Produktet har flere varianter – ikke støttet");
    if (product && product.status === "ARCHIVED") blocked.push("Produktet er arkivert i Shopify");
    if (product && line.shopify && product.status !== line.shopify.status) {
      warnings.push(`Statusen i Shopify er endret siden importen (${line.shopify.status} → ${product.status})`);
    }

    const r = c.result;
    let update: PriceUpdate | null = null;
    if (!blocked.length && product && r.ourPrice !== null && r.casePrice !== null && r.costInclVat !== null) {
      // DRAFT → ACTIVE the first time; a re-push only corrects prices.
      const activate = product.status === "DRAFT" && !(line.pushed?.activated);
      update = {
        productId: product.id,
        variantId: product.variantId,
        // Shopify's own prices do not multiply out: leave its productType and case price exactly as they are.
        productType: r.casePriceKept ? product.productType : formatProductType(r.ourPrice),
        casePrice: formatDecimal(r.casePriceKept && product.variantPrice !== null ? product.variantPrice : r.casePrice),
        unitCost: formatDecimal(r.costInclVat),
        activate,
        // Origin only when the product has none; the shop's own value is never overwritten.
        countryName: product.countryName ? null : countryName(line.country),
      };
    }
    return { lineId: line.id, idx: line.idx, name: line.shopify?.title ?? line.name, blocked, warnings, update };
  });
  return { shipment: view.shipment, rows, current, shipmentWarnings: shipmentWarnings(view.shipment, view.lines) };
}

export interface PushOutcome {
  mode: "dry-run" | "fake" | "live";
  requested: number;
  sent: number;
  succeeded: number;
  failed: number;
  blocked: PreflightRow[];
  /** Warnings the operator has to acknowledge before a real push. Empty once acknowledged. */
  needsAcknowledgement: PreflightRow[];
  /** Things about the whole shipment (no freight, no arrival date) — also acknowledged before a real push. */
  shipmentWarnings: string[];
  /** What each request would contain (dry-run only). */
  requests?: Array<{ query: string; variables: Record<string, unknown>; productIds: string[] }>;
  errors: Array<{ lineId: string; idx: string; userErrors: Array<{ field: string[] | null; message: string }> }>;
}

export async function pushShipment(
  ctx: Ctx,
  shipmentId: string,
  opts: { dryRun: boolean; lineIds?: string[]; acknowledgeWarnings?: boolean },
): Promise<PushOutcome> {
  const { rows, current, shipmentWarnings: shipWarn } = await planPush(ctx, shipmentId, opts.lineIds);
  const blocked = rows.filter((r) => r.blocked.length);
  const sendable = rows.filter((r) => r.update);
  const withWarnings = sendable.filter((r) => r.warnings.length);
  const mode = opts.dryRun ? "dry-run" : ctx.shopify.mode;

  const outcome: PushOutcome = {
    mode,
    requested: rows.length,
    sent: 0,
    succeeded: 0,
    failed: 0,
    blocked: blocked.map(toPreflight),
    needsAcknowledgement: [],
    shipmentWarnings: sendable.length ? shipWarn : [],
    errors: [],
  };

  if (opts.dryRun) {
    outcome.requests = chunk(sendable.map((r) => r.update!), BATCH_SIZE).map((group) =>
      buildBatchRequest(group, group.some((u) => u.activate) ? "gid://shopify/Publication/ONLINE_STORE" : null),
    );
    outcome.needsAcknowledgement = withWarnings.map(toPreflight);
    // A preview is not an event: nothing was sent, so nothing goes in the log.
    return outcome;
  }

  if ((withWarnings.length || outcome.shipmentWarnings.length) && !opts.acknowledgeWarnings) {
    outcome.needsAcknowledgement = withWarnings.map(toPreflight);
    return outcome;
  }
  if (!sendable.length) return outcome;

  const results = [];
  for (const group of chunk(sendable, BATCH_SIZE)) {
    results.push(...(await ctx.shopify.pushBatch(group.map((r) => r.update!))));
  }
  outcome.sent = sendable.length;

  const resultOf = new Map(results.map((r) => [r.productId, r]));
  for (const row of sendable) {
    const res = resultOf.get(row.update!.productId);
    const ok = !!res?.ok;
    const now = ctx.now().toISOString();
    await ctx.db.update("vm_lines", { id: `eq.${row.lineId}` }, ok
      ? {
          pushed_at: now,
          pushed: { productType: row.update!.productType, casePrice: row.update!.casePrice, unitCost: row.update!.unitCost, activated: row.update!.activate || undefined, mode },
          push_errors: null,
          updated_at: now,
        }
      : { push_errors: res?.userErrors ?? [{ field: null, message: "Ingen svar fra Shopify" }], updated_at: now });
    if (ok) outcome.succeeded++;
    else {
      outcome.failed++;
      outcome.errors.push({ lineId: row.lineId, idx: row.idx, userErrors: res?.userErrors ?? [] });
    }
  }
  await logPush(ctx, shipmentId, sendable, current, mode, resultOf);
  await recordCosts(ctx, shipmentId, sendable.filter((r) => resultOf.get(r.update!.productId)?.ok));
  if (outcome.succeeded > 0) {
    const all = await ctx.db.select<Pick<LineRow, "pushed_at">>("vm_lines", { shipment_id: `eq.${shipmentId}`, select: "pushed_at" });
    await ctx.db.update("vm_shipments", { id: `eq.${shipmentId}` }, { status: all.every((l) => l.pushed_at) ? "pushed" : "review", updated_at: ctx.now().toISOString() });
  }

  await ctx.log(outcome.failed ? "warn" : "info", "varemottak.push", `${ctx.who} sendte ${outcome.succeeded} av ${outcome.sent} varer til Shopify (${mode})${outcome.failed ? `, ${outcome.failed} feilet` : ""}`, { shipmentId, mode });
  return outcome;
}

async function logPush(
  ctx: Ctx,
  shipmentId: string,
  rows: PushPlanRow[],
  current: Map<string, ShopProduct>,
  mode: "dry-run" | "fake" | "live",
  results: Map<string, { ok: boolean; userErrors: unknown[] }> | null,
) {
  await ctx.db.insert(
    "vm_push_log",
    rows.map((r) => {
      const before = current.get(r.update!.productId);
      return {
        at: ctx.now().toISOString(),
        shipment_id: shipmentId,
        line_id: r.lineId,
        product_id: r.update!.productId,
        by_user: ctx.who,
        mode,
        request: r.update,
        // What it replaces, so a mistaken push can be undone by hand.
        previous: before
          ? { productType: before.productType, variantPrice: before.variantPrice, unitCost: before.unitCost, status: before.status }
          : null,
        result: results ? results.get(r.update!.productId) ?? null : null,
      };
    }),
  );
}

/** After a successful push, fill in the cost and our price in the purchase history. */
async function recordCosts(ctx: Ctx, shipmentId: string, rows: PushPlanRow[]) {
  const shipment = await getShipment(ctx, shipmentId);
  for (const r of rows) {
    await ctx.db.update(
      "vm_price_history",
      { shipment_id: `eq.${shipmentId}`, supplier: `eq.${shipment.supplier_name}`, idx: `eq.${r.idx}` },
      { cost_incl_vat: Number(r.update!.unitCost), our_price: parseUnitPrice(r.update!.productType) },
    );
  }
}

export async function pushLog(ctx: Ctx, shipmentId: string) {
  return ctx.db.select<{ id: number; at: string; line_id: string | null; product_id: string | null; by_user: string | null; mode: string; request: unknown; previous: unknown; result: unknown }>("vm_push_log", {
    shipment_id: `eq.${shipmentId}`,
    // id breaks ties between entries written in the same instant (one push writes many rows)
    order: "at.desc,id.desc",
    limit: 500,
  });
}

// keep imports used for type-only consumers
export type { LineRow, ShipmentRow, InvoiceRow } from "./lines";
export { calcLine, lineInput, rowChecks, settingsOf, shipmentTotals, shopifyUnitPrice };
