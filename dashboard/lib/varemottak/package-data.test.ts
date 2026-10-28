/**
 * The client's data package (fwter/package/A_Data_and_rules): the customs rates and the purchase history,
 * loaded through the real importers into the real register, and looked up the way a new invoice would.
 * Client files: skipped where absent.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importHistory, importKgProducts, importRates } from "./bulk-import";
import { lookupDuty, type CustomsRate } from "./customs";
import { listRates } from "./customs-service";
import { MemoryDb, seedDefaults } from "./db";
import { calculate } from "./lines";
import { createShipment, getShipmentView, importInvoice, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

const ROOT = path.resolve(__dirname, "../../../fwter");
const PKG = path.join(ROOT, "package/A_Data_and_rules");
const RATES = path.join(PKG, "1_customs_rates.csv");
const HISTORY = path.join(PKG, "2_purchase_price_history.csv");
const KG = path.join(PKG, "5_products_sold_by_kg.csv");
const STANRO_SPEC = path.join(ROOT, "000033_S33_2026_spec.csv");
const SNAP = path.join(ROOT, "shopify-snapshot-all.json");
const have = existsSync(RATES) && existsSync(HISTORY);

const make = (shopify = new FakeShopify([], {})): Ctx => {
  const db = new MemoryDb();
  seedDefaults(db);
  return { db, shopify, who: "t", log: async () => {}, now: () => new Date("2026-10-27T12:00:00Z") };
};
const file = (p: string) => ({ bytes: new Uint8Array(readFileSync(p)), name: path.basename(p) });

/** A semicolon file with a BOM, as the client's CSVs are. */
function readCsv(p: string): Array<Record<string, string>> {
  const lines = readFileSync(p, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(";");
  return lines.slice(1).map((l) => Object.fromEntries(l.split(";").map((v, i) => [head[i], v])));
}

describe.skipIf(!have)("customs rates file (1 282 rows)", () => {
  it("loads every row it can, and says exactly what it left out and why", async () => {
    const ctx = make();
    const r = await importRates(ctx, file(RATES));
    expect(r.rows).toBe(1282);
    expect(r.added).toBe(1277);
    expect(r.skipped).toHaveLength(5);
    // four estimates whose supplier the file does not know, and one cell holding two rates
    expect(r.skipped.filter((s) => s.reason.startsWith("Leverandør mangler"))).toHaveLength(4);
    expect(r.skipped.filter((s) => s.reason.startsWith("To satser"))).toHaveLength(1);
    expect(r.undated).toBe(35);

    const all = await listRates(ctx);
    expect(all.filter((x) => x.scope === "cn8")).toHaveLength(198);
    expect(all.filter((x) => x.scope === "product")).toHaveLength(1079);
    // "estimate" in the Kilde column means an estimate, everything else names a declaration
    expect(all.filter((x) => x.source_kind === "estimate")).toHaveLength(147);
    expect(all.every((x) => x.source_kind === "estimate" || /declaration/i.test(x.source_ref))).toBe(true);
  }, 120_000);

  it("loading the same file again changes nothing", async () => {
    const ctx = make();
    await importRates(ctx, file(RATES));
    const before = (await listRates(ctx)).length;
    const again = await importRates(ctx, file(RATES));
    expect(again).toMatchObject({ added: 0, replaced: 1277 });
    expect((await listRates(ctx)).length).toBe(before);
  }, 120_000);

  it("looks rates up in the client's order, and never guesses on an ambiguous code", async () => {
    const ctx = make();
    await importRates(ctx, file(RATES));
    const rates = (await listRates(ctx)) as unknown as CustomsRate[];
    const csv = readCsv(RATES);

    // 1. the same product in a declaration: Maspo's Saltowski Likarska (sold per kg), 84.31 kr/kg on declaration 89492
    const likarska = lookupDuty({ supplier: "Maspo", idx: "53020", hs: "16010000" }, rates);
    expect(likarska).toMatchObject({ kind: "declaration" });
    expect(likarska!.dutyPerKg).toBeGreaterThan(80);

    // 2. a sausage code the register has seen at two different rates (84.31, and 0 by tariff quota) is ambiguous:
    //    a product with no rate of its own stays EMPTY, never 0 and never 84.31
    expect(lookupDuty({ supplier: "Maspo", idx: "no-such-product", hs: "16010000" }, rates)).toBeNull();

    // 3. a code declared at one rate only is applied, and says it came from the CN8 register
    const byCn8 = new Map<string, Set<string>>();
    for (const r of csv.filter((x) => !x["Art.nr"] && x["CN8"] && /declaration/i.test(x["Kilde"]) && /^[0-9.]+$/.test(x["Toll kr/kg"]))) {
      byCn8.set(r["CN8"], (byCn8.get(r["CN8"]) ?? new Set()).add(Number(r["Toll kr/kg"]).toFixed(4)));
    }
    const single = [...byCn8].find(([cn8, set]) => set.size === 1 && !csv.some((x) => x["Art.nr"] && x["Supplier"] === "Maspo" && x["Art.nr"] === "no-such-product" && x["CN8"] === cn8));
    expect(single).toBeTruthy();
    const viaCn8 = lookupDuty({ supplier: "Maspo", idx: "no-such-product", hs: single![0] }, rates);
    expect(viaCn8).toMatchObject({ kind: "cn8" });
    expect(viaCn8!.dutyPerKg).toBeCloseTo(Number([...single![1]][0]), 4);

    // 4. a product with only a typed estimate: United Gross 4567, duty 0 typed by the client
    expect(lookupDuty({ supplier: "United Gross", idx: "4567", hs: null }, rates)).toMatchObject({ kind: "estimate", dutyPerKg: 0 });
  }, 120_000);
});

describe.skipIf(!have)("purchase history file (1 684 lines)", () => {
  it("loads every line, and says how many had no date", async () => {
    const ctx = make();
    const r = await importHistory(ctx, file(HISTORY));
    expect(r.rows).toBe(1684);
    expect(r.skipped).toEqual([]);
    expect(r.added + r.duplicates).toBe(1684);
    expect(r.undated).toBe(624); // Stanro 000029 and 000033, and SWF 2026-11420
    const rows = await ctx.db.select<{ supplier: string }>("vm_price_history", {});
    expect(new Set(rows.map((x) => x.supplier))).toEqual(new Set(["Stanro", "Maspo", "Leis", "SWF Global", "United Gross"]));
  }, 120_000);

  it.skipIf(!existsSync(STANRO_SPEC) || !existsSync(SNAP))("a Stanro invoice compares with the earlier purchase, never with its own line in the history", async () => {
    // The history file already holds invoice 000033 itself. Importing 000033 must compare with 000029 (the earlier
    // purchase), not with itself (which would show every price as unchanged).
    const rows = readCsv(HISTORY).filter((x) => x["Supplier"] === "Stanro");
    const price = (inv: string) => new Map(rows.filter((x) => x["Invoice"] === inv).map((x) => [x["Art.nr"], Number(x["Price"])]));
    const p29 = price("000029/S33/2026");
    const p33 = price("000033/S33/2026");
    const differing = [...p33].filter(([idx, v]) => p29.has(idx) && Math.abs(p29.get(idx)! - v) > 0.001);
    expect(differing.length).toBeGreaterThan(0);

    const fake = FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAP, "utf8")), { draftEvery: 0 });
    const ctx = make(fake);
    await importHistory(ctx, file(HISTORY));
    const s = await createShipment(ctx, { name: "S", supplierName: "Stanro", arrivalDate: "2026-10-27" });
    await importInvoice(ctx, s.id, { spec: file(STANRO_SPEC) });
    const view = await getShipmentView(ctx, s.id);
    const [idx] = differing[0];
    const line = view.lines.find((l) => l.idx === idx)!;
    expect(line.history?.change.previousUnitPrice).toBeCloseTo(p29.get(idx)!, 4); // 000029's price, not 000033's own
    expect(line.history?.previous?.invoice_no).toBe("000029/S33/2026");
    // the price-increase alert runs on the same lines (placeholder costs ignored); with the real history it finds some
    const alerted = calculate(view.shipment, view.lines).rows.filter((r) => r.warnings.some((w) => w.startsWith("Prisvarsel")));
    console.log("ALERTS on Stanro 000033:", alerted.length, alerted.slice(0, 4).map((r) => `${r.line.idx}: ${r.warnings.filter((w) => w.startsWith("Prisvarsel")).join(" / ")}`));
    expect(view.lines.some((l) => l.history?.change.direction === "up" || l.history?.change.direction === "down")).toBe(true);
  }, 180_000);
});

