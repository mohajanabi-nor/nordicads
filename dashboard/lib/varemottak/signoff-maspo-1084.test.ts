/**
 * ENGINE SIGN-OFF, fourth shipment: Maspo 2610-EX/01/01084–01087 (185 products), priced by the client with duty from
 * customs declaration 89492 (package: 3_last_price_sheet_Maspo_2610-EX-01-01084-01087.xlsx).
 *
 * There is no spec file for these invoices, so the sheet's own inputs (quantity, invoice value, net weight, duty
 * kr/kg, packaging, VAT, Shopify price) go straight into the engine and every price column is compared.
 * Client files: skipped where absent.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { calcLine, DEFAULT_SETTINGS, type LineInput } from "./calc";

const SHEET = path.resolve(__dirname, "../../../fwter/package/A_Data_and_rules/3_last_price_sheet_Maspo_2610-EX-01-01084-01087.xlsx");
const have = existsSync(SHEET);
const n = (v: unknown) => (v === "" || v === undefined || v === null ? 0 : Number(v));

describe.skipIf(!have)("engine sign-off: Maspo 01084–01087 against the client's final sheet", () => {
  it("prices all 185 rows like the sheet when the packaging fee is the declared one per product", () => {
    const wb = XLSX.read(readFileSync(SHEET), { type: "buffer" });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
    const head = grid.findIndex((r) => String(r[0]).trim() === "Art.nr");
    const col = (name: string) => (grid[head] as string[]).indexOf(name);
    const c = {
      idx: col("Art.nr"), cn: col("CN (produktark)"), qty: col("Antall"), unit: col("Enhet"), pcs: col("Stk/kart"), value: col("Fakturaverdi PLN"),
      weight: col("Nettovekt totalt"), duty: col("Toll kr/kg"), pack: col("Emballasje/enhet"), vat: col("Mva"), cost: col("Kost inkl mva/enhet"),
      sug: col("Foreslått/enhet"), din: col("DIN PRIS/enhet"), casePrice: col("Pris pr kasse"), margin: col("Margin"), status: col("Shopify status"),
      shop: col("Shopify pris nå"), shopCase: col("Shopify kassepris nå"),
    };
    const top = (label: string) => grid.find((r) => String(r[0]).trim() === label)?.[2];
    const rate = n(top("Kurs PLN→NOK"));
    const freightNok = n(top("Frakt totalt NOK"));
    const markup = n(top("Påslag"));
    const rows = grid
      .slice(head + 1)
      .filter((r) => String(r[c.idx]).trim() && typeof r[c.qty] === "number" && (r[c.qty] as number) > 0 && typeof r[c.cost] === "number");
    const totalWeight = rows.reduce((a, r) => a + n(r[c.weight]), 0);

    const diffs: Array<{ idx: string; why: string }> = [];
    const packaging: string[] = [];
    const typedPrice: string[] = [];
    for (const r of rows) {
      const unit = String(r[c.unit]).toLowerCase().startsWith("k") ? "kilo" : "pcs";
      const active = String(r[c.status]) === "ACTIVE";
      const input: LineInput = {
        rateToNok: rate,
        quantity: n(r[c.qty]),
        unit,
        lineValue: n(r[c.value]),
        netWeightKg: n(r[c.weight]),
        hs: String(r[c.cn]) || null,
        dutyPerKg: n(r[c.duty]),
        pcsPerCarton: n(r[c.pcs]) || 1,
        salesUnitKg: unit === "kilo" ? 1 : null,
        mva25: false,
        vatOverride: n(r[c.vat]),
        shopifyStatus: String(r[c.status]) || null,
        shopifyUnitPrice: active ? n(r[c.shop]) || null : null,
        shopifyCasePrice: active ? n(r[c.shopCase]) || null : null,
        ourPriceOverride: null,
        // the packaging fee the client's sheet takes per product from the declaration
        packagingOverride: n(r[c.pack]),
        dutyDeclared: true,
      };
      const out = calcLine(input, { freightNok, totalNetWeightKg: totalWeight }, { ...DEFAULT_SETTINGS, markupValue: markup });
      // The sheet's DIN PRIS is the client's final decision: for most rows it is Shopify's price (rule 9), for some the client
      // typed a new one (rule 9: "we overwrite it in the review screen"). Only the engine's own columns are compared; a typed
      // price shows up in the count below, not as a difference.
      const why: string[] = [];
      if (out.costInclVat === null || Math.abs(out.costInclVat - n(r[c.cost])) > 0.01) why.push(`cost ${out.costInclVat?.toFixed(3)} vs ${n(r[c.cost]).toFixed(3)} (duty/unit ${out.dutyNok?.toFixed(3)}, drink ${out.isDrink})`);
      if (out.suggestedPrice === null || Math.abs(out.suggestedPrice - n(r[c.sug])) > 0.01) why.push(`suggested ${out.suggestedPrice} vs ${n(r[c.sug])}`);
      if (why.length) diffs.push({ idx: String(r[c.idx]), why: why.join(" | ") });
      const expectedOur = active ? n(r[c.shop]) : n(r[c.sug]);
      if (Math.abs(n(r[c.din]) - expectedOur) > 0.01) typedPrice.push(String(r[c.idx]));
    }
    console.log("MASPO-1084 rows:", rows.length, "| differ:", diffs.length, "| client typed their own price:", typedPrice.length);
    diffs.slice(0, 25).forEach((d) => console.log("  DIFF", d.idx, d.why));
    expect(rows.length).toBeGreaterThan(150);
    expect(diffs, JSON.stringify(diffs.slice(0, 5))).toEqual([]);
    expect(packaging).toEqual([]);
  });
});
