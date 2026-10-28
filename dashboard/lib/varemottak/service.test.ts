import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDb, seedDefaults } from "./db";
import * as XLSX from "xlsx";
import { buildWorkbook } from "./export";
import { calculate } from "./lines";
import {
  createShipment,
  deleteShipment,
  getShipmentView,
  importInvoice,
  patchLine,
  patchShipment,
  planPush,
  pushLog,
  pushShipment,
  rematch,
  saveProductSettings,
  setDone,
  setMatch,
  type Ctx,
} from "./service";
import { FakeShopify } from "./shopify/fake";
import { LiveShopify } from "./shopify/live";

const FWTER = path.resolve(__dirname, "../../../fwter");
const CSV = path.join(FWTER, "000033_S33_2026_spec.csv");
const PDF = path.join(FWTER, "000033-S33-2026.pdf");
const SNAPSHOT = path.join(FWTER, "shopify-snapshot.json");
const have = existsSync(CSV) && existsSync(PDF) && existsSync(SNAPSHOT);

function makeCtx(): { ctx: Ctx; db: MemoryDb; shopify: FakeShopify } {
  const db = new MemoryDb();
  seedDefaults(db);
  const shopify = FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
  const ctx: Ctx = {
    db,
    shopify,
    who: "test@nordicengros.no",
    log: async () => {},
    now: () => new Date("2026-10-09T12:00:00Z"),
  };
  return { ctx, db, shopify };
}

const files = () => ({
  spec: { bytes: new Uint8Array(readFileSync(CSV)), name: "spec.csv" },
  pdf: { bytes: new Uint8Array(readFileSync(PDF)), name: "invoice.pdf" },
});

