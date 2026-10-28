/**
 * Excel backup of a shipment: the review screen's columns, as numbers (not text), so the
 * client can still sort and filter in Excel the way they do today.
 */
import * as XLSX from "xlsx";
import { calculate, type InvoiceRow, type LineRow, type ShipmentRow } from "./lines";
import { summarize } from "./calc";

const pct = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 10);
const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

export function buildWorkbook(shipment: ShipmentRow, invoices: InvoiceRow[], lines: LineRow[]): Buffer {
  const calc = calculate(shipment, lines);
  const otherCosts = invoices.reduce((a, inv) => a + inv.extra_lines.reduce((s, e) => s + e.value * (Number(shipment.rates[inv.currency]) || (inv.currency === "NOK" ? 1 : 0)), 0), 0);
  const summary = summarize(calc.rows, otherCosts);

  const header = [
    "Art.nr", "Navn (leverandør)", "Tittel (Shopify)", "HS", "Opprinnelse", "Enhet", "Antall", "Stk/kartong",
    "Pris/enhet (faktura)", "Valuta", "Varekost NOK", "Toll kr/kg", "Tollkilde", "Toll/enhet", "Emballasje",
    "Frakt/enhet", "Landed cost", "Kost inkl. mva", "Foreslått pris", "Vår pris (DIN PRIS)", "Kartongpris",
    "Margin %", "Forrige innkjøpspris", "Endring %", "Shopify-status", "Shopify-pris nå", "Ny/påfyll", "Ferdig", "Sendt", "Advarsler",
  ];
  const body = calc.rows.map(({ line: l, result: r, blocked, warnings }) => [
    l.idx,
    l.name,
    l.shopify?.title ?? "",
    l.hs ?? "",
    l.country,
    l.unit === "kilo" ? "kg" : "stk",
    Number(l.qty),
    l.pcs_per_carton,
    l.chosen_unit_price ?? l.unit_price,
    l.currency,
    r2(r.goodsNok),
    l.duty_per_kg,
    l.duty_source ?? "",
    r2(r.dutyNok),
    r2(r.packagingNok),
    r2(r.freightNok),
    r2(r.landedCost),
    r2(r.costInclVat),
    r.suggestedPrice,
    r.ourPrice,
    r2(r.casePrice),
    pct(r.margin),
    l.history?.previous?.unit_price ?? null,
    pct(l.history?.change.changePct ?? null),
    l.shopify?.status ?? "",
    l.shopify ? l.shopify.productType : "",
    l.is_new ? "Ny" : "Påfyll",
    l.done ? "ja" : "",
    l.pushed_at ? l.pushed_at.slice(0, 10) : "",
    [...blocked, ...warnings].join("; "),
  ]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  ws["!cols"] = header.map((h, i) => ({ wch: i === 1 || i === 2 ? 40 : i === 29 ? 60 : Math.max(10, h.length + 2) }));
  ws["!freeze"] = { xSplit: 1, ySplit: 1 } as never;
  XLSX.utils.book_append_sheet(wb, ws, "Varer");

  const sum = [
    ["Forsendelse", shipment.name],
    ["Leverandør", shipment.supplier_name],
    ["Ankomstdato", shipment.arrival_date ?? ""],
    ["Kurser", Object.entries(shipment.rates).map(([c, v]) => `${c} ${v}`).join(", ")],
    ["Frakt", shipment.freight_amount === null ? "" : `${shipment.freight_amount} ${shipment.freight_currency}`],
    [],
    ["", "Inkl. mva", "Ekskl. mva"],
    ["Salgsverdi", r2(summary.salesInclVat), r2(summary.salesExclVat)],
    ["Kost", r2(summary.costInclVat), r2(summary.costExclVat)],
    ["Forventet fortjeneste", r2(summary.profitInclVat), r2(summary.profitExclVat)],
    ["Margin %", pct(summary.marginInclVat), pct(summary.marginExclVat)],
    ["Varer uten pris (mangler toll)", summary.unpricedRows],
    ["Egne forsendelseskostnader (NOK)", r2(otherCosts)],
    [],
    ["Fakturaer"],
    ...invoices.map((inv) => [inv.invoice_no, inv.currency, inv.net_total ?? "", inv.control.map((c) => c.text).join(" | ")]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), "Sammendrag");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
