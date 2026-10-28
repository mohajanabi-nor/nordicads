import { describe, expect, it } from "vitest";
import { MemoryDb, seedDefaults } from "./db";
import { archiveCategory, gpOverview, setProductGp, upsertCategory } from "./gp-service";
import type { Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

function ctx(): Ctx {
  const db = new MemoryDb();
  seedDefaults(db);
  return { db, shopify: new FakeShopify(), who: "t", log: async () => {}, now: () => new Date("2026-10-09T00:00:00Z") };
}

async function seedShipment(c: Ctx, id: string, arrival: string | null, lines: Array<Record<string, unknown>>) {
  await c.db.insert("vm_shipments", { id, name: id, supplier_name: "Stanro", arrival_date: arrival, status: "review" });
  await c.db.insert(
    "vm_lines",
    lines.map((l, i) => ({
      shipment_id: id,
      position: i,
      currency: "PLN",
      unit: "pcs",
      hs: "22021000",
      shopify: { title: String(l.name) },
      ...l,
    })),
  );
}

describe("gpOverview", () => {
  it("counts beverage units in the term, by the shipment's arrival date", async () => {
    const c = ctx();
    await seedShipment(c, "s1", "2026-05-10", [
      { idx: "A", name: "Energy Monster cans 0.5l", qty: 360, shopify_product_id: "p1" },
      { idx: "B", name: "Kinder bar", qty: 999, hs: "18069019", shopify_product_id: "p9" }, // not a beverage
    ]);
    await seedShipment(c, "s2", "2026-07-02", [{ idx: "A", name: "Energy Monster cans 0.5l", qty: 5000, shopify_product_id: "p1" }]); // next term
    await seedShipment(c, "s3", "2026-03-10", [{ idx: "A", name: "Energy Monster cans 0.5l", qty: 200, shopify_product_id: "p1" }]); // previous term
    await setProductGp(c, "p1", { gpCode: "5020", gpPackagingKg: null });

    const o = await gpOverview(c, "2026-RT3");
    const line = o.report.lines.find((l) => l.code === "5020")!;
    expect(line.quantity).toBe(360);
    expect(line.sum).toBeCloseTo(64.8, 6); // × 0,18
    expect(line.previousPeriod).toBe(200);
    expect(o.unassigned).toBe(0);
  });

  it("reports plastic bottles in kg using the packaging weight", async () => {
    const c = ctx();
    await seedShipment(c, "s1", "2026-06-01", [{ idx: "C", name: "Coca-Cola pet 0.5l", qty: 2592, shopify_product_id: "p2" }]);
    await setProductGp(c, "p2", { gpCode: "1017", gpPackagingKg: 0.025 });
    const o = await gpOverview(c, "2026-RT3");
    expect(o.report.lines.find((l) => l.code === "1017")).toMatchObject({ quantity: 64.8, sum: 388.8 });
  });

  it("flags beverages without a code — in the term's problems, never silently dropped", async () => {
    const c = ctx();
    await seedShipment(c, "s1", "2026-06-01", [{ idx: "D", name: "Energy drink can 0,25l Red Bull", qty: 100, shopify_product_id: "p3" }]);
    const o = await gpOverview(c, "2026-RT3");
    expect(o.unassigned).toBe(1);
    expect(o.report.problems[0]).toContain("mangler Grønt Punkt-kode");
    expect(o.products[0].suggestion.code).toBeNull(); // 0,25 l aluminium has no code
    expect(o.products[0].suggestion.reason).toContain("ingen kode");
  });

  it("leaves out shipments with no arrival date and says so", async () => {
    const c = ctx();
    await seedShipment(c, "s1", null, [{ idx: "E", name: "x pet 0.5l", qty: 10, shopify_product_id: "p4" }]);
    const o = await gpOverview(c, "2026-RT3");
    expect(o.undated).toEqual(["s1"]);
    expect(o.report.problems.join()).toContain("uten ankomstdato");
  });

  it("rejects a bad period", async () => {
    await expect(gpOverview(ctx(), "2026-Q3")).rejects.toThrow(/Ugyldig periode/);
  });
});

describe("setProductGp", () => {
  it("requires a packaging weight for a kg category", async () => {
    await expect(setProductGp(ctx(), "p", { gpCode: "1017", gpPackagingKg: null })).rejects.toThrow(/emballasjevekt/);
  });
  it("rejects an unknown category", async () => {
    await expect(setProductGp(ctx(), "p", { gpCode: "9999", gpPackagingKg: null })).rejects.toThrow(/finnes ikke/);
  });
  it("rejects an absurd weight (grams typed as kg)", async () => {
    await expect(setProductGp(ctx(), "p", { gpCode: "1017", gpPackagingKg: 25 })).rejects.toThrow(/under 5 kg/);
  });
});

describe("categories are editable without a code change", () => {
  it("adds a new category with its rate, and it shows in the report", async () => {
    const c = ctx();
    await upsertCategory(c, { code: "5010", name: "Aluminium drikkevare 0-250 ml", unit: "pcs", rate: 0.2, validFrom: "2026-01-01" });
    await seedShipment(c, "s1", "2026-06-01", [{ idx: "D", name: "Red Bull can 0,25l", qty: 1000, shopify_product_id: "p3" }]);
    await setProductGp(c, "p3", { gpCode: "5010", gpPackagingKg: null });
    const o = await gpOverview(c, "2026-RT3");
    expect(o.report.lines.find((l) => l.code === "5010")).toMatchObject({ quantity: 1000, rate: 0.2, sum: 200 });
  });

  it("a rate change applies from its date, not backwards", async () => {
    const c = ctx();
    await upsertCategory(c, { code: "5020", name: "Aluminium drikkevare 251-500 ml", unit: "pcs", rate: 0.25, validFrom: "2026-07-01" });
    await seedShipment(c, "s1", "2026-06-01", [{ idx: "A", name: "x can 0.5l", qty: 100, shopify_product_id: "p1" }]);
    await seedShipment(c, "s2", "2026-08-01", [{ idx: "A", name: "x can 0.5l", qty: 100, shopify_product_id: "p1" }]);
    await setProductGp(c, "p1", { gpCode: "5020", gpPackagingKg: null });
    expect((await gpOverview(c, "2026-RT3")).report.lines.find((l) => l.code === "5020")!.rate).toBe(0.18);
    expect((await gpOverview(c, "2026-RT4")).report.lines.find((l) => l.code === "5020")!.rate).toBe(0.25);
  });

  it("will not change the unit of an existing category, and validates input", async () => {
    const c = ctx();
    await expect(upsertCategory(c, { code: "1017", name: "x", unit: "pcs", rate: 1, validFrom: "2026-01-01" })).rejects.toThrow(/Enheten/);
    await expect(upsertCategory(c, { code: "ab", name: "x", unit: "pcs", rate: 1, validFrom: "2026-01-01" })).rejects.toThrow(/siffer/);
  });

  it("an archived category drops out of the report", async () => {
    const c = ctx();
    await archiveCategory(c, "2001");
    const o = await gpOverview(c, "2026-RT3");
    expect(o.report.lines.map((l) => l.code)).not.toContain("2001");
  });
});