describe.skipIf(!have)("a full Stanro shipment, end to end (in-memory DB + fake Shopify)", () => {
  let t: ReturnType<typeof makeCtx>;
  let shipmentId: string;
  let result: Awaited<ReturnType<typeof importInvoice>>;

  beforeEach(async () => {
    t = makeCtx();
    const s = await createShipment(t.ctx, { name: "Stanro 000033", supplierName: "Stanro", arrivalDate: "2026-09-24" });
    shipmentId = s.id;
    await patchShipment(t.ctx, shipmentId, { rates: { PLN: 2.498 }, freight_amount: 3800, freight_currency: "NOK" });
    result = await importInvoice(t.ctx, shipmentId, files());
  });

  it("imports 275 raw lines as 238 products, all found in the shop", () => {
    expect(result).toMatchObject({ rawLines: 275, products: 238, invoiceNo: "000033/S33/2026", currency: "PLN" });
    expect(result.unmatched).toBe(0);
    expect(result.matched + result.doubtful).toBe(238);
  });

  it("controls the invoice: ok, with the two separate costs and the price conflict visible", async () => {
    expect(result.control.ok).toBe(true);
    expect(result.control.extraLines).toHaveLength(2);
    const view = await getShipmentView(t.ctx, shipmentId);
    const conflict = view.lines.filter((l) => l.price_conflict);
    expect(conflict.map((l) => l.idx)).toEqual(["86018000DAN"]);
  });

  it("marks DRAFTs as new and ACTIVE products as restocked, frozen at import", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    expect(lines.filter((l) => l.is_new).length).toBeGreaterThan(40);
    for (const l of lines) expect(l.is_new).toBe(l.shopify?.status !== "ACTIVE");
  });

  it("takes pieces per carton from the invoice for DRAFTs and from Shopify for ACTIVE products", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const draft = lines.find((l) => l.is_new && l.unit === "pcs" && l.pcs_source)!;
    expect(draft.pcs_source).toBe("invoice");
    const active = lines.find((l) => !l.is_new && l.pcs_source === "shopify");
    expect(active).toBeTruthy();
  });

  it("has no duty anywhere yet, so every non-drink row is blocked until it is entered", async () => {
    const { shipment, lines } = await getShipmentView(t.ctx, shipmentId);
    const calc = calculate(shipment, lines);
    const food = calc.rows.find((r) => r.line.idx === "71806000AXE")!;
    expect(food.result.flags.missingDuty).toBe(true);
    expect(food.blocked).toContain("Mangler toll");
    const drink = calc.rows.find((r) => r.result.isDrink)!;
    expect(drink.result.flags.missingDuty).toBe(false); // drinks: 0 duty + 2 kr
  });

  it("calculates a hand-checked row once duty is entered", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const soup = lines.find((l) => l.idx === "71806000AXE")!;
    await patchLine(t.ctx, soup.id, { duty_per_kg: 1 });
    const view = await getShipmentView(t.ctx, shipmentId);
    const calc = calculate(view.shipment, view.lines);
    const c = calc.rows.find((r) => r.line.idx === "71806000AXE")!;
    // goods 364 × 2.498 / 80 = 11.3659 ; duty 1 ; freight = 3800 / (sum of net weight) × 1 kg per unit
    expect(c.result.goodsNok).toBeCloseTo(11.3659, 4);
    expect(c.result.dutyNok).toBeCloseTo(1, 6);
    expect(calc.totals.totalNetWeightKg).toBeCloseTo(17399.185, 3);
    expect(c.result.freightNok).toBeCloseTo(3800 / 17399.185, 4);
  });

  it("remembers a typed duty rate, and reuses it on the next shipment as 'same product'", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const soup = lines.find((l) => l.idx === "71806000AXE")!;
    await patchLine(t.ctx, soup.id, { duty_per_kg: 3.5 });
    const s2 = await createShipment(t.ctx, { name: "Stanro 2", supplierName: "Stanro" });
    // import the same file (a different invoice number would be needed in real life; patch it)
    const bytes = new TextEncoder().encode(new TextDecoder("windows-1250").decode(readFileSync(CSV)).replaceAll("000033/S33/2026", "000034/S33/2026"));
    const again = await importInvoice(t.ctx, s2.id, { spec: { bytes, name: "spec2.csv" } });
    const view = await getShipmentView(t.ctx, s2.id);
    const row = view.lines.find((l) => l.idx === "71806000AXE")!;
    expect(row).toMatchObject({ duty_per_kg: 3.5, duty_source_kind: "estimate" }); // a typed rate is an estimate; it is remembered per product
    expect(again.control.checks[0].code).toBe("NO_PDF"); // spec only: says so
  });

  it("exports the review as an Excel file the client can sort and filter", async () => {
    const view = await getShipmentView(t.ctx, shipmentId);
    const wb = XLSX.read(buildWorkbook(view.shipment, view.invoices, view.lines), { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Varer", "Sammendrag"]);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Varer"]);
    expect(rows).toHaveLength(238);
    expect(rows[0]).toHaveProperty("Art.nr");
    expect(rows[0]).toHaveProperty("Vår pris (DIN PRIS)");
    expect(rows[0]).toHaveProperty("Kartongpris");
    expect(typeof rows.find((r) => r["Art.nr"] === "71806000AXE")!["Varekost NOK"]).toBe("number");
    const summary = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Sammendrag"], { header: 1 }) as unknown[][];
    expect(summary.flat().join(" ")).toContain("Egne forsendelseskostnader");
  });

  it("refuses to import the same invoice twice", async () => {
    await expect(importInvoice(t.ctx, shipmentId, files())).rejects.toThrow(/allerede importert/);
  });

  it("pushes done rows to the fake shop: prices, DRAFT → ACTIVE, stock and tags untouched", async () => {
    const before = t.shopify.inventorySnapshot();
    const { lines } = await getShipmentView(t.ctx, shipmentId);

    // Give every non-drink row a duty, settle the price conflict, then mark everything done.
    for (const l of lines) {
      if (!l.hs?.startsWith("22")) await patchLine(t.ctx, l.id, { duty_per_kg: 2 });
      if (l.price_conflict) await patchLine(t.ctx, l.id, { chosen_unit_price: 5.99 });
    }
    await setDone(t.ctx, shipmentId, lines.map((l) => l.id), true);

    const dry = await pushShipment(t.ctx, shipmentId, { dryRun: true });
    expect(dry.mode).toBe("dry-run");
    expect(dry.requests!.length).toBeGreaterThan(0);
    expect(t.shopify.calls).toHaveLength(0); // a dry run sends nothing

    // Margin warnings (and similar) must be acknowledged before a real push.
    const unacked = await pushShipment(t.ctx, shipmentId, { dryRun: false });
    expect(unacked.sent).toBe(0);
    expect(unacked.needsAcknowledgement.length + unacked.blocked.length).toBeGreaterThan(0);
    expect(t.shopify.calls).toHaveLength(0);

    const out = await pushShipment(t.ctx, shipmentId, { dryRun: false, acknowledgeWarnings: true });
    expect(out.mode).toBe("fake");
    expect(out.sent).toBeGreaterThan(150);
    expect(out.failed).toBe(0);
    expect(t.shopify.calls.every((c) => c.length <= 20)).toBe(true);

    // The shop moved only on price fields and status.
    const after = t.shopify.inventorySnapshot();
    expect(after.stock).toEqual(before.stock);
    expect(after.tags).toEqual(before.seededTags);
    const pushed = (await getShipmentView(t.ctx, shipmentId)).lines.filter((l) => l.pushed_at);
    expect(pushed).toHaveLength(out.succeeded);
    for (const l of pushed.slice(0, 40)) {
      const p = t.shopify.get(l.shopify_product_id!)!;
      expect(p.productType).toBe(l.pushed!.productType);
      expect(p.variantPrice).toBe(Number(l.pushed!.casePrice));
      expect(p.status).toBe("ACTIVE");
    }

    // Every row is in the log with who, what was sent and what it replaced.
    const log = await pushLog(t.ctx, shipmentId);
    expect(log.some((e) => e.mode === "fake" && e.by_user === "test@nordicengros.no" && e.previous)).toBe(true);
    expect(log.some((e) => e.mode === "dry-run")).toBe(false); // a preview is not an event
  });

  it("never changes the price of an ACTIVE product whose own prices do not multiply out (loose goods priced per kg)", async () => {
    // Wawel Advocaat pralines: productType 140 per kg, variant price 336 for the 2.4 kg box.
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const wawel = lines.find((l) => l.idx === "47342000WAW")!;
    const product = t.shopify.get(wawel.shopify_product_id!)!;
    product.status = "ACTIVE";
    product.productType = "140";
    product.variantPrice = 336;
    await t.ctx.db.update(
      "vm_lines",
      { id: `eq.${wawel.id}` },
      { shopify: { ...wawel.shopify, status: "ACTIVE", productType: "140", variantPrice: 336 }, pcs_per_carton: 1, sales_unit_kg: 2.4 },
    );
    await patchLine(t.ctx, wawel.id, { duty_per_kg: 2 });
    await setDone(t.ctx, shipmentId, [wawel.id], true);
    const plan = await planPush(t.ctx, shipmentId);
    const row = plan.rows.find((r) => r.lineId === wawel.id)!;
    expect(row.warnings.join()).toContain("beholdes uendret");
    expect(row.update).toMatchObject({ productType: "140", casePrice: "336.00" });
    await pushShipment(t.ctx, shipmentId, { dryRun: false, acknowledgeWarnings: true });
    expect(t.shopify.get(wawel.shopify_product_id!)).toMatchObject({ productType: "140", variantPrice: 336 });
  });

  it("blocks a doubtful match until the operator confirms it", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const l = lines.find((x) => x.match_status === "matched" && x.unit === "pcs" && x.pcs_per_carton && !x.hs?.startsWith("22") && !x.price_conflict)!;
    await t.ctx.db.update("vm_lines", { id: `eq.${l.id}` }, { match_status: "doubtful", match_reason: "Varenummeret passer, men ingenting annet" });
    await patchLine(t.ctx, l.id, { duty_per_kg: 2 });
    await setDone(t.ctx, shipmentId, [l.id], true);
    let plan = await planPush(t.ctx, shipmentId);
    let row = plan.rows.find((r) => r.lineId === l.id)!;
    expect(row.blocked.join()).toContain("Usikker kobling");
    expect(row.update).toBeNull();
    // Confirming the product (picking it) makes it a certain match.
    await setMatch(t.ctx, l.id, l.shopify_product_id!);
    plan = await planPush(t.ctx, shipmentId);
    row = plan.rows.find((r) => r.lineId === l.id)!;
    expect(row.blocked.join()).not.toContain("Usikker");
    expect(row.update).not.toBeNull();
  });

  it("blocks two rows that point at the same Shopify product", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const [a, b] = lines.filter((x) => x.match_status === "matched" && x.unit === "pcs" && x.pcs_per_carton && !x.hs?.startsWith("22") && !x.price_conflict);
    await setMatch(t.ctx, b.id, a.shopify_product_id!); // a wrong pick: b now shares the product of a
    for (const l of [a, b]) await patchLine(t.ctx, l.id, { duty_per_kg: 2 });
    await setDone(t.ctx, shipmentId, [a.id, b.id], true);
    const plan = await planPush(t.ctx, shipmentId);
    for (const id of [a.id, b.id]) {
      const row = plan.rows.find((r) => r.lineId === id)!;
      expect(row.blocked.join()).toContain("Samme Shopify-produkt");
      expect(row.update).toBeNull();
    }
  });

  it("asks the operator to acknowledge a missing freight amount and arrival date before a real push", async () => {
    const s2 = await createShipment(t.ctx, { name: "No freight", supplierName: "Stanro" }); // no arrival date, no freight
    await patchShipment(t.ctx, s2.id, { rates: { PLN: 2.498 } });
    const bytes = new TextEncoder().encode(new TextDecoder("windows-1250").decode(readFileSync(CSV)).replaceAll("000033/S33/2026", "000077/S33/2026"));
    await importInvoice(t.ctx, s2.id, { spec: { bytes, name: "s.csv" } }).catch(() => {});
    // the same invoice (000033) already exists in the first shipment, so import a renumbered copy instead
    const v = await getShipmentView(t.ctx, s2.id);
    expect(v.lines.length).toBeGreaterThan(0);
    const l = v.lines.find((x) => x.match_status === "matched" && x.unit === "pcs" && x.pcs_per_carton && !x.hs?.startsWith("22") && !x.price_conflict)!;
    await patchLine(t.ctx, l.id, { duty_per_kg: 2, price_override: 40 });
    await setDone(t.ctx, s2.id, [l.id], true);
    const first = await pushShipment(t.ctx, s2.id, { dryRun: false });
    expect(first.sent).toBe(0);
    expect(first.shipmentWarnings.join()).toContain("Frakt er ikke lagt inn");
    expect(first.shipmentWarnings.join()).toContain("Ankomstdato mangler");
    const second = await pushShipment(t.ctx, s2.id, { dryRun: false, acknowledgeWarnings: true });
    expect(second.sent).toBe(1);
  });

  it("never builds a filter long enough for a gateway to refuse the URL (long in-lists are chunked)", async () => {
    // PostgREST filters travel in the URL; ~8 KB request lines are refused. Watch every call.
    let longest = 0;
    const watch = (params: Record<string, unknown> | undefined) => {
      for (const v of Object.values(params ?? {})) longest = Math.max(longest, String(v).length);
    };
    const inner = t.ctx.db;
    const probe = {
      select: (tb: string, p?: Record<string, never>) => (watch(p), inner.select(tb, p)),
      insert: inner.insert.bind(inner),
      update: (tb: string, p: Record<string, never>, patch: object) => (watch(p), inner.update(tb, p, patch)),
      remove: (tb: string, p: Record<string, never>) => (watch(p), inner.remove(tb, p)),
    } as unknown as Ctx["db"];
    const ctx2 = { ...t.ctx, db: probe };
    const s2 = await createShipment(ctx2, { name: "Long lists", supplierName: "Stanro" });
    const bytes = new TextEncoder().encode(new TextDecoder("windows-1250").decode(readFileSync(CSV)).replaceAll("000033/S33/2026", "000099/S33/2026"));
    await importInvoice(ctx2, s2.id, { spec: { bytes, name: "long.csv" } });
    const view = await getShipmentView(ctx2, s2.id);
    expect(view.lines.length).toBe(238);
    expect(await setDone(ctx2, s2.id, view.lines.map((l) => l.id), true)).toBe(238); // all of them, in several requests
    expect(longest).toBeLessThan(3000);
  });

  it("the push log records what each product looked like BEFORE the push, so it can be undone by hand", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const l = lines.find((x) => !x.is_new && x.match_status === "matched" && x.unit === "pcs" && x.pcs_per_carton && !x.hs?.startsWith("22") && !x.price_conflict)!;
    const before = { productType: t.shopify.get(l.shopify_product_id!)!.productType, variantPrice: t.shopify.get(l.shopify_product_id!)!.variantPrice, unitCost: t.shopify.get(l.shopify_product_id!)!.unitCost };
    await patchLine(t.ctx, l.id, { duty_per_kg: 2, price_override: 77 });
    await setDone(t.ctx, shipmentId, [l.id], true);
    await pushShipment(t.ctx, shipmentId, { dryRun: false, acknowledgeWarnings: true });
    const after = t.shopify.get(l.shopify_product_id!)!;
    expect(after.productType).toBe("77"); // it really changed…
    const entry = (await pushLog(t.ctx, shipmentId))[0] as { previous: typeof before; request: { productType: string } };
    expect(entry.previous).toMatchObject(before); // …and the log kept the old values, not the new ones
    expect(entry.request.productType).toBe("77");

    // a second push logs the first push's values as "before"
    await patchLine(t.ctx, l.id, { price_override: 80 });
    await pushShipment(t.ctx, shipmentId, { dryRun: false, acknowledgeWarnings: true });
    const second = (await pushLog(t.ctx, shipmentId))[0] as { previous: { productType: string } };
    expect(second.previous.productType).toBe("77");
  });

  it("a second push carries only rows edited since — never the whole shipment again", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const pick = lines.filter((l) => l.match_status === "matched" && l.unit === "pcs" && l.pcs_per_carton && !l.hs?.startsWith("22") && !l.price_conflict).slice(0, 3);
    for (const l of pick) await patchLine(t.ctx, l.id, { duty_per_kg: 2, price_override: 40 });
    await setDone(t.ctx, shipmentId, pick.map((l) => l.id), true);
    const first = await pushShipment(t.ctx, shipmentId, { dryRun: false, acknowledgeWarnings: true });
    expect(first.succeeded).toBe(3);

    // Nothing changed: nothing to send.
    expect((await pushShipment(t.ctx, shipmentId, { dryRun: true })).requested).toBe(0);
    const calls = t.shopify.calls.length;
    expect((await pushShipment(t.ctx, shipmentId, { dryRun: false, acknowledgeWarnings: true })).sent).toBe(0);
    expect(t.shopify.calls.length).toBe(calls); // not a single request went out

    // Correct one price: only that row goes again.
    await patchLine(t.ctx, pick[1].id, { price_override: 45 });
    const again = await pushShipment(t.ctx, shipmentId, { dryRun: false, acknowledgeWarnings: true });
    expect(again).toMatchObject({ requested: 1, sent: 1, succeeded: 1 });
    expect(t.shopify.get(pick[1].shopify_product_id!)).toMatchObject({ productType: "45" });
    expect(t.shopify.get(pick[0].shopify_product_id!)).toMatchObject({ productType: "40" });
    // …and a changed cost counts as a change too (e.g. a customs declaration arrived).
    await patchLine(t.ctx, pick[2].id, { duty_per_kg: 9 });
    expect((await pushShipment(t.ctx, shipmentId, { dryRun: true })).requested).toBe(1);
  });

  it("refuses a PDF in the spec field, and says what to do", async () => {
    const s2 = await createShipment(t.ctx, { name: "PDF as spec", supplierName: "Stanro" });
    const pdf = new Uint8Array(readFileSync(PDF));
    await expect(importInvoice(t.ctx, s2.id, { spec: { bytes: pdf, name: "invoice.pdf" } })).rejects.toThrow(/er en PDF/);
  });

  it("says when a file is not a Stanro spec instead of an obscure column error", async () => {
    const s2 = await createShipment(t.ctx, { name: "Wrong file", supplierName: "Stanro" });
    await expect(importInvoice(t.ctx, s2.id, { spec: { bytes: new TextEncoder().encode("a,b,c\n1,2,3\n"), name: "x.csv" } })).rejects.toThrow(/ikke ut som Stanro/);
  });

  it("moves the shipment through its statuses: draft → review (import) → pushed (everything sent)", async () => {
    expect((await getShipmentView(t.ctx, shipmentId)).shipment.status).toBe("review"); // imported in beforeEach
    const s2 = await createShipment(t.ctx, { name: "Tiny", supplierName: "Stanro" });
    expect(s2.status).toBe("draft");
    await patchShipment(t.ctx, s2.id, { rates: { PLN: 2.5 }, freight_amount: 100, arrival_date: "2026-10-01" });
    const header = new TextDecoder("windows-1250").decode(readFileSync(CSV)).split(/\r?\n/);
    const row = header.find((r) => r.includes("71806000AXE"))!.replace("000033/S33/2026", "000090/S33/2026");
    await importInvoice(t.ctx, s2.id, { spec: { bytes: new TextEncoder().encode(`${header[0]}\n${row}\n`), name: "t.csv" } });
    expect((await getShipmentView(t.ctx, s2.id)).shipment.status).toBe("review");
    const only = (await getShipmentView(t.ctx, s2.id)).lines[0];
    await patchLine(t.ctx, only.id, { duty_per_kg: 2 });
    await setDone(t.ctx, s2.id, [only.id], true);
    await pushShipment(t.ctx, s2.id, { dryRun: false, acknowledgeWarnings: true });
    expect((await getShipmentView(t.ctx, s2.id)).shipment.status).toBe("pushed");
  });

  it("deletes an unsent shipment and its rows, but never one that has been pushed", async () => {
    const s2 = await createShipment(t.ctx, { name: "Throwaway", supplierName: "Stanro" });
    await deleteShipment(t.ctx, s2.id);
    await expect(getShipmentView(t.ctx, s2.id)).rejects.toThrow(/Fant ikke/);
    // the main shipment has nothing pushed yet: deletable, and frees its invoice number for a re-import
    await deleteShipment(t.ctx, shipmentId);
    const s3 = await createShipment(t.ctx, { name: "Again", supplierName: "Stanro" });
    await expect(importInvoice(t.ctx, s3.id, files())).resolves.toBeTruthy();
    // push one row of the new shipment, then it can no longer be deleted
    const { lines } = await getShipmentView(t.ctx, s3.id);
    const l = lines.find((x) => x.match_status === "matched" && x.unit === "pcs" && x.pcs_per_carton && !x.hs?.startsWith("22") && !x.price_conflict)!;
    await patchShipment(t.ctx, s3.id, { rates: { PLN: 2.5 }, freight_amount: 10, arrival_date: "2026-10-01" });
    await patchLine(t.ctx, l.id, { duty_per_kg: 2, price_override: 30 });
    await setDone(t.ctx, s3.id, [l.id], true);
    await pushShipment(t.ctx, s3.id, { dryRun: false, acknowledgeWarnings: true });
    await expect(deleteShipment(t.ctx, s3.id)).rejects.toThrow(/sendte varer/);
  });

  it("refuses the same invoice number in a second shipment from the same supplier", async () => {
    const s2 = await createShipment(t.ctx, { name: "Duplicate", supplierName: "Stanro" });
    await expect(importInvoice(t.ctx, s2.id, files())).rejects.toThrow(/allerede importert i forsendelsen/);
  });

  it("allows the same invoice number for a different supplier", async () => {
    const s2 = await createShipment(t.ctx, { name: "Other", supplierName: "Leis" });
    const csv = "Art.nr,Description,Quantity,Value,Invoice number\nX1,Thing,10,50,000033/S33/2026";
    await expect(importInvoice(t.ctx, s2.id, { spec: { bytes: new TextEncoder().encode(csv), name: "x.csv" }, currency: "EUR" })).resolves.toBeTruthy();
  });

  it("re-push corrects a price and does not touch status again", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const draft = lines.find((l) => l.is_new && l.unit === "pcs" && l.pcs_per_carton && l.match_status === "matched" && !l.hs?.startsWith("22") && !l.price_conflict)!;
    await patchLine(t.ctx, draft.id, { duty_per_kg: 2, price_override: 40 });
    await setDone(t.ctx, shipmentId, [draft.id], true);
    await pushShipment(t.ctx, shipmentId, { dryRun: false, acknowledgeWarnings: true });
    expect(t.shopify.get(draft.shopify_product_id!)).toMatchObject({ status: "ACTIVE", productType: "40" });

    await patchLine(t.ctx, draft.id, { price_override: 42.5 });
    const second = await pushShipment(t.ctx, shipmentId, { dryRun: false, acknowledgeWarnings: true });
    expect(second.succeeded).toBe(1);
    expect(t.shopify.get(draft.shopify_product_id!)).toMatchObject({ status: "ACTIVE", productType: "42,5" });
    expect(t.shopify.calls.at(-1)![0].activate).toBe(false);
  });

  it("shows Shopify errors per row and keeps the row unsent", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const target = lines.find((l) => l.match_status === "matched" && l.unit === "pcs" && l.pcs_per_carton && !l.hs?.startsWith("22") && !l.price_conflict)!;
    t.shopify.get(target.shopify_product_id!)!.title += " FAKE_ERROR";
    await patchLine(t.ctx, target.id, { duty_per_kg: 2 });
    await setDone(t.ctx, shipmentId, [target.id], true);
    const out = await pushShipment(t.ctx, shipmentId, { dryRun: false, acknowledgeWarnings: true });
    expect(out.failed).toBe(1);
    expect(out.errors[0].userErrors[0].message).toContain("Simulated");
    const row = (await getShipmentView(t.ctx, shipmentId)).lines.find((l) => l.id === target.id)!;
    expect(row.pushed_at).toBeNull();
    expect(row.push_errors?.[0].message).toContain("Simulated");
  });

  it("blocks rows that cannot be sent and says why", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    await setDone(t.ctx, shipmentId, [lines[0].id], true); // no duty entered
    const plan = await planPush(t.ctx, shipmentId);
    const row = plan.rows.find((r) => r.lineId === lines[0].id)!;
    if (!lines[0].hs?.startsWith("22")) expect(row.blocked).toContain("Mangler toll");
    expect(row.update).toBeNull();
  });

  it("does not push rows that are not marked done", async () => {
    const out = await pushShipment(t.ctx, shipmentId, { dryRun: true });
    expect(out.requested).toBe(0);
  });

  it("picking a product by hand is remembered: the next import matches it by link", async () => {
    // Detach one row, then pick the product for it.
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const l = lines.find((x) => x.match_status === "matched" && x.shopify_product_id)!;
    await t.ctx.db.update("vm_lines", { id: `eq.${l.id}` }, { match_status: "unmatched", match_via: "none", shopify_product_id: null, shopify: null });
    const set = await setMatch(t.ctx, l.id, l.shopify_product_id!);
    expect(set).toMatchObject({ match_status: "matched", match_via: "link" });
    const links = await t.ctx.db.select("vm_supplier_links");
    expect(links).toHaveLength(1);
  });

  it("'Match again' picks up tags the coworker added after the import", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const l = lines.find((x) => x.match_status === "matched")!;
    const p = t.shopify.get(l.shopify_product_id!)!;
    const removed = p.tags.filter((tag) => tag.toLowerCase() === l.idx.toLowerCase());
    p.tags = p.tags.filter((tag) => !removed.includes(tag));
    await t.ctx.db.update("vm_lines", { id: `eq.${l.id}` }, { match_status: "unmatched", match_via: "none", shopify_product_id: null, shopify: null });
    expect((await rematch(t.ctx, shipmentId)).nowMatched).toBe(0); // tag gone → still unmatched
    p.tags.push(...removed);
    expect((await rematch(t.ctx, shipmentId)).nowMatched).toBe(1);
  });

  it("duty can be a percentage of value: one basis at a time, remembered for the product, packaging can be typed", async () => {
    const view = await getShipmentView(t.ctx, shipmentId);
    const line = view.lines.find((l) => l.unit === "pcs" && l.match_status === "matched")!;
    const pct = await patchLine(t.ctx, line.id, { duty_pct: 0.19 });
    expect(Number(pct.duty_pct)).toBe(0.19);
    expect(pct.duty_per_kg).toBeNull();
    expect(pct.duty_source).toMatch(/prosent av verdi/);
    // typing kr/kg afterwards replaces the percentage
    const perKg = await patchLine(t.ctx, line.id, { duty_per_kg: 2 });
    expect(Number(perKg.duty_per_kg)).toBe(2);
    expect(perKg.duty_pct).toBeNull();
    // the percentage is remembered as the product's estimate and found again by the lookup
    await patchLine(t.ctx, line.id, { duty_pct: 0.19 });
    const rates = await t.ctx.db.select<{ idx: string; duty_pct: number | null; source_kind: string }>("vm_customs_rates", { scope: "eq.product", idx: `eq.${line.idx}` });
    expect(rates).toHaveLength(1);
    expect(Number(rates[0].duty_pct)).toBe(0.19);
    // out of range is refused
    await expect(patchLine(t.ctx, line.id, { duty_pct: 1.5 })).rejects.toThrow(/0 og 100/);
    // packaging typed on the row
    const pack = await patchLine(t.ctx, line.id, { packaging_nok: 2.05 });
    expect(Number(pack.packaging_nok)).toBe(2.05);
    expect((await patchLine(t.ctx, line.id, { packaging_nok: "" })).packaging_nok).toBeNull();
  });

  it("remembers a kg product's box size per product", async () => {
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const kg = lines.find((l) => l.unit === "kilo" && l.shopify_product_id)!;
    await patchLine(t.ctx, kg.id, { sales_unit_kg: 1.5 });
    await saveProductSettings(t.ctx, kg.shopify_product_id!, { gp_code: "1017" }); // must not blank the box size
    const settings = await t.ctx.db.select<{ sales_unit_kg: number; gp_code: string }>("vm_product_settings");
    expect(settings[0]).toMatchObject({ sales_unit_kg: 1.5, gp_code: "1017" });
  });

  it("compares with the previous purchase: price up while our shop price is unchanged", async () => {
    // Complete the first shipment's history (cost + our price), then import a dearer one.
    const { lines } = await getShipmentView(t.ctx, shipmentId);
    const target = lines.find((l) => !l.is_new && l.match_status === "matched" && !l.hs?.startsWith("22") && !l.price_conflict && l.shopify!.productType && l.qty >= 10 && l.line_value)!;
    await t.ctx.db.update("vm_price_history", { shipment_id: `eq.${shipmentId}`, idx: `eq.${target.idx}` }, { our_price: Number(target.shopify!.productType.replace(",", ".")) });

    const text = new TextDecoder("windows-1250").decode(readFileSync(CSV)).replaceAll("000033/S33/2026", "000040/S33/2026");
    const rows = text.split(/\r?\n/).map((row) => {
      const f = row.split(";");
      if (f[1]?.includes(target.idx)) f[10] = String((Number(target.line_value) * 1.2).toFixed(2)).replace(".", ","); // +20 %
      return f.join(";");
    });
    const s2 = await createShipment(t.ctx, { name: "Stanro dearer", supplierName: "Stanro" });
    await importInvoice(t.ctx, s2.id, { spec: { bytes: new TextEncoder().encode(rows.join("\n")), name: "s2.csv" } });
    const row = (await getShipmentView(t.ctx, s2.id)).lines.find((l) => l.idx === target.idx)!;
    expect(row.history!.change.direction).toBe("up");
    expect(row.history!.change.changePct).toBeCloseTo(0.2, 1);
    expect(row.history!.change.raisedWhileOurPriceUnchanged).toBe(true);
  });
});

