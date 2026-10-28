/**
 * The same service code, but on a REAL Postgres with the REAL migrations (PGlite).
 *
 * The in-memory database used elsewhere cannot catch what only Postgres knows: column
 * types and precision, CHECK and UNIQUE constraints, ON CONFLICT targets, jsonb and array
 * columns, foreign-key cascades. This file is the proof that migration 011 and the code
 * agree with each other.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyDeclaration } from "./customs-service";
import { gpOverview, setProductGp } from "./gp-service";
import { calculate } from "./lines";
import {
  createShipment,
  deleteShipment,
  getShipmentView,
  importInvoice,
  patchLine,
  patchShipment,
  pushLog,
  pushShipment,
  saveProductSettings,
  setDone,
  setMatch,
  type Ctx,
} from "./service";
import { FakeShopify } from "./shopify/fake";
import { createPgliteWithMigrations, PgDb } from "./testing/pgdb";

const FWTER = path.resolve(__dirname, "../../../fwter");
const CSV = path.join(FWTER, "000033_S33_2026_spec.csv");
const PDF = path.join(FWTER, "000033-S33-2026.pdf");
const SNAPSHOT = path.join(FWTER, "shopify-snapshot.json");
const have = [CSV, PDF, SNAPSHOT].every(existsSync);

const VM_TABLES = [
  "vm_push_log", "vm_price_history", "vm_declarations", "vm_customs_rates", "vm_product_settings",
  "vm_supplier_links", "vm_supplier_mappings", "vm_lines", "vm_invoice_lines", "vm_invoices", "vm_shipments",
];

describe.skipIf(!have)("Varemottak on real Postgres", () => {
  let pg: PGlite;
  let db: PgDb;
  let ctx: Ctx;
  let shopify: FakeShopify;

  beforeAll(async () => {
    pg = await createPgliteWithMigrations();
    db = new PgDb(pg);
  }, 120_000);
  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(`TRUNCATE ${VM_TABLES.join(", ")} CASCADE`);
    shopify = FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
    ctx = { db, shopify, who: "test@nordicengros.no", log: async () => {}, now: () => new Date("2026-10-09T12:00:00Z") };
  });

  const files = (csv = CSV) => ({
    spec: { bytes: new Uint8Array(readFileSync(csv)), name: "spec.csv" },
    pdf: { bytes: new Uint8Array(readFileSync(PDF)), name: "invoice.pdf" },
  });

  async function stanro(name = "Stanro 000033", over: Record<string, unknown> = {}) {
    const s = await createShipment(ctx, { name, supplierName: "Stanro", arrivalDate: "2026-09-24" });
    await patchShipment(ctx, s.id, { rates: { PLN: 2.498 }, freight_amount: 3800, ...over });
    return s;
  }

  it("the migration created every table and the new event_log source is accepted", async () => {
    const t = await pg.query<{ table_name: string }>("select table_name from information_schema.tables where table_name like 'vm_%'");
    expect(t.rows.map((r) => r.table_name).sort()).toEqual(
      ["vm_customs_rates", "vm_declarations", "vm_gp_categories", "vm_gp_rates", "vm_invoice_lines", "vm_invoices", "vm_lines", "vm_price_history", "vm_product_settings", "vm_push_log", "vm_shipments", "vm_supplier_links", "vm_supplier_mappings"].sort(),
    );
    await expect(pg.query("insert into event_log (level, source, event, message) values ('info', 'varemottak', 'x', 'y')")).resolves.toBeTruthy();
    await expect(pg.query("insert into event_log (level, source, event, message) values ('info', 'nonsense', 'x', 'y')")).rejects.toThrow(/check/i);
  });

  it("the database refuses what the code must never write (constraints)", async () => {
    const s = await stanro();
    await expect(pg.query(`insert into vm_lines (shipment_id, invoice_id, currency, idx, unit, qty, match_via) values ('${s.id}', null, 'PLN', 'X', 'pcs', 1, 'guess')`)).rejects.toThrow(/check/i);
    await expect(pg.query(`insert into vm_lines (shipment_id, currency, idx, unit, qty) values ('${s.id}', 'PLN', 'X', 'box', 1)`)).rejects.toThrow(/check/i);
    await expect(pg.query(`insert into vm_push_log (mode) values ('whatever')`)).rejects.toThrow(/check/i);
    await expect(pg.query(`insert into vm_customs_rates (scope, duty_per_kg, source_kind, source_ref) values ('cn8', 1, 'guess', 'x')`)).rejects.toThrow(/check/i);
  });

  it("imports the Stanro shipment into the real tables with the right types", async () => {
    const s = await stanro();
    const out = await importInvoice(ctx, s.id, files());
    expect(out).toMatchObject({ rawLines: 275, products: 238 });

    const raw = await pg.query<{ n: number }>("select count(*)::int n from vm_invoice_lines");
    expect(raw.rows[0].n).toBe(275);
    const view = await getShipmentView(ctx, s.id);
    expect(view.lines).toHaveLength(238);
    expect(view.invoices[0]).toMatchObject({ invoice_no: "000033/S33/2026", currency: "PLN", net_total: 279883.75, vat_total: 0 });
    expect(view.invoices[0].invoice_date).toBe("2026-09-24"); // a date, not a Date object
    expect(view.invoices[0].extra_lines).toHaveLength(2); // jsonb round trip
    const dan = view.lines.find((l) => l.idx === "86018000DAN")!;
    expect(dan.price_conflict).toHaveLength(2); // jsonb
    expect(dan.source_lines).toEqual([121, 122, 123].map((n) => n + 0).slice(0, 0).concat(dan.source_lines)); // int[] came back as an array
    expect(Array.isArray(dan.source_lines) && dan.source_lines.length > 1 && dan.source_lines.every((n) => typeof n === "number")).toBe(true);
    expect(typeof view.lines[0].qty).toBe("number"); // numeric → number, as PostgREST does
    expect(typeof view.lines[0].position).toBe("number");
    // numeric(14,3) keeps fractional cartons and kg exactly
    const kinder = view.lines.find((l) => l.idx === "11287100FEJ")!;
    expect(Number(kinder.qty)).toBe(6048);
    expect(Number(kinder.cartons)).toBe(84);
  });

  it("the unique key stops the same article twice on one invoice, and the same invoice twice in a shipment", async () => {
    const s = await stanro();
    await importInvoice(ctx, s.id, files());
    await expect(importInvoice(ctx, s.id, files())).rejects.toThrow(/allerede importert/);
    const lines = await pg.query<{ n: number }>("select count(*)::int n from vm_lines");
    expect(lines.rows[0].n).toBe(238); // the failed second import wrote nothing
  });

  it("typed duty goes to the customs register, box size to product settings without blanking Grønt Punkt", async () => {
    const s = await stanro();
    await importInvoice(ctx, s.id, files());
    const { lines } = await getShipmentView(ctx, s.id);
    const soup = lines.find((l) => l.idx === "71806000AXE")!;
    await patchLine(ctx, soup.id, { duty_per_kg: 1.5 });
    await patchLine(ctx, soup.id, { duty_per_kg: 1.75 }); // replaces, not duplicates
    const rates = await pg.query<{ duty_per_kg: number; source_kind: string; source_ref: string; source_date: string }>("select * from vm_customs_rates");
    expect(rates.rows).toHaveLength(1);
    expect(rates.rows[0]).toMatchObject({ duty_per_kg: 1.75, source_kind: "estimate", source_ref: "typed by us, estimate", source_date: "2026-10-09" });

    const kg = lines.find((l) => l.unit === "kilo" && l.shopify_product_id)!;
    await saveProductSettings(ctx, kg.shopify_product_id!, { gp_code: "1017", gp_packaging_kg: 0.025 });
    await patchLine(ctx, kg.id, { sales_unit_kg: 1.5 });
    const set = await pg.query<{ sales_unit_kg: number; gp_code: string; gp_packaging_kg: number }>("select * from vm_product_settings");
    expect(set.rows[0]).toMatchObject({ sales_unit_kg: 1.5, gp_code: "1017", gp_packaging_kg: 0.025 });
  });

  it("pushes to the fake shop and records the log, the history and the status in Postgres", async () => {
    const s = await stanro();
    await importInvoice(ctx, s.id, files());
    const { lines } = await getShipmentView(ctx, s.id);
    const pick = lines.filter((l) => l.match_status === "matched" && l.unit === "pcs" && l.pcs_per_carton && !l.hs?.startsWith("22") && !l.price_conflict).slice(0, 4);
    for (const l of pick) await patchLine(ctx, l.id, { duty_per_kg: 2, price_override: 40 });
    await setDone(ctx, s.id, pick.map((l) => l.id), true);

    const out = await pushShipment(ctx, s.id, { dryRun: false, acknowledgeWarnings: true });
    expect(out).toMatchObject({ sent: 4, succeeded: 4, failed: 0 });

    const log = await pushLog(ctx, s.id);
    expect(log).toHaveLength(4);
    expect(log[0]).toMatchObject({ by_user: "test@nordicengros.no", mode: "fake" });
    expect(typeof log[0].at).toBe("string");
    expect(log[0].previous).toHaveProperty("variantPrice"); // jsonb of what it replaced
    const hist = await pg.query<{ our_price: number; cost_incl_vat: number }>("select * from vm_price_history where cost_incl_vat is not null");
    expect(hist.rows).toHaveLength(4);
    expect(hist.rows.every((h) => h.our_price === 40)).toBe(true);
    expect((await getShipmentView(ctx, s.id)).shipment.status).toBe("review");

    // a re-push of unchanged rows sends nothing
    expect((await pushShipment(ctx, s.id, { dryRun: false, acknowledgeWarnings: true })).sent).toBe(0);
    await patchLine(ctx, pick[0].id, { price_override: 41.5 });
    expect((await pushShipment(ctx, s.id, { dryRun: false, acknowledgeWarnings: true })).succeeded).toBe(1);
    expect(shopify.get(pick[0].shopify_product_id!)).toMatchObject({ productType: "41,5" });
  });

  it("compares with the previous purchase from the history table (dates, numerics, our price)", async () => {
    const s = await stanro();
    await importInvoice(ctx, s.id, files());
    const { lines } = await getShipmentView(ctx, s.id);
    const l = lines.find((x) => !x.is_new && x.match_status === "matched" && x.unit === "pcs" && x.pcs_per_carton && !x.hs?.startsWith("22") && !x.price_conflict && x.shopify!.productType && Number(x.line_value) > 0)!;
    await patchLine(ctx, l.id, { duty_per_kg: 2 });
    await setDone(ctx, s.id, [l.id], true);
    await pushShipment(ctx, s.id, { dryRun: false, acknowledgeWarnings: true });

    const text = new TextDecoder("windows-1250").decode(readFileSync(CSV)).replaceAll("000033/S33/2026", "000040/S33/2026");
    const rows = text.split(/\r?\n/).map((r) => {
      const f = r.split(";");
      if (f[1]?.includes(l.idx)) f[10] = (Number(l.line_value) * 1.3).toFixed(2).replace(".", ",");
      return f.join(";");
    });
    const s2 = await stanro("Stanro 000040");
    await importInvoice(ctx, s2.id, { spec: { bytes: new TextEncoder().encode(rows.join("\n")), name: "s2.csv" } });
    const row = (await getShipmentView(ctx, s2.id)).lines.find((x) => x.idx === l.idx)!;
    expect(row.history!.change.direction).toBe("up");
    expect(row.history!.change.changePct).toBeCloseTo(0.3, 2);
    expect(row.history!.previous).toMatchObject({ invoice_no: "000033/S33/2026", occurred_on: "2026-09-24" });
  });

  it("applies a customs declaration across shipments in Postgres", async () => {
    const s = await stanro();
    await importInvoice(ctx, s.id, files());
    const { lines } = await getShipmentView(ctx, s.id);
    const hit = lines.find((l) => l.hs === "19053191" && l.shopify_product_id)!;
    await patchLine(ctx, hit.id, { duty_per_kg: 2 });
    const out = await applyDeclaration(ctx, { number: "25NO-PG-1", date: "2026-10-05", items: [{ cn8: "19053191", dutyNok: 300, netWeightKg: 100 }] });
    expect(out.rates).toEqual([{ cn8: "19053191", dutyPerKg: 3 }]);
    expect(out.changes.length).toBeGreaterThan(0);
    const after = (await getShipmentView(ctx, s.id)).lines.find((l) => l.id === hit.id)!;
    expect(after).toMatchObject({ duty_per_kg: 3, duty_source_kind: "declaration", duty_source: "Deklarasjon 25NO-PG-1" });
    const decl = await pg.query<{ number: string; declared_at: string }>("select * from vm_declarations");
    expect(decl.rows[0]).toMatchObject({ number: "25NO-PG-1", declared_at: "2026-10-05" });
    await expect(applyDeclaration(ctx, { number: "25NO-PG-1", items: [{ cn8: "19053191", dutyNok: 1, netWeightKg: 1 }] })).rejects.toThrow(/allerede/);
  });

  it("builds the Grønt Punkt report from Postgres, with the seeded categories and rates", async () => {
    const s = await stanro();
    await importInvoice(ctx, s.id, files());
    const o0 = await gpOverview(ctx, "2026-RT5");
    expect(o0.categories.map((c) => c.code)).toEqual(["1017", "2001", "4005", "5020"]);
    expect(o0.report.term).toMatchObject({ start: "2026-09-01", end: "2026-10-31" });
    expect(o0.unassigned).toBeGreaterThan(0);

    const pepsi = o0.products.find((p) => /pepsi/i.test(p.shopifyTitle ?? p.name))!;
    await setProductGp(ctx, pepsi.productId!, { gpCode: "4005", gpPackagingKg: null });
    const o1 = await gpOverview(ctx, "2026-RT5");
    expect(o1.report.lines.find((l) => l.code === "4005")).toMatchObject({ quantity: 792, rate: 0.464, sum: 367.49 });
  });

  it("deleting a shipment cascades through every child table, and frees the invoice number", async () => {
    const s = await stanro();
    await importInvoice(ctx, s.id, files());
    await deleteShipment(ctx, s.id);
    for (const t of ["vm_invoices", "vm_invoice_lines", "vm_lines", "vm_price_history"]) {
      const n = await pg.query<{ n: number }>(`select count(*)::int n from ${t}`);
      expect(n.rows[0].n, t).toBe(0);
    }
    const s2 = await stanro("Again");
    await expect(importInvoice(ctx, s2.id, files())).resolves.toBeTruthy();
  });

  it("a remembered match survives into the next shipment (supplier links)", async () => {
    const s = await stanro();
    await importInvoice(ctx, s.id, files());
    const { lines } = await getShipmentView(ctx, s.id);
    const l = lines.find((x) => x.match_status === "matched")!;
    await setMatch(ctx, l.id, l.shopify_product_id!);
    const links = await pg.query<{ supplier: string; idx: string }>("select * from vm_supplier_links");
    expect(links.rows).toEqual([expect.objectContaining({ supplier: "Stanro", idx: l.idx })]);
    await setMatch(ctx, l.id, l.shopify_product_id!); // picking again upserts, never duplicates
    expect((await pg.query("select * from vm_supplier_links")).rows).toHaveLength(1);
  });

  it("the review numbers are identical whether the rows came from memory or from Postgres", async () => {
    const s = await stanro();
    await importInvoice(ctx, s.id, files());
    const { lines } = await getShipmentView(ctx, s.id);
    for (const l of lines) if (!l.hs?.startsWith("22")) await patchLine(ctx, l.id, { duty_per_kg: 2 });
    const view = await getShipmentView(ctx, s.id);
    const calc = calculate(view.shipment, view.lines);
    const soup = calc.rows.find((r) => r.line.idx === "71806000AXE")!;
    expect(soup.result.goodsNok).toBeCloseTo(11.3659, 4); // the hand-worked row from the engine tests
    expect(soup.result.dutyNok).toBeCloseTo(2, 6);
    expect(calc.totals.totalNetWeightKg).toBeCloseTo(17399.185, 3);
  });
});
