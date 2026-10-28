/**
 * ENGINE SIGN-OFF, second shipment: Stanro 000033/S33/2026 against the client's final price sheet
 * (package: 9_source_files/Stanro_000033/Stanro_000033_price_sheet_final.xlsx).
 *
 * The sheet's formulas:   goods = price × PLN rate     duty/unit = duty total ÷ qty (declared, "fasit")
 *   freight/unit = EUR freight × EUR rate ÷ total net weight × line weight ÷ qty
 *   landed = goods + duty + packaging + freight          cost incl. VAT = landed × (1 + VAT of that line)
 *   suggested = CEILING(cost × 1.30, 0.5)                margin = (our price − cost) ÷ our price
 * The VAT is per line in the sheet (15 % food, 25 % toys, cosmetics, lighters …).
 * Client files: skipped where absent.
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

const ROOT = path.resolve(__dirname, "../../../fwter");
const SHEET = path.join(ROOT, "package/A_Data_and_rules/9_source_files/Stanro_000033/Stanro_000033_price_sheet_final.xlsx");
const SPEC = path.join(ROOT, "000033_S33_2026_spec.csv");
const SNAP = path.join(ROOT, "shopify-snapshot-all.json");
const have = existsSync(SHEET) && existsSync(SPEC) && existsSync(SNAP);

const num = (v: unknown) => (v === "" || v === undefined || v === null ? 0 : Number(v));
const ceilHalf = (x: number) => Math.ceil(x * 2 - 1e-9) / 2;

function readSheet() {
  const wb = XLSX.read(readFileSync(SHEET), { type: "buffer" });
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
  const head = grid.findIndex((r) => String(r[0]).trim() === "Art.nr");
  const col = (name: string) => (grid[head] as string[]).indexOf(name);
  const c = { idx: col("Art.nr"), unit: col("Enhet"), qty: col("Antall"), pcs: col("Stk/kart"), value: col("Fakturaverdi PLN"), duty: col("Toll totalt NOK (fasit)"), pack: col("Emballasje/stk"), vat: col("MVA"), weight: col("Nettovekt kg"), your: col("DIN PRIS") };
  const top = (label: string) => grid.find((r) => String(r[0]).trim() === label)?.[1];
  const rows = grid.slice(head + 1).filter((r) => String(r[c.idx]).trim() && qtyOk(r[c.qty])).map((r) => ({
    idx: String(r[c.idx]).trim(),
    unit: String(r[c.unit]),
    qty: num(r[c.qty]),
    pcs: num(r[c.pcs]),
    value: num(r[c.value]),
    duty: num(r[c.duty]),
    pack: num(r[c.pack]),
    vat: num(r[c.vat]),
    weight: num(r[c.weight]),
    your: r[c.your] === "" ? null : num(r[c.your]),
  }));
  return { rate: num(top("Kurs PLN→NOK")), freightEur: num(top("Frakt totalt EUR")), eurRate: num(top("Kurs EUR→NOK")), markup: num(top("Påslag (gulv)")), rows };
}
const qtyOk = (v: unknown) => typeof v === "number" && v > 0;

describe.skipIf(!have)("engine sign-off: Stanro 000033/S33/2026 against the client's final sheet", () => {
  it("gives the same cost and suggested price on every row, with the sheet's duty and VAT", async () => {
    const sheet = readSheet();
    const totalWeight = sheet.rows.reduce((a, r) => a + r.weight, 0);
    const freightNok = sheet.freightEur * sheet.eurRate;

    const fake = FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAP, "utf8")), { draftEvery: 0 });
    const db = new MemoryDb();
    seedDefaults(db);
    const ctx: Ctx = { db, shopify: fake, who: "t", log: async () => {}, now: () => new Date("2026-10-09T12:00:00Z") };
    const s = await createShipment(ctx, { name: "Stanro", supplierName: "Stanro", arrivalDate: "2026-09-25" });
    await patchShipment(ctx, s.id, { rates: { PLN: sheet.rate, EUR: sheet.eurRate }, freight_amount: sheet.freightEur, freight_currency: "EUR", markup_value: sheet.markup });
    await importInvoice(ctx, s.id, { spec: { bytes: new Uint8Array(readFileSync(SPEC)), name: "000033_S33_2026_spec.csv" } });

    const byIdx = new Map(sheet.rows.map((r) => [r.idx, r]));
    const vatByHand: string[] = [];
    for (const l of (await getShipmentView(ctx, s.id)).lines) {
      const row = byIdx.get(l.idx);
      if (!row) continue;
      const patch: Record<string, unknown> = { duty_per_kg: row.weight > 0 ? row.duty / row.weight : 0 };
      // The client sets VAT per line. Where the automatic rule (mva-25 tag, then the customs code) is not what the
      // client chose, set it by hand, as the operator would in the VAT column.
      const auto = l.mva25 || isNonFoodVatHs(l.hs) ? 0.25 : 0.15;
      if (Math.abs(auto - row.vat) > 0.001) {
        patch.vat_rate = row.vat;
        vatByHand.push(l.idx);
      }
      if (l.unit === "kilo") patch.sales_unit_kg = 1;
      await patchLine(ctx, l.id, patch);
    }
    const view = await getShipmentView(ctx, s.id);
    const calc = calculate(view.shipment, view.lines);

    const diffs: string[] = [];
    const vatOnly: string[] = [];
    let compared = 0;
    for (const row of sheet.rows) {
      const c = calc.rows.find((x) => x.line.idx === row.idx);
      if (!c) {
        diffs.push(`${row.idx}: not in the app`);
        continue;
      }
      const r = c.result;
      const goods = (row.value / row.qty) * sheet.rate;
      const duty = row.duty / row.qty;
      const freight = totalWeight > 0 ? ((freightNok / totalWeight) * row.weight) / row.qty : 0;
      const isDrink = r.isDrink;
      const landedSheet = goods + (isDrink ? 0 : duty) + row.pack + freight;
      const cost = landedSheet * (1 + row.vat);
      const suggested = ceilHalf(cost * (1 + sheet.markup));
      compared++;
      const costOk = r.costInclVat !== null && Math.abs(r.costInclVat - cost) < 0.01;
      const sugOk = r.suggestedPrice !== null && Math.abs(r.suggestedPrice - suggested) < 0.01;
      if (!costOk || !sugOk) {
        // is the whole difference explained by the VAT rate alone?
        const ours = r.landedCost === null ? NaN : r.landedCost;
        const explainedByVat = Math.abs(ours - landedSheet) < 0.01 && Math.abs(r.vatRate - row.vat) > 0.001;
        (explainedByVat ? vatOnly : diffs).push(`${row.idx} ${row.unit} hs ${c.line.hs} | landed ours ${ours.toFixed(3)} vs ${landedSheet.toFixed(3)} (goods ${r.goodsNok.toFixed(3)}/${goods.toFixed(3)} duty ${r.dutyNok?.toFixed(3)}/${(isDrink ? 0 : duty).toFixed(3)} pack ${r.packagingNok}/${row.pack} freight ${r.freightNok.toFixed(3)}/${freight.toFixed(3)}) | VAT ours ${r.vatRate} vs ${row.vat}`);
      }
    }
    console.log("STANRO compared:", compared, "| rows with a different cost for reasons other than VAT:", diffs.length, "| rows that differ only by VAT rate:", vatOnly.length);
    diffs.slice(0, 15).forEach((d) => console.log("  DIFF", d));
    vatOnly.slice(0, 12).forEach((d) => console.log("  VAT ", d));
    expect(compared).toBe(238);
    expect(diffs).toEqual([]);
    expect(vatOnly).toEqual([]);
    // Only five lines need a hand-set VAT: two lighters (9613) and a household plastic item (3924) that the client
    // sets to 25 %, and two Johny Bee sweets under the toy code 9503 that stay at 15 %. All other 233 follow the rule.
    expect(vatByHand.sort()).toEqual(["11022100MDA", "11412100MDA", "87938000KTA", "87939000KTA", "88560000SRS"]);
  }, 300_000);
});
