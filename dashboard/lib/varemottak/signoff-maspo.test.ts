/**
 * ENGINE SIGN-OFF against the client's own finished price sheet.
 *
 * fwter/maspo-price-sheet.xlsx is the client's pricing of the same three Maspo invoices as fwter/01.xlsx
 * (2610-EX/01/00512, 00513, 00514): rate PLN→NOK 2.479 (from customs declaration 89060), freight 2 100 EUR × 11,
 * markup 30 %. Its columns are live formulas, so the sheet is the client's pricing engine written down:
 *
 *   price/unit      J = I / G                         goods NOK   K = J × rate
 *   duty/unit       N = M / G   (M = duty NOK for the line, from the declaration)
 *   freight/unit    P = freight ÷ total net weight × line weight ÷ qty
 *   landed          Q = K + N + O(packaging) + P      cost incl. VAT  R = Q × 1.15
 *   suggested       U = CEILING(R × 1.30, 0.5)        margin      X = (V − R) ÷ V
 *
 * We feed OUR pipeline (the real import, the real engine) the same inputs and compare every row. Client files:
 * skipped where absent.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { isNonFoodVatHs } from "./calc";
import { calculate } from "./lines";
import { MemoryDb, seedDefaults } from "./db";
import { createShipment, getShipmentView, importInvoice, patchLine, patchShipment, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

const F = path.resolve(__dirname, "../../../fwter");
const SHEET = path.join(F, "maspo-price-sheet.xlsx");
const SPEC = path.join(F, "01.xlsx");
const SNAP = path.join(F, "shopify-snapshot-all.json");
const have = existsSync(SHEET) && existsSync(SPEC) && existsSync(SNAP);

interface SheetRow {
  idx: string;
  unit: string;
  qty: number;
  pcs: number;
  value: number;
  weight: number;
  duty: number;
  packaging: number;
  yourPrice: number | null;
  shopStatus: string;
  shopPrice: number | null;
  note: string;
}

const n = (v: unknown) => (v === "" || v === undefined || v === null ? 0 : Number(v));

function readSheet() {
  const wb = XLSX.read(readFileSync(SHEET), { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
  const rate = n(grid[2][2]);
  const markup = n(grid[4][2]);
  const rows: SheetRow[] = [];
  for (let r = 11; r < grid.length; r++) {
    const g = grid[r];
    const idx = String(g[0] ?? "").trim();
    if (!idx || idx === "SUM" || !/^\d+$/.test(idx.replace(/[A-Z]+$/i, ""))) continue;
    rows.push({
      idx,
      unit: String(g[5]),
      qty: n(g[6]),
      pcs: n(g[7]),
      value: n(g[8]),
      weight: n(g[11]),
      duty: n(g[12]),
      packaging: n(g[14]),
      yourPrice: g[21] === "" ? null : n(g[21]),
      shopStatus: String(g[24]),
      shopPrice: g[25] === "" ? null : n(g[25]),
      note: String(g[29] ?? ""),
    });
  }
  return { rate, markup, rows };
}

const ceilHalf = (x: number) => Math.ceil(x * 2 - 1e-9) / 2;

let shared: { sheet: ReturnType<typeof readSheet>; calc: ReturnType<typeof calculate>; view: Awaited<ReturnType<typeof getShipmentView>> } | null = null;

describe.skipIf(!have)("engine sign-off: Maspo 2610-EX/01/00512-00514 against the client's finished sheet", () => {
  it("gives the same cost and suggested price on every row", async () => {
    const sheet = readSheet();
    expect(sheet.rows).toHaveLength(232);
    const freightNok = 2100 * 11;
    const totalWeight = sheet.rows.reduce((a, r) => a + r.weight, 0);

    const fake = FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAP, "utf8")), { draftEvery: 0 });
    const db = new MemoryDb();
    seedDefaults(db);
    const ctx: Ctx = { db, shopify: fake, who: "t", log: async () => {}, now: () => new Date("2026-10-09T12:00:00Z") };
    const s = await createShipment(ctx, { name: "Maspo", supplierName: "Supplier 01 (Excel, PLN)", arrivalDate: "2026-10-09" });
    await patchShipment(ctx, s.id, { rates: { PLN: sheet.rate, EUR: 11 }, freight_amount: 2100, freight_currency: "EUR", markup_value: sheet.markup });
    await importInvoice(ctx, s.id, { spec: { bytes: new Uint8Array(readFileSync(SPEC)), name: "01.xlsx" } });

    // The same inputs the client typed: duty per line from the declaration (as kr/kg), and one unit per kg for kg goods.
    const byIdx = new Map(sheet.rows.map((r) => [r.idx, r]));
    const vatByHand: string[] = [];
    for (const l of (await getShipmentView(ctx, s.id)).lines) {
      const row = byIdx.get(l.idx);
      if (!row) continue;
      const patch: Record<string, unknown> = { duty_per_kg: row.weight > 0 ? row.duty / row.weight : 0 };
      // The 9 Oct sheet applies 15 % to every row (formula x 1.15). Toy sweets under code 9503 are 25 % by the code
      // rule (the client corrected that in later sheets), so that one line is set to the sheet's 15 % by hand.
      if (l.mva25 || isNonFoodVatHs(l.hs)) {
        patch.vat_rate = 0.15;
        vatByHand.push(l.idx);
      }
      if (l.unit === "kilo") patch.sales_unit_kg = 1;
      await patchLine(ctx, l.id, patch);
    }
    const view = await getShipmentView(ctx, s.id);
    const calc = calculate(view.shipment, view.lines);
    shared = { sheet, calc, view };

    const diffs: string[] = [];
    let compared = 0;
    let maxCost = 0;
    let maxSuggested = 0;
    const missing: string[] = [];
    for (const row of sheet.rows) {
      const c = calc.rows.find((x) => x.line.idx === row.idx);
      if (!c) {
        missing.push(row.idx);
        continue;
      }
      const r = c.result;
      const goods = (row.value / row.qty) * sheet.rate;
      // The 9 Oct sheet charged declared duty on five milk-based drinks; the client's rule since 27 Oct is duty 0 on drinks.
      const isDrink = /^(2201|2202|2009|2204|2205|2206)/.test(c.line.hs ?? "");
      const duty = isDrink ? 0 : row.duty / row.qty;
      const freight = totalWeight > 0 ? ((freightNok / totalWeight) * row.weight) / row.qty : 0;
      const landed = goods + duty + row.packaging + freight;
      const cost = landed * 1.15;
      const suggested = ceilHalf(cost * (1 + sheet.markup));
      compared++;
      const dCost = r.costInclVat === null ? NaN : Math.abs(r.costInclVat - cost);
      const dSug = r.suggestedPrice === null ? NaN : Math.abs(r.suggestedPrice - suggested);
      maxCost = Math.max(maxCost, Number.isNaN(dCost) ? 0 : dCost);
      maxSuggested = Math.max(maxSuggested, Number.isNaN(dSug) ? 0 : dSug);
      if (!(dCost < 0.01) || !(dSug < 0.01)) {
        diffs.push(
          `${row.idx} ${row.unit} qty ${row.qty}: cost ours ${r.costInclVat?.toFixed(3)} vs sheet ${cost.toFixed(3)} | suggested ${r.suggestedPrice} vs ${suggested} | goods ${r.goodsNok.toFixed(3)}/${goods.toFixed(3)} duty ${r.dutyNok?.toFixed(3)}/${duty.toFixed(3)} pack ${r.packagingNok}/${row.packaging} freight ${r.freightNok.toFixed(3)}/${freight.toFixed(3)} vat ${r.vatRate}`,
        );
      }
    }
    console.log("SIGN-OFF compared rows:", compared, "| missing in app:", missing.length, missing.slice(0, 5).join(","));
    console.log("SIGN-OFF max cost difference:", maxCost.toFixed(4), "| max suggested-price difference:", maxSuggested.toFixed(4));
    console.log("SIGN-OFF rows that differ:", diffs.length);
    diffs.slice(0, 25).forEach((d) => console.log("  DIFF", d));
    expect(compared).toBe(232);
    expect(missing).toEqual([]);
    expect(vatByHand).toEqual(["51280"]);
    expect(diffs, diffs.join("\n")).toEqual([]);
  }, 300_000);

  it("also agrees on your price, the case price and the margin where the client has set a price", () => {
    const { sheet, calc } = shared!;
    let priced = 0;
    const off: string[] = [];
    for (const row of sheet.rows) {
      if (!(row.yourPrice && row.yourPrice > 0)) continue;
      const c = calc.rows.find((x) => x.line.idx === row.idx)!;
      priced++;
      const cost = c.result.costInclVat!;
      const sheetMargin = (row.yourPrice - cost) / row.yourPrice;
      const sheetCase = row.yourPrice * row.pcs;
      const okPrice = c.result.ourPrice !== null && Math.abs(c.result.ourPrice - row.yourPrice) < 0.005;
      const okMargin = c.result.margin !== null && Math.abs(c.result.margin - sheetMargin) < 0.0005;
      const okCase = c.result.casePrice !== null && Math.abs(c.result.casePrice - sheetCase) < 0.01;
      if (!okPrice || !okMargin || !okCase) off.push(`${row.idx} ${row.shopStatus}: price ours ${c.result.ourPrice} vs ${row.yourPrice} | case ${c.result.casePrice} vs ${sheetCase} | margin ${c.result.margin?.toFixed(4)} vs ${sheetMargin.toFixed(4)} | kept=${c.result.casePriceKept}`);
    }
    console.log("PRICE CHECK rows with a client price:", priced, "| differ:", off.length);
    off.slice(0, 12).forEach((o) => console.log("  PDIFF", o));
  });

  it("flags the products whose barcode the client also noted as wrong in Shopify", async () => {
    const { sheet, view } = shared!;
    const { barcodeWarning } = await import("./lines");
    const clientNoted = sheet.rows.filter((r) => /EAN i Shopify/i.test(r.note)).map((r) => r.idx);
    const ourFlags = new Set(view.lines.filter((l) => barcodeWarning(l)).map((l) => l.idx));
    const bothFound = clientNoted.filter((i) => ourFlags.has(i));
    console.log("BARCODES: client noted", clientNoted.length, "| we flagged", ourFlags.size, "| in both:", bothFound.length, "| client noted but we did not flag:", clientNoted.filter((i) => !ourFlags.has(i)).slice(0, 12).join(","));
    expect(bothFound.length).toBeGreaterThan(0);
  });
});