describe("a mixed-currency shipment", () => {
  it("converts each invoice with its own rate and the freight with the freight currency's rate", async () => {
    if (!have) return;
    const t = makeCtx();
    const s = await createShipment(t.ctx, { name: "Mixed", supplierName: "Leis" });
    await patchShipment(t.ctx, s.id, { rates: { EUR: 11, PLN: 2.5 }, freight_amount: 2400, freight_currency: "EUR" });
    const csv = "Art.nr,Description,Quantity,Unit,Value,Country,HS code,Net weight\n105080,Duru Black Beans 12 x 1kg,120,pcs,360,TR,07133390,120";
    await importInvoice(t.ctx, s.id, { spec: { bytes: new TextEncoder().encode(csv), name: "leis.csv" }, currency: "EUR" });
    const view = await getShipmentView(t.ctx, s.id);
    const c = calculate(view.shipment, view.lines);
    expect(c.totals.freightNok).toBe(26400); // 2400 EUR × 11
    expect(c.rows[0].input.rateToNok).toBe(11);
    expect(c.rows[0].result.goodsNok).toBeCloseTo((360 * 11) / 120, 6);
  });

  it("refuses an import in a currency that has no rate set when the screen is used", async () => {
    if (!have) return;
    const t = makeCtx();
    const s = await createShipment(t.ctx, { name: "NoRate", supplierName: "Leis" });
    const csv = "Art.nr,Description,Quantity,Value\nX1,Thing,10,50";
    await importInvoice(t.ctx, s.id, { spec: { bytes: new TextEncoder().encode(csv), name: "x.csv" }, currency: "EUR" });
    const view = await getShipmentView(t.ctx, s.id);
    const c = calculate(view.shipment, view.lines);
    expect(c.rows[0].blocked.join()).toContain("Mangler kurs for EUR");
  });
});

