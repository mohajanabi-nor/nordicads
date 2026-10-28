/**
 * "Questions for you": what the app cannot decide is listed by name with a fix, never silently dropped.
 * The customs file is the client's real one (skipped where absent); the rest is small and self-contained.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fillOpenDuties, importRates } from "./bulk-import";
import { lookupDuty, type CustomsRate } from "./customs";
import { addRate, listRates } from "./customs-service";
import { MemoryDb, seedDefaults } from "./db";
import { calculate } from "./lines";
import { compareToHistory, priceAlert, type PreviousPurchase } from "./history";
import { declaredOptions, rateQuestions, shipmentQuestions } from "./questions";
import { createShipment, getShipmentView, importInvoice, patchLine, patchShipment, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

const ROOT = path.resolve(__dirname, "../../../fwter");
const RATES = path.join(ROOT, "package/A_Data_and_rules/1_customs_rates.csv");
const STANRO = path.join(ROOT, "000033_S33_2026_spec.csv");
const SNAP = path.join(ROOT, "shopify-snapshot-all.json");

const make = (shopify = new FakeShopify([], {})): Ctx => {
  const db = new MemoryDb();
  seedDefaults(db);
  return { db, shopify, who: "t", log: async () => {}, now: () => new Date("2026-10-27T12:00:00Z") };
};
const csv = (text: string, name = "rates.csv") => ({ bytes: new TextEncoder().encode(text), name });

describe("a customs file the app cannot fully use", () => {
  const FILE = [
    "CN8;Art.nr;Supplier;Toll kr/kg;Kilde;Dato;Info: note",
    ";9004;not available;12.04;estimate;not available;Poljorad Kajmak: read from the tariff",
    ";9005;not available;12.04;estimate;not available;Poljorad Kajmak: read from the tariff",
    "19053100;;;2.64 / 7.62;declaration 20789 (Plivit);not available;Bambi Lane 2.64; Frondi 7.62",
    ";7777;Maspo;;estimate;2026-01-01;Some product",
    ";8888;Maspo;3.5;estimate;2026-01-01;Fine product",
  ].join("\n");

  it("asks about each row it could not use, by name, instead of only listing it as skipped", async () => {
    const ctx = make();
    const r = await importRates(ctx, csv(FILE));
    expect(r.added).toBe(1);
    const q = rateQuestions(r.skipped);
    expect(q.map((x) => x.id)).toEqual(["rate-supplier", "rate-two", "rate-duty"]);

    const supplier = q[0];
    expect(supplier.title.en).toBe("2 rates have no supplier");
    expect(supplier.items.map((i) => i.label)).toEqual(["9004 · Poljorad Kajmak", "9005 · Poljorad Kajmak"]);
    expect(supplier.items[0].fix).toMatchObject({ kind: "rate-ask", ask: { kind: "supplier", idx: "9004", options: [12.04], rateKind: "estimate" } });

    const two = q[1].items[0].fix;
    expect(two).toMatchObject({ kind: "rate-ask", ask: { kind: "two-rates", cn8: "19053100", options: [2.64, 7.62], rateKind: "declaration" } });
    expect(q[2].items[0].label).toBe("7777 · Some product");
  });

  it("suggests the supplier when the app already knows who sells the article", async () => {
    const ctx = make();
    await ctx.db.insert("vm_price_history", { supplier: "Maspo", idx: "9004", currency: "PLN", unit_price: 3, occurred_on: "2026-05-01", invoice_no: "1", shipment_id: null });
    await addRate(ctx, { scope: "product", supplier: "Stanro", idx: "9005", dutyPerKg: 12.04, kind: "estimate" });
    const r = await importRates(ctx, csv(FILE));
    const asks = rateQuestions(r.skipped)[0].items.map((i) => (i.fix as { ask: { guesses: string[] } }).ask.guesses);
    expect(asks).toEqual([["Maspo"], ["Stanro"]]);
  });

  it("an answer is saved as a normal rate and reaches a shipment that was waiting for it", async () => {
    const ctx = make();
    const r = await importRates(ctx, csv(FILE));
    const fix = rateQuestions(r.skipped)[0].items[0].fix;
    if (fix?.kind !== "rate-ask") throw new Error("expected a rate question");
    const ask = fix.ask;
    expect(lookupDuty({ supplier: "Maspo", idx: "9004", hs: null }, (await listRates(ctx)) as unknown as CustomsRate[])).toBeNull();
    // what the screen sends when the person chooses Maspo
    await addRate(ctx, { scope: "product", supplier: "Maspo", idx: ask.idx as string, dutyPerKg: ask.options[0], kind: ask.rateKind, date: ask.date });
    const rates = (await listRates(ctx)) as unknown as CustomsRate[];
    expect(lookupDuty({ supplier: "Maspo", idx: "9004", hs: null }, rates)).toMatchObject({ kind: "estimate", dutyPerKg: 12.04 });
    // the other supplier's 9004 is still unknown: a rate belongs to one supplier's article number
    expect(lookupDuty({ supplier: "Stanro", idx: "9004", hs: null }, rates)).toBeNull();
    await expect(fillOpenDuties(ctx)).resolves.toBe(0);
  });

  it("registering both rates of a two-rate code makes the code ambiguous, so it is never applied by itself", async () => {
    const ctx = make();
    await addRate(ctx, { scope: "cn8", cn8: "19053100", dutyPerKg: 2.64, kind: "declaration", sourceRef: "20789" });
    await addRate(ctx, { scope: "cn8", cn8: "19053100", dutyPerKg: 7.62, kind: "declaration", sourceRef: "20789" });
    const rates = (await listRates(ctx)) as unknown as CustomsRate[];
    expect(lookupDuty({ supplier: "Maspo", idx: "x", hs: "19053100" }, rates)).toBeNull();
    // ...and a line with that code is offered both rates to choose from
    expect(declaredOptions("19053100", rates).map((c) => c.value)).toEqual([7.62, 2.64]);
  });
});

describe("the client's special cases are flagged on every row, whatever the duty says", () => {
  const row = (over: Record<string, unknown>) =>
    ({
      id: "l1", shipment_id: "s", invoice_id: null, position: 0, currency: "PLN", idx: "100", name: "Thing", unit: "pcs", qty: 10, cartons: 1, country: "PL", ean: null, ean_box: null,
      hs: "19053100", hs_fixed: false, net_weight_kg: 5, line_value: 100, unit_price: 10, price_conflict: null, source_lines: [], issues: [], match_status: "matched", match_via: "tag",
      match_reason: "", match_candidates: [], shopify_product_id: "p", shopify: null, is_new: false, mva25: false, vat_rate: null, history: null, duty_per_kg: 1, duty_source: null,
      duty_source_kind: "estimate", pcs_per_carton: 10, pcs_source: "typed", sales_unit_kg: null, price_override: null, chosen_unit_price: null, done: false, pushed_at: null, pushed: null,
      push_errors: null, updated_at: "", ...over,
    }) as unknown as import("./lines").LineRow;
  const shipment = { id: "s", supplier_name: "X", arrival_date: "2026-10-27", freight_amount: 100, freight_currency: "NOK", rates: { PLN: 2.5 }, markup_mode: "markup", markup_value: 0.3, margin_threshold: 0.23, drink_packaging_nok: 2 } as unknown as import("./lines").ShipmentRow;

  it("sausages, ice cream, Russia/Belarus and gifts each get a named question, with the product", () => {
    const lines = [
      row({ id: "a", idx: "A1", hs: "16010000", name: "Kielbasa", duty_per_kg: 84.31 }),
      row({ id: "b", idx: "B1", hs: "21050010", name: "Ice cream cup" }),
      row({ id: "c", idx: "C1", country: "BY", name: "Quark bar" }),
      row({ id: "d", idx: "D1", unit_price: 0.01, line_value: 0.1, name: "Free lollipop" }),
      row({ id: "e", idx: "E1", name: "Ordinary biscuit" }),
    ];
    const calc = calculate(shipment, lines);
    const q = shipmentQuestions(calc.rows, shipment, false, null);
    const ids = q.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["sanctions", "sausage", "ice-cream", "gift"]));
    expect(q.find((x) => x.id === "sausage")!.items.map((i) => i.label)).toEqual(["A1 · Kielbasa"]);
    expect(q.find((x) => x.id === "ice-cream")!.items.map((i) => i.label)).toEqual(["B1 · Ice cream cup"]);
    expect(q.find((x) => x.id === "sanctions")!.items.map((i) => i.label)).toEqual(["C1 · Quark bar"]);
    expect(q.find((x) => x.id === "gift")!.items.map((i) => i.label)).toEqual(["D1 · Free lollipop"]);
    // they are checks, not blockers: the push is still the operator's decision
    expect(q.filter((x) => ["sanctions", "sausage", "ice-cream", "gift"].includes(x.id)).every((x) => x.severity === "check")).toBe(true);
    expect(calc.rows.find((r) => r.line.id === "e")!.warnings).toEqual([]);
  });
});

describe("the price-increase alert (supplier up 10 %, cost up 15 %, placeholder cost ignored)", () => {
  const prev = (over: Partial<PreviousPurchase> = {}): PreviousPurchase => ({ unit_price: 10, currency: "PLN", our_price: 24, cost_incl_vat: 20, invoice_no: "1", occurred_on: "2026-09-01", ...over });
  const alertFor = (price: number, cost: number | null, p = prev()) => priceAlert(compareToHistory(price, "PLN", p, 24), p, cost);

  it("alerts at the thresholds and not below them", () => {
    expect(alertFor(10.99, 20)).toBeNull(); // +9.9 %
    expect(alertFor(11, 20)?.supplierPct).toBeCloseTo(0.1, 6); // +10 %
    expect(alertFor(10, 22.99)).toBeNull(); // cost +14.95 %
    expect(alertFor(10, 23)?.costPct).toBeCloseTo(0.15, 6); // cost +15 %
    expect(alertFor(10, 23)?.supplierPct).toBeNull();
    expect(alertFor(11, 23)).toMatchObject({ supplierPct: expect.any(Number), costPct: expect.any(Number) });
  });

  it("a price that went down, no history, or an unknown cost never alerts", () => {
    expect(alertFor(8, 15)).toBeNull();
    expect(priceAlert(compareToHistory(10, "PLN", null, 24), null, 30)).toBeNull();
    expect(alertFor(10, null)).toBeNull();
  });

  it("a previous cost of exactly 8.00 is a placeholder set at creation, so it is ignored", () => {
    expect(alertFor(10, 40, prev({ cost_incl_vat: 8 }))).toBeNull();
    expect(alertFor(11, 40, prev({ cost_incl_vat: 8 }))?.costPct).toBeNull(); // the supplier part still counts
    expect(alertFor(11, 40, prev({ cost_incl_vat: 8 }))?.supplierPct).toBeCloseTo(0.1, 6);
  });
});

describe.skipIf(!existsSync(RATES))("the client's real customs file", () => {
  it("turns its five unusable rows into the questions the client has to answer", async () => {
    const ctx = make();
    const r = await importRates(ctx, { bytes: new Uint8Array(readFileSync(RATES)), name: "1_customs_rates.csv" });
    expect(r.skipped).toHaveLength(5);
    const q = rateQuestions(r.skipped);
    expect(q.find((x) => x.id === "rate-supplier")?.title.en).toBe("4 rates have no supplier");
    const names = q.find((x) => x.id === "rate-supplier")!.items.map((i) => i.label);
    expect(names).toEqual(["9004 · Poljorad Kajmak", "9005 · Poljorad Kajmak", "9011 · Poljorad Kajmak", "1269 · ABC cheese"]);
    const two = q.find((x) => x.id === "rate-two")!;
    expect(two.items[0].fix).toMatchObject({ kind: "rate-ask", ask: { cn8: "19053100", options: [2.64, 7.62] } });
    expect(two.items[0].sub).toMatchObject({ en: expect.stringContaining("rate depends on product") });
    // the sausage code the client calls ambiguous is offered with both of its declared rates
    const rates = (await listRates(ctx)) as unknown as CustomsRate[];
    expect(declaredOptions("16010000", rates).map((c) => c.value).sort((a, b) => b - a)[0]).toBeGreaterThan(80);
    expect(declaredOptions("16010000", rates)).toHaveLength(2);
  }, 120_000);
});

describe.skipIf(!existsSync(STANRO) || !existsSync(SNAP))("questions on a real shipment", () => {
  it("lists what blocks the rows by name, with a fix, and the list shrinks as the answers come in", async () => {
    const ctx = make(FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAP, "utf8")), { draftEvery: 0 }));
    const s = await createShipment(ctx, { name: "Stanro", supplierName: "Stanro", arrivalDate: "2026-10-27" });
    await importInvoice(ctx, s.id, { spec: { bytes: new Uint8Array(readFileSync(STANRO)), name: "000033_S33_2026_spec.csv" } });

    const ask = async () => {
      const view = await getShipmentView(ctx, s.id);
      const calc = calculate(view.shipment, view.lines);
      return { view, calc, q: shipmentQuestions(calc.rows, view.shipment, calc.totals.freightMissingRate, null) };
    };
    let { calc, q } = await ask();
    const byId = (id: string) => q.find((x) => x.id === id);

    // no PLN rate and no freight yet: the shipment-level questions come first and say what to type
    expect(q[0]).toMatchObject({ id: "rates", severity: "blocking" });
    expect(q[0].items[0].fix).toEqual({ kind: "shipment-rate", currency: "PLN" });
    expect(byId("freight")?.severity).toBe("check");

    // every row without duty is named, and each has a number box
    const missing = calc.rows.filter((c) => c.result.flags.missingDuty);
    expect(missing.length).toBeGreaterThan(0);
    expect(byId("duty")!.items).toHaveLength(missing.length);
    expect(byId("duty")!.items[0].label).toMatch(/·/);
    expect(byId("duty")!.items[0].fix).toMatchObject({ kind: "number", field: "duty_per_kg" });

    // answering the rate removes the rate question
    await patchShipment(ctx, s.id, { rates: { PLN: 2.5 }, freight_amount: 3800, freight_currency: "NOK" });
    ({ calc, q } = await ask());
    expect(byId("rates")).toBeUndefined();
    expect(byId("freight")).toBeUndefined();

    // answering one duty removes exactly that row from the list
    const first = byId("duty")!.items[0];
    await patchLine(ctx, first.lineId!, { duty_per_kg: 1.5 });
    const after = (await ask()).q.find((x) => x.id === "duty")!;
    expect(after.items).toHaveLength(missing.length - 1);
    expect(after.items.some((i) => i.key === first.key)).toBe(false);

    // a weight can be typed from the question too
    const noWeight = byId("weight");
    if (noWeight) {
      await patchLine(ctx, noWeight.items[0].lineId!, { net_weight_kg: 12.5 });
      const w = (await getShipmentView(ctx, s.id)).lines.find((l) => l.id === noWeight.items[0].lineId)!;
      expect(Number(w.net_weight_kg)).toBe(12.5);
    }
  }, 120_000);
});
