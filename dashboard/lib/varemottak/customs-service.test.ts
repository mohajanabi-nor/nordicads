import { describe, expect, it } from "vitest";
import { applyDeclaration, addRate, deleteRate, listRates } from "./customs-service";
import { MemoryDb, seedDefaults } from "./db";
import { lookupDuty } from "./customs";
import { createShipment, patchShipment, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

function ctx(): Ctx {
  const db = new MemoryDb();
  seedDefaults(db);
  return { db, shopify: new FakeShopify(), who: "t@x.no", log: async () => {}, now: () => new Date("2026-10-09T10:00:00Z") };
}

async function shipmentWithLine(c: Ctx, o: Record<string, unknown> = {}) {
  const s = await createShipment(c, { name: "S", supplierName: "Stanro" });
  await patchShipment(c, s.id, { rates: { PLN: 2.5 }, freight_amount: 0 });
  const [line] = await c.db.insert<{ id: string }>("vm_lines", {
    shipment_id: s.id,
    position: 0,
    currency: "PLN",
    idx: "A1",
    name: "Biscuits",
    unit: "pcs",
    qty: 100,
    hs: "19053191",
    net_weight_kg: 50,
    line_value: 400,
    pcs_per_carton: 10,
    duty_per_kg: 2,
    duty_source_kind: "estimate",
    duty_source: "typed by us, estimate",
    match_status: "matched",
    shopify_product_id: "1",
    shopify: { status: "DRAFT", productType: "125", variantCount: 1 },
    ...o,
  });
  return { s, line };
}

describe("the register", () => {
  it("adds a typed estimate as a product rate with its source", async () => {
    const c = ctx();
    const r = await addRate(c, { scope: "product", supplier: "Stanro", idx: "A1", dutyPerKg: 2.5, kind: "estimate" });
    expect(r).toMatchObject({ scope: "product", source_ref: "typed by us, estimate", source_kind: "estimate", source_date: "2026-10-09" });
  });
  it("only accepts a CN8 rate from a declaration", async () => {
    await expect(addRate(ctx(), { scope: "cn8", cn8: "19053191", dutyPerKg: 3, kind: "estimate" })).rejects.toThrow(/deklarasjon/);
    await expect(addRate(ctx(), { scope: "cn8", cn8: "1905", dutyPerKg: 3, kind: "declaration" })).rejects.toThrow(/8 siffer/);
  });
  it("deletes a rate", async () => {
    const c = ctx();
    const r = await addRate(c, { scope: "product", supplier: "S", idx: "X", dutyPerKg: 1, kind: "estimate" });
    await deleteRate(c, r.id);
    expect(await listRates(c)).toHaveLength(0);
  });
});

describe("applyDeclaration", () => {
  it("records verified rates, which then win the lookup over an estimate", async () => {
    const c = ctx();
    await addRate(c, { scope: "product", supplier: "Stanro", idx: "A1", dutyPerKg: 2, kind: "estimate" });
    await applyDeclaration(c, { number: "25NO100", date: "2026-10-01", items: [{ cn8: "19053191", dutyNok: 300, netWeightKg: 100 }] });
    const rates = await listRates(c);
    const hit = lookupDuty({ supplier: "Stanro", idx: "A1", hs: "19053191" }, rates);
    expect(hit).toMatchObject({ dutyPerKg: 3, kind: "cn8" });
    expect(hit!.source).toContain("25NO100");
  });

  it("pools items with the same CN8 (total duty ÷ total weight)", async () => {
    const c = ctx();
    const out = await applyDeclaration(c, {
      number: "25NO101",
      items: [
        { cn8: "19053191", dutyNok: 100, netWeightKg: 50 }, // 2/kg
        { cn8: "19053191", dutyNok: 400, netWeightKg: 50 }, // 8/kg → pooled 5/kg
      ],
    });
    expect(out.rates).toEqual([{ cn8: "19053191", dutyPerKg: 5 }]);
  });

  it("recalculates affected products and reports how cost and margin moved", async () => {
    const c = ctx();
    const { s, line } = await shipmentWithLine(c);
    const out = await applyDeclaration(c, { number: "25NO102", items: [{ cn8: "19053191", dutyNok: 300, netWeightKg: 100 }] }); // 3/kg, was 2/kg estimate
    expect(out.changes).toHaveLength(1);
    const ch = out.changes[0];
    expect(ch).toMatchObject({ shipmentId: s.id, lineId: line.id, idx: "A1", dutyBefore: 2, dutyAfter: 3, pushed: false });
    // duty per unit: 50 kg / 100 pcs = 0.5 kg each → +0.5 NOK duty per kg difference of 1 → +0.5 landed → ×1.15
    expect(ch.costAfter! - ch.costBefore!).toBeCloseTo(0.5 * 1.15, 6);
    const row = (await c.db.select<{ duty_per_kg: number; duty_source_kind: string; duty_source: string }>("vm_lines", { id: `eq.${line.id}` }))[0];
    expect(row).toMatchObject({ duty_per_kg: 3, duty_source_kind: "declaration", duty_source: "Deklarasjon 25NO102" });
  });

  it("fills rows that had no duty at all", async () => {
    const c = ctx();
    await shipmentWithLine(c, { duty_per_kg: null, duty_source_kind: null, duty_source: null });
    const out = await applyDeclaration(c, { number: "25NO103", items: [{ cn8: "19053191", dutyNok: 200, netWeightKg: 100 }] });
    expect(out.changes[0]).toMatchObject({ dutyBefore: null, costBefore: null, dutyAfter: 2 });
    expect(out.changes[0].costAfter).not.toBeNull();
  });

  it("flags rows that were already sent, since their cost in Shopify is now stale", async () => {
    const c = ctx();
    await shipmentWithLine(c, { pushed_at: "2026-10-05T10:00:00Z" });
    const out = await applyDeclaration(c, { number: "25NO104", items: [{ cn8: "19053191", dutyNok: 300, netWeightKg: 100 }] });
    expect(out.changes[0].pushed).toBe(true);
  });

  it("leaves products with other tariff numbers alone", async () => {
    const c = ctx();
    await shipmentWithLine(c, { hs: "21041000" });
    expect((await applyDeclaration(c, { number: "25NO105", items: [{ cn8: "19053191", dutyNok: 300, netWeightKg: 100 }] })).changes).toHaveLength(0);
  });

  it("does nothing to a row already on that declaration's rate", async () => {
    const c = ctx();
    await shipmentWithLine(c, { duty_per_kg: 3, duty_source_kind: "declaration", duty_source: "Deklarasjon old" });
    expect((await applyDeclaration(c, { number: "25NO106", items: [{ cn8: "19053191", dutyNok: 300, netWeightKg: 100 }] })).changes).toHaveLength(0);
  });

  it("skips an item without weight instead of dividing by zero", async () => {
    const c = ctx();
    const out = await applyDeclaration(c, { number: "25NO107", items: [{ cn8: "19053191", dutyNok: 300, netWeightKg: 0 }, { cn8: "21041000", dutyNok: 50, netWeightKg: 10 }] });
    expect(out.skipped).toEqual(["19053191"]);
    expect(out.rates).toEqual([{ cn8: "21041000", dutyPerKg: 5 }]);
  });

  it("refuses the same declaration twice, and bad input", async () => {
    const c = ctx();
    const items = [{ cn8: "19053191", dutyNok: 300, netWeightKg: 100 }];
    await applyDeclaration(c, { number: "25NO108", items });
    await expect(applyDeclaration(c, { number: "25NO108", items })).rejects.toThrow(/allerede/);
    await expect(applyDeclaration(c, { number: "", items })).rejects.toThrow(/nummer/);
    await expect(applyDeclaration(c, { number: "X", items: [] })).rejects.toThrow(/ingen/);
    await expect(applyDeclaration(c, { number: "Y", items: [{ cn8: "123", dutyNok: 1, netWeightKg: 1 }] })).rejects.toThrow(/CN8/);
  });
});
