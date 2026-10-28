/**
 * A declaration PDF applied to a shipment, checked against the client's finished price sheet for the same delivery
 * (Maspo 2610-EX/01/01084–01087, declaration 89492): the sheet's rows are loaded as the shipment, the declaration is
 * uploaded, and the app's duty, packaging and cost must come out as the sheet's. Client files: skipped where absent.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { MemoryDb, seedDefaults } from "./db";
import { importDeclarationPdf } from "./declaration-service";
import { calculate } from "./lines";
import { createShipment, getShipmentView, patchShipment, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";

const PKG = path.resolve(__dirname, "../../../fwter/package");
const SHEET = path.join(PKG, "A_Data_and_rules/3_last_price_sheet_Maspo_2610-EX-01-01084-01087.xlsx");
const PDF = path.join(PKG, "B_Customs_register_module5/1_example_declarations/89492.pdf");
const have = existsSync(SHEET) && existsSync(PDF);
const n = (v: unknown) => (v === "" || v === undefined || v === null ? 0 : Number(v));

function loadSheet() {
  const wb = XLSX.read(readFileSync(SHEET), { type: "buffer" });
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
  const head = grid.findIndex((r) => String(r[0]).trim() === "Art.nr");
  const col = (name: string) => (grid[head] as string[]).indexOf(name);
  const c = {
    idx: col("Art.nr"), name: col("Varenavn (faktura)"), cn: col("CN (produktark)"), origin: col("Oppr."), qty: col("Antall"), unit: col("Enhet"), pcs: col("Stk/kart"),
    value: col("Fakturaverdi PLN"), weight: col("Nettovekt totalt"), duty: col("Toll kr/kg"), pack: col("Emballasje/enhet"), vat: col("Mva"), cost: col("Kost inkl mva/enhet"),
    sug: col("Foreslått/enhet"), status: col("Shopify status"), shop: col("Shopify pris nå"), shopCase: col("Shopify kassepris nå"),
  };
  const top = (label: string) => grid.find((r) => String(r[0]).trim() === label)?.[2];
  const rows = grid.slice(head + 1).filter((r) => String(r[c.idx]).trim() && typeof r[c.qty] === "number" && (r[c.qty] as number) > 0 && typeof r[c.cost] === "number");
  return { c, rows, freight: n(top("Frakt totalt NOK")), markup: n(top("Påslag")) };
}

describe.skipIf(!have)("declaration 89492 applied to the Maspo 01084–01087 shipment", () => {
  const setup = async () => {
    const { c, rows, freight, markup } = loadSheet();
    const db = new MemoryDb();
    seedDefaults(db);
    const ctx: Ctx = { db, shopify: new FakeShopify([], {}), who: "t", log: async () => {}, now: () => new Date("2026-10-27T12:00:00Z") };
    const s = await createShipment(ctx, { name: "Maspo 01084", supplierName: "Maspo", arrivalDate: "2026-10-15" });
    // freight and markup typed as the client did; the exchange rate is left EMPTY so the declaration's rate is what fills it
    await patchShipment(ctx, s.id, { freight_amount: freight, freight_currency: "NOK", markup_value: markup });
    const lines: Array<Record<string, unknown>> = rows.map((r, i) => {
      const active = String(r[c.status]) === "ACTIVE";
      const kilo = String(r[c.unit]).toLowerCase().startsWith("k");
      return {
        id: `line-${i}`, shipment_id: s.id, invoice_id: null, position: i, currency: "PLN", idx: String(r[c.idx]).trim(), name: String(r[c.name]), unit: kilo ? "kilo" : "pcs",
        qty: n(r[c.qty]), cartons: null, country: String(r[c.origin]), ean: null, ean_box: null, hs: String(r[c.cn]) || null, hs_fixed: false, net_weight_kg: n(r[c.weight]),
        line_value: n(r[c.value]), unit_price: null, price_conflict: null, source_lines: [], issues: [], match_status: "matched", match_via: "tag", match_reason: "", match_candidates: [],
        shopify_product_id: `p${i}`, is_new: false, mva25: false, vat_rate: n(r[c.vat]), history: null, duty_per_kg: null, duty_pct: null, packaging_nok: null, duty_source: null, duty_source_kind: null,
        pcs_per_carton: n(r[c.pcs]) || 1, pcs_source: "typed", sales_unit_kg: kilo ? 1 : null, price_override: null, chosen_unit_price: null, done: false, pushed_at: null, pushed: null, push_errors: null,
        updated_at: "",
        shopify: { title: String(r[c.name]), status: active ? "ACTIVE" : "DRAFT", vendor: "", productType: active ? String(r[c.shop]) : "", variantPrice: active ? n(r[c.shopCase]) || null : null, unitCost: null, variantId: "v", variantCount: 1, inventoryItemId: null, imageUrl: null, tags: [], handle: "h", countryName: null },
      };
    });
    await db.insert("vm_lines", lines);
    return { ctx, db, s, rows, c };
  };

  it("sets the declared duty and packaging on every row and prices them like the client's sheet", async () => {
    const { ctx, s, rows, c } = await setup();
    const out = await importDeclarationPdf(ctx, { bytes: new Uint8Array(readFileSync(PDF)), name: "89492.pdf" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.report;
    console.log("DECL", r.number, r.status, "items", r.itemCount, "matched", r.matchedItems, "unmatched", r.unmatchedItems.length, "rates", JSON.stringify(r.ratesAdded), "changes", r.changes.length, "rate", r.currency, r.rate);
    expect(r.number).toBe("89492");
    expect(r.matchedItems).toBeGreaterThan(150);

    const view = await getShipmentView(ctx, s.id);
    // the declaration's exchange rate filled the empty one (box 23)
    expect(view.shipment.rates.PLN).toBeCloseTo(2.473, 3);
    const calc = calculate(view.shipment, view.lines);

    const byIdx = new Map(rows.map((x) => [String(x[c.idx]).trim(), x]));
    const dutyDiff: string[] = [];
    const packDiff: string[] = [];
    const costDiff: string[] = [];
    let untouched = 0;
    for (const row of calc.rows) {
      const sheet = byIdx.get(row.line.idx)!;
      if (row.line.duty_source_kind !== "declaration") {
        untouched++;
        continue;
      }
      if (Math.abs(Number(row.line.duty_per_kg) - n(sheet[c.duty])) > 0.011) dutyDiff.push(`${row.line.idx}: ${row.line.duty_per_kg} vs ${n(sheet[c.duty])}`);
      if (Math.abs(row.result.packagingNok - n(sheet[c.pack])) > 0.011) packDiff.push(`${row.line.idx}: ${row.result.packagingNok} vs ${n(sheet[c.pack])}`);
      if (row.result.costInclVat === null || Math.abs(row.result.costInclVat - n(sheet[c.cost])) > 0.02) costDiff.push(`${row.line.idx}: ${row.result.costInclVat?.toFixed(3)} vs ${n(sheet[c.cost]).toFixed(3)}`);
    }
    console.log("DECL rows not tied to the declaration:", untouched, "| duty differs:", dutyDiff.length, dutyDiff.slice(0, 6), "| packaging differs:", packDiff.length, packDiff.slice(0, 6), "| cost differs:", costDiff.length, costDiff.slice(0, 6));
    // The one place the sheet differs: three sausages the declaration charged 0 on (tariff quota) that the client chose to price at
    // 84 kr/kg ("never assume 0"). The app applies what was declared and lists every such sausage for that decision.
    const sausages = ["12773", "39250", "53017"];
    expect(dutyDiff.map((d) => d.split(":")[0]).sort()).toEqual(sausages);
    expect(costDiff.map((d) => d.split(":")[0]).sort()).toEqual(sausages);
    expect(packDiff).toEqual([]);
    expect(untouched).toBe(0);
    expect(sausages.every((i) => r.decisions.some((d) => d.idx === i))).toBe(true);
    // and the row shows the sausage warning, so nothing is applied unseen
    expect(calc.rows.find((x) => x.line.idx === "53017")!.warnings.some((w) => w.startsWith("Pølse (HS 1601)"))).toBe(true);
    // the report says what moved, by product
    expect(r.changes.length).toBeGreaterThan(150);
    expect(r.changes[0]).toHaveProperty("costBefore");
  }, 180_000);

  it("records the declared rates in the register, a code declared at two rates stays ambiguous, estimates are superseded", async () => {
    const { ctx, db } = await setup();
    await db.insert("vm_customs_rates", { scope: "product", cn8: null, hs6: null, supplier: "Maspo", idx: "4491", title_key: null, duty_per_kg: 1, source_kind: "estimate", source_ref: "typed by us, estimate", source_date: "2026-01-01", created_by: "t" });
    const out = await importDeclarationPdf(ctx, { bytes: new Uint8Array(readFileSync(PDF)), name: "89492.pdf" });
    expect(out.ok).toBe(true);
    const rates = await db.select<{ scope: string; supplier: string | null; idx: string | null; source_kind: string; source_ref: string }>("vm_customs_rates", {});
    expect(rates.filter((x) => x.scope === "cn8" && x.source_ref === "89492").length).toBeGreaterThan(20);
    expect(rates.some((x) => x.scope === "product" && x.idx === "4491" && x.source_kind === "declaration")).toBe(true);
    expect(rates.some((x) => x.scope === "product" && x.idx === "4491" && x.source_kind === "estimate")).toBe(false);
  }, 120_000);

  it("the same final declaration twice is refused; a draft is replaced by the next upload", async () => {
    const { ctx, db } = await setup();
    const bytes = new Uint8Array(readFileSync(PDF));
    expect((await importDeclarationPdf(ctx, { bytes, name: "89492.pdf" })).ok).toBe(true);
    await expect(importDeclarationPdf(ctx, { bytes, name: "89492.pdf" })).rejects.toThrow(/allerede registrert/);
    // pretend the first one was a draft
    await db.update("vm_declarations", { number: "eq.89492" }, { status: "draft" });
    const again = await importDeclarationPdf(ctx, { bytes, name: "89492.pdf" });
    expect(again.ok && again.report.replacedDraft).toBe(true);
    const decls = await db.select("vm_declarations", { number: "eq.89492" });
    expect(decls).toHaveLength(1);
  }, 180_000);

  it("a PDF that fails the control rule writes nothing", async () => {
    const { ctx, db } = await setup();
    const out = await importDeclarationPdf(ctx, { bytes: new Uint8Array(readFileSync(path.join(PKG, "A_Data_and_rules/9_source_files/Customs_declaration/89492_Maspo_2026-10-17.pdf"))).slice(0, 4000), name: "cut.pdf" }).catch((e: Error) => e);
    // a truncated file cannot be read at all, or fails the control: either way the register is untouched
    expect(out instanceof Error || (typeof out === "object" && "ok" in out && out.ok === false)).toBe(true);
    expect(await db.select("vm_customs_rates", {})).toHaveLength(0);
    expect(await db.select("vm_declarations", {})).toHaveLength(0);
  }, 60_000);
});

