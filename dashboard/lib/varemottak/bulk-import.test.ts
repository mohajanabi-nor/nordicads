import { describe, expect, it } from "vitest";
import { importHistory, importRates, parseDate } from "./bulk-import";
import { listRates } from "./customs-service";
import { MemoryDb, seedDefaults } from "./db";
import { createShipment, getShipmentView, importInvoice, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

const enc = (s: string) => new TextEncoder().encode(s);
const make = () => {
  const db = new MemoryDb();
  seedDefaults(db);
  const ctx: Ctx = { db, shopify: new FakeShopify([], {}), who: "t", log: async () => {}, now: () => new Date("2026-10-09T12:00:00Z") };
  return ctx;
};

describe("parseDate", () => {
  it("reads ISO and day-first dates, and nothing else", () => {
    expect(parseDate("2026-09-24")).toBe("2026-09-24");
    expect(parseDate("24.09.2026")).toBe("2026-09-24");
    expect(parseDate("4/9/2026")).toBe("2026-09-04");
    expect(parseDate("yesterday")).toBeNull();
  });
});

describe("importRates", () => {
  it("loads CN8 and product rates, skips bad rows with a reason, and replaces on a re-run", async () => {
    const ctx = make();
    const csv = ["CN8;Art.nr;Supplier;Toll kr/kg;Kilde;Dato", "19053211;;;12,5;D-1;24.09.2026", ";1001;Stanro;3,2;;", "1905;;;1;;", "19059070;;;abc;;", ";2002;;4;;"].join("\n");
    const r = await importRates(ctx, { bytes: enc(csv), name: "rates.csv" });
    expect(r).toMatchObject({ rows: 5, added: 2, replaced: 0 });
    expect(r.skipped.map((s) => s.reason)).toEqual([
      "Tollnummeret må ha 8 siffer",
      "Toll kr/kg mangler eller er ugyldig",
      "Leverandør mangler (egen kolonne, eller velg leverandør)",
    ]);
    const rates = await listRates(ctx);
    expect(rates.find((x) => x.scope === "cn8")).toMatchObject({ cn8: "19053211", duty_per_kg: 12.5, source_kind: "declaration", source_ref: "D-1", source_date: "2026-09-24" });
    expect(rates.find((x) => x.scope === "product")).toMatchObject({ supplier: "Stanro", idx: "1001", duty_per_kg: 3.2, source_kind: "estimate" });

    const again = await importRates(ctx, { bytes: enc("CN8;Toll kr/kg\n19053211;13"), name: "r2.csv" });
    expect(again).toMatchObject({ added: 0, replaced: 1 });
    expect((await listRates(ctx)).filter((x) => x.cn8 === "19053211")).toHaveLength(1);
  });

  it("takes the supplier from the option, and says what is wrong with a file it cannot read", async () => {
    const ctx = make();
    expect(await importRates(ctx, { bytes: enc("Art.nr;Toll\n7;1,5"), name: "r.csv" }, { supplier: "Leis" })).toMatchObject({ added: 1 });
    await expect(importRates(ctx, { bytes: enc("A;B\n1;2"), name: "r.csv" })).rejects.toThrow(/Overskrifter i filen: A \| B/);
  });

  it("fills empty duties in an open shipment, and leaves typed ones alone", async () => {
    const ctx = make();
    const s = await createShipment(ctx, { name: "S", supplierName: "Annen leverandør", arrivalDate: "2026-10-08" });
    await importInvoice(ctx, s.id, { spec: { bytes: enc("INDEX;NAME_ENG;QUANTITY;NET_VALUE;TARIFF NUMBER\n1;A;10;100;19053211\n2;B;5;50;19053211"), name: "f.csv" }, currency: "EUR", invoiceNo: "I-1" });
    const before = (await getShipmentView(ctx, s.id)).lines;
    expect(before.every((l) => l.duty_per_kg === null)).toBe(true);

    const r = await importRates(ctx, { bytes: enc("CN8;Toll kr/kg\n19053211;12,5"), name: "r.csv" });
    expect(r.filledOpenLines).toBe(2);
    const after = (await getShipmentView(ctx, s.id)).lines;
    expect(after.map((l) => Number(l.duty_per_kg))).toEqual([12.5, 12.5]);
    expect(after[0].duty_source_kind).toBe("cn8");
  });
});

describe("importHistory", () => {
  it("loads purchases, skips bad rows, treats an undated line as the newest, and does not add the same line twice", async () => {
    const ctx = make();
    const csv = ["Supplier;Art.nr;Price;Currency;Date;Invoice", "Stanro;1001;4,55;PLN;2026-08-01;S/1", "Stanro;1002;2,1;PLN;01.08.2026;S/1", "Stanro;1003;x;PLN;2026-08-01;S/1", "Stanro;1004;1;PLN;not available;S/2"].join(String.fromCharCode(10));
    const r = await importHistory(ctx, { bytes: enc(csv), name: "h.csv" });
    expect(r).toMatchObject({ rows: 4, added: 3, duplicates: 0, undated: 1 });
    expect(r.skipped.map((s) => s.reason)).toEqual(["Pris mangler eller er ugyldig"]);
    // the undated line is placed the day after the supplier's latest dated one
    const stored = await ctx.db.select<{ idx: string; occurred_on: string }>("vm_price_history", {});
    expect(stored.find((x) => x.idx === "1004")?.occurred_on).toBe("2026-08-02");

    const again = await importHistory(ctx, { bytes: enc(csv), name: "h.csv" });
    expect(again).toMatchObject({ added: 0, duplicates: 3 });
    expect(await ctx.db.select("vm_price_history", {})).toHaveLength(3);
  });

  it("needs supplier and currency from somewhere", async () => {
    const ctx = make();
    const file = { bytes: enc("Art.nr;Price;Date\n1;2;2026-01-01"), name: "h.csv" };
    expect((await importHistory(ctx, file)).skipped[0].reason).toContain("Leverandør mangler");
    expect((await importHistory(ctx, file, { supplier: "Leis" })).skipped[0].reason).toContain("Valuta mangler");
    expect(await importHistory(ctx, file, { supplier: "Leis", currency: "eur" })).toMatchObject({ added: 1 });
  });
});

describe("loaded history is used by the next import", () => {
  it("shows the previous price and the change", async () => {
    const ctx = make();
    await importHistory(ctx, { bytes: enc("Supplier;Art.nr;Price;Currency;Date;Invoice\nAnnen leverandør;1;8;EUR;2026-08-01;OLD-1"), name: "h.csv" });
    const s = await createShipment(ctx, { name: "S", supplierName: "Annen leverandør", arrivalDate: "2026-10-08" });
    const out = await importInvoice(ctx, s.id, { spec: { bytes: enc("INDEX;NAME_ENG;QUANTITY;NET_VALUE\n1;A;10;100\n2;B;5;50"), name: "f.csv" }, currency: "EUR", invoiceNo: "I-1" });
    expect(out.summary.up).toBe(1);
    const lines = (await getShipmentView(ctx, s.id)).lines;
    const a = lines.find((l) => l.idx === "1")!;
    expect(a.history).toMatchObject({ change: { direction: "up", previousUnitPrice: 8, changePct: 0.25 } });
    expect(lines.find((l) => l.idx === "2")!.history?.change.direction).toBe("new");
  });
});
