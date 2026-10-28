import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb, seedDefaults } from "./db";
import { barcodeWarning, type LineRow, type ShopifySnapshot } from "./lines";
import { createShipment, getShipmentView, importInvoice, patchShipment, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

const line = (ean: string | null, eanBox: string | null, barcodes?: string[]) =>
  ({ ean, ean_box: eanBox, shopify: barcodes ? ({ barcodes } as ShopifySnapshot) : null }) as Pick<LineRow, "ean" | "ean_box" | "shopify">;

describe("barcodeWarning", () => {
  it("is silent when the barcode agrees (piece or box, ignoring leading zeros)", () => {
    expect(barcodeWarning(line("5900259129284", null, ["5900259129284"]))).toBeNull();
    expect(barcodeWarning(line("111", "5900259097026", ["05900259097026"]))).toBeNull();
  });
  it("says so when Shopify has a different barcode", () => {
    expect(barcodeWarning(line("5900259127600", "5900259097026", ["5900259129284"]))).toContain("er ikke den på fakturaen");
  });
  it("says so when the product has no barcode", () => {
    expect(barcodeWarning(line("5900259127600", null, []))).toContain("mangler strekkode");
  });
  it("is silent when there is nothing to compare", () => {
    expect(barcodeWarning(line(null, null, ["1"]))).toBeNull(); // invoice without EANs
    expect(barcodeWarning(line("1", null))).toBeNull(); // no product, or imported before barcodes were stored
  });
});

const F = path.resolve(__dirname, "../../../fwter");
describe.skipIf(!existsSync(path.join(F, "01.xlsx")) || !existsSync(path.join(F, "shopify-snapshot-all.json")))("barcode warnings on the real shipment", () => {
  it("marks Lay's and the other wrong barcodes on the rows", async () => {
    const fake = FakeShopify.fromSnapshot(JSON.parse(readFileSync(path.join(F, "shopify-snapshot-all.json"), "utf8")), { draftEvery: 0 });
    const db = new MemoryDb();
    seedDefaults(db);
    const ctx: Ctx = { db, shopify: fake, who: "t", log: async () => {}, now: () => new Date("2026-10-09T12:00:00Z") };
    const s = await createShipment(ctx, { name: "S", supplierName: "Supplier 01 (Excel, PLN)", arrivalDate: "2026-10-08" });
    await patchShipment(ctx, s.id, { rates: { PLN: 2.5 } });
    await importInvoice(ctx, s.id, { spec: { bytes: new Uint8Array(readFileSync(path.join(F, "01.xlsx"))), name: "01.xlsx" } });
    const view = await getShipmentView(ctx, s.id);
    const flagged = view.lines.filter((l) => barcodeWarning(l));
    console.log("BARCODE WARNINGS:", flagged.length, "of", view.lines.length);
    expect(flagged.map((l) => l.idx)).toContain("27702");
    expect(flagged.length).toBeGreaterThan(10);
    expect(flagged.length).toBeLessThan(view.lines.length);
  }, 120_000);
});
