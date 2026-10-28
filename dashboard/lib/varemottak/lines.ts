/**
 * A shipment row as the database stores it, and the pure rules that turn it into engine
 * input and into "can this be pushed?". No I/O: the review screen (browser) and the
 * push (server) run exactly the same code, so what the operator saw is what gets sent.
 */
import {
  calcLine,
  summarize,
  type LineInput,
  type LineResult,
  type ShipmentSettings,
  type ShipmentSummary,
  type ShipmentTotals,
  freightToNok,
} from "./calc";
import { priceConsistencyWarning } from "./carton";
import { priceAlert, type PriceChange, type PreviousPurchase } from "./history";
import { formatDecimal, formatProductType, parseUnitPrice } from "./shopify/payloads";

/** The Shopify product as it was when the shipment was imported. */
export interface ShopifySnapshot {
  title: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  vendor: string;
  productType: string;
  variantPrice: number | null;
  unitCost: number | null;
  variantId: string;
  variantCount: number;
  inventoryItemId: string | null;
  imageUrl: string | null;
  tags: string[];
  handle: string;
  countryName: string | null;
  /** Barcodes on the product at import. Absent on rows imported before this was stored. */
  barcodes?: string[];
}

export interface ShipmentRow {
  id: string;
  name: string;
  supplier_id: string | null;
  supplier_name: string;
  arrival_date: string | null;
  status: "draft" | "review" | "pushed" | "archived";
  rates: Record<string, number>;
  freight_amount: number | null;
  freight_currency: string;
  markup_mode: "markup" | "margin";
  markup_value: number;
  margin_threshold: number;
  drink_packaging_nok: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceRow {
  id: string;
  shipment_id: string;
  invoice_no: string;
  invoice_date: string | null;
  currency: string;
  spec_file: string | null;
  pdf_file: string | null;
  net_total: number | null;
  vat_total: number | null;
  gross_total: number | null;
  net_weight_kg: number | null;
  extra_lines: Array<{ no: number; name: string; qty: number; unit: string; value: number }>;
  control: Array<{ code: string; severity: string; text: string }>;
  warnings: string[];
}

export interface LineHistory {
  previous: PreviousPurchase | null;
  change: PriceChange;
}

export interface LineRow {
  id: string;
  shipment_id: string;
  invoice_id: string | null;
  position: number;
  currency: string;
  idx: string;
  name: string;
  unit: "pcs" | "kilo";
  qty: number;
  cartons: number | null;
  country: string;
  ean: string | null;
  ean_box: string | null;
  hs: string | null;
  hs_fixed: boolean;
  net_weight_kg: number | null;
  line_value: number | null;
  unit_price: number | null;
  price_conflict: Array<{ unitPrice: number; qty: number; lines: number[] }> | null;
  source_lines: number[];
  issues: string[];
  match_status: "matched" | "doubtful" | "unmatched";
  match_via: "link" | "tag" | "ean" | "none";
  match_reason: string;
  match_candidates: string[];
  shopify_product_id: string | null;
  shopify: ShopifySnapshot | null;
  is_new: boolean;
  mva25: boolean;
  /** VAT set by hand for this line; null = automatic (the mva-25 tag, then the customs code). */
  vat_rate: number | null;
  history: LineHistory | null;
  duty_per_kg: number | null;
  /** Duty as a share of the goods value (0.19 = 19 %); when set it is used instead of kr/kg. */
  duty_pct: number | null;
  /** Packaging per unit typed or declared for this row; null = automatic (the drink fee). */
  packaging_nok: number | null;
  duty_source: string | null;
  duty_source_kind: "declaration" | "cn8" | "product" | "hs6" | "estimate" | null;
  pcs_per_carton: number | null;
  pcs_source: string | null;
  sales_unit_kg: number | null;
  price_override: number | null;
  chosen_unit_price: number | null;
  done: boolean;
  pushed_at: string | null;
  pushed: { productType: string; casePrice: string; unitCost: string; activated: boolean; mode: string } | null;
  push_errors: Array<{ field: string[] | null; message: string }> | null;
  updated_at: string;
}

export function settingsOf(s: ShipmentRow, vat = { food: 0.15, mva25: 0.25 }): ShipmentSettings {
  return {
    markupMode: s.markup_mode,
    markupValue: Number(s.markup_value),
    marginThreshold: Number(s.margin_threshold),
    drinkPackagingNok: Number(s.drink_packaging_nok),
    vatFood: vat.food,
    vatMva25: vat.mva25,
  };
}

/** Freight for the whole shipment in NOK, and the weight it is spread over. */
export function shipmentTotals(s: ShipmentRow, lines: LineRow[]): ShipmentTotals & { freightMissingRate: boolean } {
  const amount = s.freight_amount === null ? 0 : Number(s.freight_amount);
  const nok = amount === 0 ? 0 : freightToNok(amount, s.freight_currency, s.rates);
  return {
    freightNok: nok ?? 0,
    freightMissingRate: amount !== 0 && nok === null,
    totalNetWeightKg: lines.reduce((a, l) => a + (Number(l.net_weight_kg) || 0), 0),
  };
}

/** Our current unit price in the shop — only trustworthy for an ACTIVE product. */
export function shopifyUnitPrice(l: LineRow): number | null {
  return l.shopify?.status === "ACTIVE" ? parseUnitPrice(l.shopify.productType) : null;
}

export function lineInput(l: LineRow, s: ShipmentRow): LineInput {
  const chosen = l.chosen_unit_price;
  return {
    rateToNok: l.currency === "NOK" ? 1 : Number(s.rates[l.currency]) || 0,
    quantity: Number(l.qty),
    unit: l.unit,
    lineValue: chosen != null ? chosen * Number(l.qty) : Number(l.line_value) || 0,
    netWeightKg: Number(l.net_weight_kg) || 0,
    hs: l.hs,
    dutyPerKg: l.duty_per_kg == null ? null : Number(l.duty_per_kg),
    dutyPctOfValue: l.duty_pct == null ? null : Number(l.duty_pct),
    dutyDeclared: l.duty_source_kind === "declaration",
    packagingOverride: l.packaging_nok == null ? null : Number(l.packaging_nok),
    pcsPerCarton: l.pcs_per_carton ?? null,
    salesUnitKg: l.sales_unit_kg == null ? null : Number(l.sales_unit_kg),
    mva25: !!l.mva25,
    vatOverride: l.vat_rate === null || l.vat_rate === undefined ? null : Number(l.vat_rate),
    shopifyStatus: l.shopify?.status ?? null,
    shopifyUnitPrice: shopifyUnitPrice(l),
    shopifyCasePrice: l.shopify?.status === "ACTIVE" ? l.shopify.variantPrice : null,
    ourPriceOverride: l.price_override == null ? null : Number(l.price_override),
  };
}

export interface CalculatedLine {
  line: LineRow;
  input: LineInput;
  result: LineResult;
  /** Reasons this row cannot be pushed. */
  blocked: string[];
  /** Reasons to double-check; the operator may push anyway. */
  warnings: string[];
}

export function calculate(s: ShipmentRow, lines: LineRow[]): { rows: CalculatedLine[]; totals: ReturnType<typeof shipmentTotals>; summary: ShipmentSummary } {
  const settings = settingsOf(s);
  const totals = shipmentTotals(s, lines);
  const rows = lines.map((line) => {
    const input = lineInput(line, s);
    const result = calcLine(input, totals, settings);
    return { line, input, result, ...rowChecks(line, input, result, s, settings, totals.freightMissingRate) };
  });

  // One Shopify product on two rows would be priced twice, the last one winning. Never silently.
  const byProduct = new Map<string, LineRow[]>();
  for (const r of rows) {
    const id = r.line.shopify_product_id;
    if (id) byProduct.set(id, [...(byProduct.get(id) ?? []), r.line]);
  }
  for (const r of rows) {
    const same = r.line.shopify_product_id ? byProduct.get(r.line.shopify_product_id) ?? [] : [];
    if (same.length > 1) {
      r.blocked.push(`Samme Shopify-produkt står på flere rader (${same.map((x) => x.idx).join(", ")}) – velg riktig produkt på én av dem`);
    }
  }
  return { rows, totals, summary: summarize(rows, 0) };
}

/** Blocked = cannot be sent. Warnings = look again, then it is the operator's call. */
const barcodeKey = (b: string) => b.replace(/^0+/, "");

/**
 * The invoice's EAN against the product's barcode in Shopify. Only a hint to fix the product in Shopify —
 * the system never writes barcodes, and the match itself was decided by the article number.
 */
export function barcodeWarning(line: Pick<LineRow, "ean" | "ean_box" | "shopify">): string | null {
  const invoice = [line.ean, line.ean_box].filter((e): e is string => !!e);
  const shop = line.shopify?.barcodes;
  if (!invoice.length || !shop) return null;
  if (shop.length === 0) return `Produktet mangler strekkode i Shopify (faktura: ${invoice[0]})`;
  if (shop.some((b) => invoice.some((e) => barcodeKey(e) === barcodeKey(b)))) return null;
  return `Strekkoden i Shopify (${shop[0]}) er ikke den på fakturaen (${invoice.join(" / ")}) – sjekk strekkoden i Shopify`;
}

export const SAUSAGE_WARNING = "Pølse (HS 1601): toll er enten 0 eller 84,31 kr/kg etter tollkvote – bekreft satsen fra deklarasjonen";
export const ICE_CREAM_WARNING = "Iskrem (HS 2105): høy toll som ikke er kjent før deklarasjonen kommer – kostprisen er trolig for lav";
export const SANCTIONS_WARNING = "Opprinnelse Russland/Belarus – sanksjonssjekk før sending";
export const NO_HS_WARNING = "Mangler tollnummer (HS) – drikke- og mva-reglene og tollregisteret kan ikke brukes på raden";
export const NO_ORIGIN_WARNING = "Mangler opprinnelsesland – sanksjonssjekken og landfeltet i Shopify kan ikke gjøres";
export const GIFT_WARNING = "Svært lav enhetspris (gave?) – kostprisen er bare frakt og toll, sjekk om varen skal prises";
const SANCTIONED = ["RU", "BY"];
const pctText = (v: number) => (Math.round(v * 1000) / 10).toString().replace(".", ",");

export function rowChecks(
  line: LineRow,
  input: LineInput,
  r: LineResult,
  s: ShipmentRow,
  settings: ShipmentSettings,
  freightMissingRate = false,
): { blocked: string[]; warnings: string[] } {
  const blocked: string[] = [];
  const warnings: string[] = [];

  if (!line.shopify_product_id || line.match_status === "unmatched") blocked.push("Ikke koblet til et Shopify-produkt");
  else if (line.match_status === "doubtful") blocked.push(`Usikker kobling – bekreft produktet (${line.match_reason})`);
  if (line.shopify && line.shopify.variantCount > 1) blocked.push("Produktet har flere varianter – ikke støttet");
  if (line.price_conflict && line.chosen_unit_price === null) blocked.push("Samme varenummer til ulik pris – velg pris");
  if (r.flags.missingDuty) blocked.push("Mangler toll");
  if (r.flags.missingQuantity) blocked.push("Mangler antall");
  // The invoice value is what the whole cost is built on: an empty, unreadable or negative one must not reach a price.
  if (line.chosen_unit_price === null) {
    if (line.line_value === null || line.line_value === undefined || !Number.isFinite(Number(line.line_value))) blocked.push("Mangler fakturaverdi");
    else if (Number(line.line_value) < 0) blocked.push("Negativ fakturaverdi – kreditnota eller feil i filen");
  }
  if (!input.rateToNok) blocked.push(`Mangler kurs for ${line.currency}`);
  if (!line.pcs_per_carton) blocked.push("Mangler stk per kartong");
  if (r.ourPrice === null) blocked.push("Mangler pris");
  if (freightMissingRate) blocked.push(`Mangler kurs for fraktvalutaen ${s.freight_currency}`);
  // Cost is per kg on a kg invoice, the price may be per box: without the box size the margin is meaningless.
  if (line.unit === "kilo" && !line.sales_unit_kg) blocked.push("Kg-vare: oppgi salgsenhet (kg per enhet, f.eks. 1 eller 2,4)");

  const barcode = barcodeWarning(line);
  if (barcode) warnings.push(barcode);

  // The client's special cases (package 6_special_cases.md): never priced without a person looking.
  const hs = (line.hs ?? "").replace(/\D/g, "");
  if (hs.startsWith("1601")) warnings.push(SAUSAGE_WARNING);
  if (hs.startsWith("2105")) warnings.push(ICE_CREAM_WARNING);
  if (SANCTIONED.includes((line.country ?? "").trim().toUpperCase())) warnings.push(SANCTIONS_WARNING);
  if (line.unit_price !== null && Number(line.unit_price) >= 0 && Number(line.unit_price) <= 0.05) warnings.push(GIFT_WARNING);
  if (!hs) warnings.push(NO_HS_WARNING);
  if (!(line.country ?? "").trim()) warnings.push(NO_ORIGIN_WARNING);

  if (r.flags.priceBelowCost) warnings.push("Pris under kost");
  else if (r.flags.marginBelowThreshold) {
    warnings.push(`Margin ${r.margin !== null ? (r.margin * 100).toFixed(1) : "?"} % er under ${(settings.marginThreshold * 100).toFixed(0)} %`);
  }
  if (r.flags.missingWeight && !r.isDrink) warnings.push("Mangler nettovekt (toll og frakt avhenger av den)");
  if (line.history?.change.raisedWhileOurPriceUnchanged) warnings.push("Leverandøren har hevet prisen – sjekk vår pris");
  const alert = priceAlert(line.history?.change, line.history?.previous, r.costInclVat);
  if (alert?.supplierPct != null) warnings.push(`Prisvarsel: leverandørprisen er opp ${pctText(alert.supplierPct)} % (varsler ved 10 % eller mer)`);
  if (alert?.costPct != null) warnings.push(`Prisvarsel: kostprisen inkl. mva er opp ${pctText(alert.costPct)} % fra forrige kjøp (varsler ved 15 % eller mer)`);
  if (r.casePriceKept && line.shopify) {
    warnings.push(
      line.shopify.productType.trim() === ""
        ? `Shopify har ingen stk-pris (produkttype er tom, pris ${line.shopify.variantPrice}) – prisen i Shopify beholdes uendret. Skriv inn egen pris for å endre den`
        : `Shopifys pris går ikke opp (${line.shopify.productType} × ${line.pcs_per_carton} ≠ ${line.shopify.variantPrice}) – kartongprisen i Shopify beholdes uendret. Skriv inn egen pris for å endre den`,
    );
  } else if (line.shopify) {
    const consistency = priceConsistencyWarning(line.shopify, line.pcs_per_carton);
    if (consistency) warnings.push(consistency);
  }
  return { blocked, warnings };
}

/**
 * The three values a push would write for this row, as Shopify gets them. The server builds its
 * update from the same rule (plus the product's live state), and the screen uses it to tell
 * whether a sent row has changed since.
 */
export function intendedValues(line: LineRow, r: LineResult): { productType: string; casePrice: string; unitCost: string } | null {
  if (r.ourPrice === null || r.casePrice === null || r.costInclVat === null) return null;
  return {
    // Shopify's own prices do not multiply out: its productType and case price are left as they are.
    productType: r.casePriceKept && line.shopify ? line.shopify.productType : formatProductType(r.ourPrice),
    casePrice: formatDecimal(r.casePriceKept && line.shopify?.variantPrice != null ? line.shopify.variantPrice : r.casePrice),
    unitCost: formatDecimal(r.costInclVat),
  };
}

/** A row that was sent and has been edited since: it has to go again. */
export function changedSincePush(line: LineRow, r: LineResult): boolean {
  if (!line.pushed_at || !line.pushed) return false;
  const v = intendedValues(line, r);
  return !!v && (v.productType !== line.pushed.productType || v.casePrice !== line.pushed.casePrice || v.unitCost !== line.pushed.unitCost);
}

/** Done, and either never sent or changed since — what the next push should carry. */
export function needsPush(line: LineRow, r: LineResult): boolean {
  return line.done && (!line.pushed_at || changedSincePush(line, r));
}

/** Things about the shipment as a whole that the operator should see before sending. */
export function shipmentWarnings(s: ShipmentRow, lines: LineRow[]): string[] {
  const out: string[] = [];
  if (!lines.length) return out;
  if (s.freight_amount === null || Number(s.freight_amount) === 0) {
    out.push("Frakt er ikke lagt inn – kostprisene er uten frakt");
  }
  if (!s.arrival_date) out.push("Ankomstdato mangler – varene telles ikke i Grønt Punkt");
  return out;
}

/** English country names for the `custom.country_name` metafield. */
export const COUNTRY_NAMES: Record<string, string> = {
  AL: "Albania", AT: "Austria", AZ: "Azerbaijan", BA: "Bosnia and Herzegovina", BE: "Belgium", BG: "Bulgaria",
  BY: "Belarus", CH: "Switzerland", CN: "China", CY: "Cyprus", CZ: "Czech Republic", DE: "Germany", DK: "Denmark",
  EE: "Estonia", EG: "Egypt", ES: "Spain", FI: "Finland", FR: "France", GB: "United Kingdom", GE: "Georgia",
  GR: "Greece", HR: "Croatia", HU: "Hungary", ID: "Indonesia", IE: "Ireland", IL: "Israel", IN: "India", IR: "Iran",
  IT: "Italy", JP: "Japan", KR: "South Korea", KZ: "Kazakhstan", LB: "Lebanon", LT: "Lithuania", LV: "Latvia",
  MA: "Morocco", MD: "Moldova", ME: "Montenegro", MK: "North Macedonia", MY: "Malaysia", NL: "Netherlands",
  NO: "Norway", PK: "Pakistan", PL: "Poland", PT: "Portugal", RO: "Romania", RS: "Serbia", RU: "Russia",
  SA: "Saudi Arabia", SE: "Sweden", SI: "Slovenia", SK: "Slovakia", SY: "Syria", TH: "Thailand", TN: "Tunisia",
  TR: "Turkey", UA: "Ukraine", US: "United States", UZ: "Uzbekistan", VN: "Vietnam",
};

export const countryName = (iso: string) => COUNTRY_NAMES[iso.trim().toUpperCase()] ?? null;
