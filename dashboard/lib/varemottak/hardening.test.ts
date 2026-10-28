/**
 * Wrong, odd and sloppy input found while trying to break the app: each is refused with a readable message, or flagged on
 * the row, never accepted silently. No client files needed.
 */
import { describe, expect, it } from "vitest";
import { importDeclarationPdf } from "./declaration-service";
import { MemoryDb, seedDefaults } from "./db";
import { calculate } from "./lines";
import { createShipment, getShipmentView, importInvoice, patchLine, patchShipment, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

const NL = String.fromCharCode(10);
const enc = (s: string) => new TextEncoder().encode(s);
const HEAD = "Art.nr;Name;Quantity;Unit;Net value;Net weight;HS code;Country of origin";

const setup = async () => {
  const db = new MemoryDb();
  seedDefaults(db);
  const ctx: Ctx = { db, shopify: new FakeShopify([], {}), who: "t", log: async () => {}, now: () => new Date("2026-10-28T12:00:00Z") };
  const s = await createShipment(ctx, { name: "hard", supplierName: "Annen leverandør", arrivalDate: "2026-10-28" });
  await patchShipment(ctx, s.id, { rates: { PLN: 2.5 }, freight_amount: 100, freight_currency: "NOK" });
  const load = async (rows: string[]) => {
    const r = await importInvoice(ctx, s.id, { spec: { bytes: enc([HEAD, ...rows].join(NL)), name: "s.csv" }, currency: "PLN", invoiceNo: `I-${Math.random().toString(36).slice(2, 8)}` } as never);
    const v = await getShipmentView(ctx, s.id);
    return { r, v, calc: calculate(v.shipment, v.lines), invoice: v.invoices[v.invoices.length - 1] };
  };
  return { ctx, s, load };
};

describe("shipment settings", () => {
  it("only real dates are accepted as arrival date", async () => {
    const { ctx, s } = await setup();
    for (const bad of ["tomorrow", "2026-13-45", "2026-02-30", "28.10.2026", "1999-01-01", "2026-1-5"]) {
      await expect(patchShipment(ctx, s.id, { arrival_date: bad })).rejects.toThrow(/Ugyldig dato/);
    }
    await expect(createShipment(ctx, { name: "x", supplierName: "Stanro", arrivalDate: "soon" })).rejects.toThrow(/Ugyldig dato/);
    expect((await patchShipment(ctx, s.id, { arrival_date: "2026-11-01" })).arrival_date).toBe("2026-11-01");
    expect((await patchShipment(ctx, s.id, { arrival_date: "" })).arrival_date).toBeNull();
  });

  it("a status of 'pushed' cannot be typed in, and absurd amounts are refused", async () => {
    const { ctx, s } = await setup();
    await expect(patchShipment(ctx, s.id, { status: "pushed" })).rejects.toThrow(/Ugyldig status/);
    expect((await patchShipment(ctx, s.id, { status: "archived" })).status).toBe("archived");
    await expect(patchShipment(ctx, s.id, { freight_amount: 1e12 })).rejects.toThrow(/Frakt/);
    await expect(patchShipment(ctx, s.id, { drink_packaging_nok: 5000 })).rejects.toThrow(/Emballasje/);
  });
});

describe("row edits", () => {
  it("a slipped zero is refused instead of reaching Shopify", async () => {
    const { ctx, load } = await setup();
    const { v } = await load(["A1;Thing;10;pcs;100;5;19053100;PL"]);
    const id = v.lines[0].id;
    await expect(patchLine(ctx, id, { duty_per_kg: 99_999_999 })).rejects.toThrow(/Toll/);
    await expect(patchLine(ctx, id, { price_override: 1_000_000_000 })).rejects.toThrow(/Pris/);
    await expect(patchLine(ctx, id, { pcs_per_carton: 999_999 })).rejects.toThrow(/mellom 1 og 100000/);
    await expect(patchLine(ctx, id, { packaging_nok: 1000.5 })).rejects.toThrow(/Emballasje/);
    await expect(patchLine(ctx, id, { sales_unit_kg: 5000 })).rejects.toThrow(/Salgsenhet/);
    expect(Number((await patchLine(ctx, id, { duty_per_kg: 84.31 })).duty_per_kg)).toBe(84.31);
  });
});

describe("what an invoice file can get wrong", () => {
  it("rows whose quantity cannot be read are named, not dropped silently; blank and total rows are not", async () => {
    const { load } = await setup();
    const { r, invoice } = await load(["A1;Good;10;pcs;100;5;19053100;PL", "A2;Bad quantity;ten;pcs;50;2;19053100;PL", ";Subtotal;;;150;;;", "A3;Empty quantity;;pcs;50;2;19053100;PL"]);
    expect(r.rawLines).toBe(1);
    const text = invoice.warnings.join(" | ");
    expect(text).toMatch(/1 rader med varenummer ble hoppet over/);
    expect(text).toContain("A2");
    expect(text).not.toContain("A3");
  });

  it("an unknown unit is said out loud instead of being counted as pieces in silence", async () => {
    const { invoice } = await (await setup()).load(["A1;Thing;10;box;100;5;19053100;PL", "A2;Thing 2;10;pcs;100;5;19053100;PL", "A3;Thing 3;10;kg;100;10;19053100;PL"]);
    expect(invoice.warnings.join(" | ")).toMatch(/Ukjent enhet i filen \(«box»\)/);
  });

  it("an empty, unreadable or negative invoice value blocks the row; zero, no HS and no origin are flagged", async () => {
    const { ctx, load } = await setup();
    const { v } = await load([
      "V1;Value text;10;pcs;abc;5;19053100;PL",
      "V2;Value negative;10;pcs;-100;5;19053100;PL",
      "V3;Value zero;10;pcs;0;5;19053100;PL",
      "V4;No hs;10;pcs;100;5;;PL",
      "V5;No origin;10;pcs;100;5;19053100;",
      "V6;Fine;10;pcs;100;5;19053100;PL",
    ]);
    for (const l of v.lines) await patchLine(ctx, l.id, { duty_per_kg: 1, pcs_per_carton: 6 });
    const calc = calculate((await getShipmentView(ctx, v.shipment.id)).shipment, (await getShipmentView(ctx, v.shipment.id)).lines);
    const by = (idx: string) => calc.rows.find((r) => r.line.idx === idx)!;
    expect(by("V1").blocked).toContain("Mangler fakturaverdi");
    expect(by("V2").blocked.join()).toMatch(/Negativ fakturaverdi/);
    expect(by("V3").warnings.join()).toMatch(/Svært lav enhetspris/);
    expect(by("V4").warnings.join()).toMatch(/Mangler tollnummer/);
    expect(by("V5").warnings.join()).toMatch(/Mangler opprinnelsesland/);
    expect(by("V6").blocked.filter((b) => !/kobling|Ikke koblet|Mangler pris/.test(b))).toEqual([]);
    expect(by("V6").warnings).toEqual([]);
  });

  it("a chosen unit price on a conflicting article replaces an unreadable value", async () => {
    const { ctx, load } = await setup();
    const { v } = await load(["C1;Conflict;5;pcs;10;1;19053100;PL", "C1;Conflict;5;pcs;20;1;19053100;PL"]);
    expect(v.lines[0].price_conflict).not.toBeNull();
    await patchLine(ctx, v.lines[0].id, { chosen_unit_price: 3 });
    const calc = calculate((await getShipmentView(ctx, v.shipment.id)).shipment, (await getShipmentView(ctx, v.shipment.id)).lines);
    expect(calc.rows[0].blocked).not.toContain("Mangler fakturaverdi");
  });
});

describe("declaration upload with the wrong file", () => {
  it("says what is wrong in plain words, for empty files, CSVs and text", async () => {
    const { ctx } = await setup();
    for (const bytes of [new Uint8Array(0), enc("Art.nr;Name" + NL + "1;x"), enc("%PDF-1.4 not really")]) {
      await expect(importDeclarationPdf(ctx, { bytes, name: "d.pdf" })).rejects.toThrow(/kunne ikke leses som en tolldeklarasjon/);
    }
  });
});
