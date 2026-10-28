/**
 * ENGINE SIGN-OFF, third shipment and first one in EUR: Leis 2026-96107 / 96573 / 96851.
 *
 * The real Leis spec file (German column names) is read through the Leis profile, and our pricing is compared
 * with the client's final price sheet row by row: EUR rate 11, freight 3 800 NOK, markup 30 %, the client's
 * estimated duty per kg (a blank duty counts as 0 in that sheet), VAT 15 % on every row.
 * Client files: skipped where absent.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { calculate } from "./lines";
import { MemoryDb, seedDefaults } from "./db";
import { createShipment, getShipmentView, importInvoice, patchLine, patchShipment, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

const ROOT = path.resolve(__dirname, "../../../fwter");
const DIR = path.join(ROOT, "package/A_Data_and_rules/9_source_files/Leis_2026-96107_96573_96851");
const SHEET = path.join(DIR, "Leis_price_sheet_final.xlsx");
const SPEC = path.join(DIR, "Leis_spec_2026-96851_96573_96107.xlsx");
const SNAP = path.join(ROOT, "shopify-snapshot-all.json");
const have = existsSync(SHEET) && existsSync(SPEC) && existsSync(SNAP);

const num = (v: unknown) => (v === "" || v === undefined || v === null ? 0 : Number(v));
const ceilHalf = (x: number) => Math.ceil(x * 2 - 1e-9) / 2;

function readSheet() {
  const wb = XLSX.read(readFileSync(SHEET), { type: "buffer" });
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
  const head = grid.findIndex((r) => String(r[0]).trim() === "Art.nr");
  const col = (name: string) => (grid[head] as string[]).indexOf(name);
  const c = { idx: col("Art.nr"), unit: col("Enhet"), qty: col("Antall"), value: col("Fakturaverdi EUR"), weight: col("Nettovekt kg"), duty: col("Toll kr/kg"), pack: col("Emballasje/stk") };
  const top = (label: string) => grid.find((r) => String(r[0]).trim() === label)?.[2];
  const rows = grid
    .slice(head + 1)
    .filter((r) => String(r[c.idx]).trim() && typeof r[c.qty] === "number" && (r[c.qty] as number) > 0)
    .map((r) => ({ idx: String(r[c.idx]).trim(), unit: String(r[c.unit]), qty: num(r[c.qty]), value: num(r[c.value]), weight: num(r[c.weight]), duty: num(r[c.duty]), pack: num(r[c.pack]) }));
  return { rate: num(top("Kurs EUR→NOK")), freightNok: num(top("Frakt totalt NOK")), markup: num(top("Påslag (gulv)")), rows };
}

describe.skipIf(!have)("engine sign-off: Leis 2026-96107/96573/96851 (EUR) against the client's final sheet", () => {
  it("reads the real Leis spec through the Leis profile and matches the sheet's cost on every row", async () => {
    const sheet = readSheet();
    const totalWeight = sheet.rows.reduce((a, r) => a + r.weight, 0);

    const fake = FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAP, "utf8")), { draftEvery: 0 });
    const db = new MemoryDb();
    seedDefaults(db);
    const ctx: Ctx = { db, shopify: fake, who: "t", log: async () => {}, now: () => new Date("2026-09-26T12:00:00Z") };
    const s = await createShipment(ctx, { name: "Leis", supplierName: "Leis", arrivalDate: "2026-09-26" });
    await patchShipment(ctx, s.id, { rates: { EUR: sheet.rate }, freight_amount: sheet.freightNok, freight_currency: "NOK", markup_value: sheet.markup });
    const imported = await importInvoice(ctx, s.id, { spec: { bytes: new Uint8Array(readFileSync(SPEC)), name: "Leis_spec_2026-96851_96573_96107.xlsx" } });
    console.log("LEIS import:", imported.rawLines, "lines ->", imported.products, "products | matched", imported.matched, "doubtful", imported.doubtful, "unmatched", imported.unmatched);

    const byIdx = new Map(sheet.rows.map((r) => [r.idx, r]));
    for (const l of (await getShipmentView(ctx, s.id)).lines) {
      const row = byIdx.get(l.idx);
      if (!row) continue;
      const patch: Record<string, unknown> = { duty_per_kg: row.weight > 0 ? row.duty / row.weight : 0 };
      if (l.unit === "kilo") patch.sales_unit_kg = 1;
      // The sheet's duty cell is kr per kg; patchLine takes kr per kg too
      patch.duty_per_kg = row.duty;
      await patchLine(ctx, l.id, patch);
    }
    const view = await getShipmentView(ctx, s.id);
    const calc = calculate(view.shipment, view.lines);

    const diffs: string[] = [];
    const missing: string[] = [];
    let compared = 0;
    for (const row of sheet.rows) {
      const c = calc.rows.find((x) => x.line.idx === row.idx);
      if (!c) {
        missing.push(row.idx);
        continue;
      }
      const r = c.result;
      const goods = (row.value / row.qty) * sheet.rate;
      const duty = r.isDrink ? 0 : (row.duty * row.weight) / row.qty;
      const freight = totalWeight > 0 ? ((sheet.freightNok / totalWeight) * row.weight) / row.qty : 0;
      const cost = (goods + duty + row.pack + freight) * 1.15;
      const suggested = ceilHalf(cost * (1 + sheet.markup));
      compared++;
      const costOk = r.costInclVat !== null && Math.abs(r.costInclVat - cost) < 0.01;
      const sugOk = r.suggestedPrice !== null && Math.abs(r.suggestedPrice - suggested) < 0.01;
      if (!costOk || !sugOk) diffs.push(`${row.idx} ${row.unit} qty ${row.qty}: cost ${r.costInclVat?.toFixed(3)} vs ${cost.toFixed(3)} | suggested ${r.suggestedPrice} vs ${suggested} | goods ${r.goodsNok.toFixed(3)}/${goods.toFixed(3)} duty ${r.dutyNok?.toFixed(3)}/${duty.toFixed(3)} pack ${r.packagingNok}/${row.pack} freight ${r.freightNok.toFixed(3)}/${freight.toFixed(3)} vat ${r.vatRate}`);
    }
    console.log("LEIS compared:", compared, "of", sheet.rows.length, "| missing in app:", missing.length, missing.slice(0, 6).join(","), "| differ:", diffs.length);
    diffs.slice(0, 12).forEach((d) => console.log("  DIFF", d));
    expect(imported).toMatchObject({ rawLines: 270, products: 269, unmatched: 0 });
    expect(missing).toEqual([]);
    expect(compared).toBe(269);
    expect(diffs, diffs.join(String.fromCharCode(10))).toEqual([]);
  }, 300_000);
});
