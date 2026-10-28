/**
 * The real Supplier 01 shipment (fwter/01.xlsx) through the real service, against a faithful copy of the
 * whole live catalogue (fwter/shopify-snapshot-all.json, read-only snapshot, no synthetic drafts).
 * Skipped where those client files are absent.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb, seedDefaults } from "./db";
import { calculate } from "./lines";
import { createShipment, getShipmentView, importInvoice, patchShipment, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

const F = path.resolve(__dirname, "../../../fwter");
const XLSX_FILE = path.join(F, "01.xlsx");
const SNAP = path.join(F, "shopify-snapshot-all.json");
const have = existsSync(XLSX_FILE) && existsSync(SNAP);

describe.skipIf(!have)("Supplier 01 — real file, faithful full catalogue", () => {
  async function run() {
    const db = new MemoryDb();
    seedDefaults(db);
    const shopify = FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAP, "utf8")), { draftEvery: 0 });
    const ctx: Ctx = { db, shopify, who: "t", log: async () => {}, now: () => new Date("2026-10-09T12:00:00Z") };
    const s = await createShipment(ctx, { name: "Supplier 01", supplierName: "Supplier 01 (Excel, PLN)", arrivalDate: "2026-10-08" });
    await patchShipment(ctx, s.id, { rates: { PLN: 2.5 }, freight_amount: 0 });
    const out = await importInvoice(ctx, s.id, { spec: { bytes: new Uint8Array(readFileSync(XLSX_FILE)), name: "01.xlsx" } });
    const view = await getShipmentView(ctx, s.id);
    return { ctx, out, view, calc: calculate(view.shipment, view.lines) };
  }

  it("imports 238 lines as 232 articles; three invoices combined; no PDF to check against", async () => {
    const { out } = await run();
    expect(out).toMatchObject({ rawLines: 238, products: 232, currency: "PLN", unmatched: 0 });
    expect(out.invoiceNo).toBe("2610-EX/01/00512 + 2610-EX/01/00513 + 2610-EX/01/00514");
    expect(out.control.checks.some((c) => c.code === "NO_PDF")).toBe(true);
  });

  it("matches 230 certainly and asks about exactly two: Lay's (names unlike) and Milka (tag and EAN contradict)", async () => {
    const { view } = await run();
    const doubtful = view.lines.filter((l) => l.match_status === "doubtful").map((l) => l.idx).sort();
    expect(doubtful).toEqual(["10930", "27702"]);
    expect(view.lines.filter((l) => l.match_status === "matched")).toHaveLength(230);
    const milka = view.lines.find((l) => l.idx === "10930")!;
    expect(milka.match_reason).toContain("EAN peker på");
    expect(milka.match_candidates).toHaveLength(1); // the product the EAN points to is offered
  });

  it("recognises the 26 drafts as new and the rest as restocked", async () => {
    const { view } = await run();
    expect(view.lines.filter((l) => l.is_new)).toHaveLength(26);
    expect(view.lines.filter((l) => l.shopify?.status === "DRAFT")).toHaveLength(26);
  });

  it("takes pieces per carton from Shopify for ACTIVE products and from the invoice for drafts, with no gaps", async () => {
    const { view } = await run();
    expect(view.lines.every((l) => l.pcs_per_carton)).toBe(true);
    for (const l of view.lines.filter((x) => x.is_new && x.unit === "pcs")) expect(l.pcs_source).toBe("invoice");
  });

  it("raises no false weight warnings (20*2G tea boxes are multi-packs)", async () => {
    const { view } = await run();
    expect(view.lines.filter((l) => l.issues.some((i) => /Vekt per stk/.test(i)))).toHaveLength(0);
  });

  it("protects every ACTIVE product whose price the tool cannot reproduce — including per-kg goods with an empty productType", async () => {
    const { calc } = await run();
    const kept = calc.rows.filter((r) => r.result.casePriceKept).map((r) => r.line.idx).sort();
    expect(kept).toEqual(["28544", "42170", "42171", "53020", "8632"].sort());
  });

  it("makes the operator state a box size for the seven kg lines, and blocks nothing else but duty", async () => {
    const { calc } = await run();
    const kg = calc.rows.filter((r) => r.line.unit === "kilo");
    expect(kg).toHaveLength(7);
    expect(kg.every((r) => r.blocked.some((b) => b.startsWith("Kg-vare")))).toBe(true);
    const other = calc.rows.flatMap((r) => r.blocked).filter((b) => !/^(Mangler toll|Mangler pris|Kg-vare|Usikker kobling)/.test(b));
    expect(other).toEqual([]);
  });

  it("reads the right numbers: 170 441,10 PLN, 6 729,91 kg — no 1000× weights", async () => {
    const { calc } = await run();
    expect(calc.rows.reduce((a, r) => a + (r.line.line_value ?? 0), 0)).toBeCloseTo(170441.1, 2);
    expect(calc.totals.totalNetWeightKg).toBeCloseTo(6729.91, 3);
  });
});

describe.skipIf(!have)("the fake Shopify is a faithful copy of the real catalogue", () => {
  const snap = () => JSON.parse(readFileSync(SNAP, "utf8")) as { products: Array<{ id: string; status: string; title: string; productType: string; tags: string[]; variants: { nodes: Array<{ price: string; barcode: string | null; inventoryQuantity: number; inventoryItem?: { unitCost?: { amount: string } | null } }> } }> };

  it("has every product, with the real statuses (no invented drafts)", () => {
    const s = snap();
    const fake = FakeShopify.fromSnapshot(s as never, { draftEvery: 0 });
    expect(fake.all()).toHaveLength(s.products.length);
    for (const status of ["ACTIVE", "DRAFT", "ARCHIVED"]) {
      expect(fake.all().filter((p) => p.status === status).length).toBe(s.products.filter((p) => p.status === status).length);
    }
  });

  it("copies title, productType, tags, price, cost, barcode and stock exactly", () => {
    const s = snap();
    const fake = FakeShopify.fromSnapshot(s as never, { draftEvery: 0 });
    const stock = fake.inventorySnapshot().stock;
    for (const raw of s.products.filter((_, i) => i % 7 === 0)) {
      const id = raw.id.split("/").pop()!;
      const p = fake.get(id)!;
      const v = raw.variants.nodes[0];
      expect(p).toMatchObject({ title: raw.title, productType: raw.productType, tags: raw.tags, variantPrice: Number(v.price) });
      expect(p.unitCost).toBe(v.inventoryItem?.unitCost ? Number(v.inventoryItem.unitCost.amount) : null);
      expect(p.barcodes).toEqual(v.barcode ? [v.barcode] : []);
      expect(stock[id]).toBe(v.inventoryQuantity);
    }
  });
});