describe.skipIf(!existsSync(KG) || !existsSync(SNAP))("products sold by kg (40 rows)", () => {
  it("saves the selling unit per Shopify product: per kg is 1, the Halwa box exception is 1.5, and open kg rows get it", async () => {
    const ctx = make(FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAP, "utf8")), { draftEvery: 0 }));
    const s = await createShipment(ctx, { name: "Stanro", supplierName: "Stanro", arrivalDate: "2026-10-27" });
    await importInvoice(ctx, s.id, { spec: file(STANRO_SPEC) });
    const kgBefore = (await getShipmentView(ctx, s.id)).lines.filter((l) => l.unit === "kilo" && !l.sales_unit_kg);
    expect(kgBefore.length).toBeGreaterThan(0);

    const r = await importKgProducts(ctx, file(KG));
    console.log("KG import:", JSON.stringify({ rows: r.rows, applied: r.applied, filled: r.filledKgLines, skipped: r.skipped.length }), r.skipped.slice(0, 12));
    expect(r.rows).toBe(40);
    expect(r.applied).toBeGreaterThan(20);

    const settings = await ctx.db.select<{ shopify_product_id: string; sales_unit_kg: number }>("vm_product_settings", {});
    const kg = (idx: string) => ctx.shopify.productsByTags([idx]).then((p) => settings.find((x) => x.shopify_product_id === p[0]?.id)?.sales_unit_kg);
    expect(await kg("113934")).toBe(1.5); // Halwa: price per BOX
    expect(await kg("53020")).toBe(1); // sold per kg
    expect(await kg("115064")).toBe(1); // fixed box priced per kg: the unit stays 1 kg, the case price is price × 3

    // the Stanro kg rows that were waiting for a selling unit have it now
    const kgAfter = (await getShipmentView(ctx, s.id)).lines.filter((l) => l.unit === "kilo" && !l.sales_unit_kg);
    expect(r.filledKgLines).toBe(kgBefore.length - kgAfter.length);
    expect(kgAfter.length).toBeLessThan(kgBefore.length);
    // and the same file again changes nothing more
    const again = await importKgProducts(ctx, file(KG));
    expect(again.filledKgLines).toBe(0);
  }, 180_000);
});
