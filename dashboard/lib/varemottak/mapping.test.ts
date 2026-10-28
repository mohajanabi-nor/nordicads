import { describe, expect, it } from "vitest";
import { MemoryDb, seedDefaults } from "./db";
import { createShipment, getShipmentView, importInvoice, inspectImport, savedMapping, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";
import { inspectSpec } from "./suppliers/generic";

const enc = (s: string) => new TextEncoder().encode(s);

// A supplier whose column names we do not know.
const odd = (no: string) => `Artikkel;Beskr;Mengde-stk;Sum\n1001;Test A;10;100,5\n1002;Test B;5;50\n`.replace("Artikkel", "Pos-ID") + (no ? "" : "");

const setup = async () => {
  const db = new MemoryDb();
  seedDefaults(db);
  const ctx: Ctx = { db, shopify: new FakeShopify([], {}), who: "t", log: async () => {}, now: () => new Date("2026-10-09T12:00:00Z") };
  const s = await createShipment(ctx, { name: "S", supplierName: "Annen leverandør", arrivalDate: "2026-10-08" });
  return { ctx, shipmentId: s.id };
};

describe("inspectSpec", () => {
  it("names what it found and what is missing, and gives a preview", () => {
    const r = inspectSpec(enc(odd("")), "f.csv");
    expect(r.headers).toEqual(["Pos-ID", "Beskr", "Mengde-stk", "Sum"]);
    expect(r.missingRequired).toEqual(["idx", "name", "qty"]);
    expect(r.found.netValue).toBe("Sum");
    expect(r.sample[0]).toEqual(["1001", "Test A", "10", "100,5"]);
  });
  it("applies a mapping, and 'no column' switches an alias off", () => {
    const m = { idx: "Pos-ID", name: "Beskr", qty: "Mengde-stk" };
    const r = inspectSpec(enc(odd("")), "f.csv", m);
    expect(r.missingRequired).toEqual([]);
    expect(r.found).toMatchObject({ idx: "Pos-ID", name: "Beskr", qty: "Mengde-stk", netValue: "Sum" });
    expect(inspectSpec(enc(odd("")), "f.csv", { ...m, netValue: "-" }).found.netValue).toBeUndefined();
  });
});

describe("importing a file with unknown columns", () => {
  it("is refused with the headers, then works with a mapping, and the mapping is remembered", async () => {
    const { ctx, shipmentId } = await setup();
    const file = { bytes: enc(odd("")), name: "odd.csv" };

    await expect(importInvoice(ctx, shipmentId, { spec: file, currency: "EUR", invoiceNo: "A-1" })).rejects.toThrow(/Overskrifter i filen: Pos-ID/);

    const mapping = { idx: "Pos-ID", name: "Beskr", qty: "Mengde-stk" };
    const first = await importInvoice(ctx, shipmentId, { spec: file, currency: "EUR", invoiceNo: "A-1", mapping });
    expect(first.products).toBe(2);
    expect(await savedMapping(ctx, "Annen leverandør")).toEqual(mapping);

    // The next file from this supplier needs no mapping.
    const again = await importInvoice(ctx, shipmentId, { spec: { bytes: file.bytes, name: "odd2.csv" }, currency: "EUR", invoiceNo: "A-2" });
    expect(again.products).toBe(2);

    const insp = await inspectImport(ctx, shipmentId, file);
    expect(insp.missingRequired).toEqual([]);
    expect((await getShipmentView(ctx, shipmentId)).invoices).toHaveLength(2);
  });
});