describe("the live store is never written to by default", () => {
  it("pushShipment against the live port throws before sending anything", async () => {
    if (!have) return;
    const t = makeCtx();
    const live = new LiveShopify();
    // Reads would hit the network, so wrap: reuse the fake for reads, the live class for the write guard.
    const ctx: Ctx = { ...t.ctx, shopify: Object.assign(Object.create(t.shopify), { mode: "live", pushBatch: live.pushBatch.bind(live) }) as Ctx["shopify"] };
    const s = await createShipment(ctx, { name: "Guard", supplierName: "Stanro" });
    await patchShipment(ctx, s.id, { rates: { PLN: 2.498 }, freight_amount: 0 });
    await importInvoice(ctx, s.id, files());
    const { lines } = await getShipmentView(ctx, s.id);
    for (const l of lines.slice(0, 5)) {
      await patchLine(ctx, l.id, { duty_per_kg: 2, price_override: 99, chosen_unit_price: l.price_conflict ? 5.99 : null });
    }
    await setDone(ctx, s.id, lines.slice(0, 5).map((l) => l.id), true);
    delete process.env.VAREMOTTAK_LIVE_WRITES;
    await expect(pushShipment(ctx, s.id, { dryRun: false, acknowledgeWarnings: true })).rejects.toThrow(/avslått/);
  });
});
