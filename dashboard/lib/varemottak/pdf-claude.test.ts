import { describe, expect, it } from "vitest";
import { MemoryDb, seedDefaults } from "./db";
import { controlInvoice } from "./invoice-control";
import { createShipment, getShipmentView, importInvoice, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";
import { mapExtraction } from "./suppliers/pdf-claude";

const opts = { supplier: "Leis", currency: "EUR" };

const good = {
  invoice_no: "LS-2026-77",
  invoice_date: "2026-10-01",
  currency: "EUR",
  net_total: 1034.5,
  vat_total: 70.19,
  net_weight_kg: 220.5,
  lines: [
    [1, "101397", "Kobra Sauce with Horseradish 280ml", 100, "pcs", 2.5, 250, "21039090", "pl", 30, 10],
    [2, "104360", "Kobra Extra Hot 280ml", 100, "pcs", 2.5, 250, "21039090", "PL", 30, 10],
    [3, "106882", "Green Peas 720ml", 200, "pcs", "1,52", "304,00", "20054000", "PL", 150, 20],
  ],
  services: [["Transport", 200.5], ["Pallets", 30]],
};

describe("mapExtraction", () => {
  it("maps compact lines to invoice lines", () => {
    const { parsed, totals } = mapExtraction(JSON.stringify(good), "m", opts);
    expect(parsed.invoiceNo).toBe("LS-2026-77");
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.lines[0]).toMatchObject({ idx: "101397", qty: 100, unit: "pcs", lineValue: 250, country: "PL", hs: "21039090", netWeightKg: 30, cartons: 10 });
    expect(parsed.lines[2]).toMatchObject({ lineValue: 304 }); // "304,00" read as a number
    expect(totals).toMatchObject({ currency: "EUR", netTotal: 1034.5, vatTotal: 70.19, invoiceDate: "2026-10-01" });
  });

  it("tells the operator the lines were read by AI", () => {
    expect(mapExtraction(JSON.stringify(good), "m", opts).parsed.warnings[0]).toContain("AI");
  });

  it("treats services as separate shipment costs", () => {
    const { totals } = mapExtraction(JSON.stringify(good), "m", opts);
    expect(totals.extraLines.map((e) => [e.name, e.value])).toEqual([["Transport", 200.5], ["Pallets", 30]]);
  });

  it("accepts a fenced JSON answer", () => {
    expect(mapExtraction("```json\n" + JSON.stringify(good) + "\n```", "m", opts).parsed.lines).toHaveLength(3);
  });

  it("refuses a cut-off answer instead of importing half an invoice", () => {
    const cut = JSON.stringify(good).slice(0, 300);
    expect(() => mapExtraction(cut, "m", opts)).toThrow(/avkortet eller ugyldig/);
  });

  it("refuses lines without an article number — they could never match a product", () => {
    const bad = { ...good, lines: [...good.lines, [4, null, "Mystery item", 5, "pcs", 1, 5, null, null, null, null]] };
    expect(() => mapExtraction(JSON.stringify(bad), "m", opts)).toThrow(/Linje 4 har ikke varenummer/);
  });

  it("refuses a currency that differs from the one the operator gave", () => {
    expect(() => mapExtraction(JSON.stringify({ ...good, currency: "PLN" }), "m", opts)).toThrow(/Valutaen i PDF-en \(PLN\)/);
  });

  it("drops a line with an unreadable quantity and says so", () => {
    const odd = { ...good, lines: [...good.lines, [5, "X9", "No qty", "n/a", "pcs", 1, 1, null, null, null, null]] };
    const { parsed } = mapExtraction(JSON.stringify(odd), "m", opts);
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.warnings.join()).toContain("Linje 5");
  });

  it("fails clearly on an invoice with no lines", () => {
    expect(() => mapExtraction(JSON.stringify({ ...good, lines: [] }), "m", opts)).toThrow(/ingen varelinjer/);
  });
});

describe("invoice control over a PDF-only read", () => {
  const sum = (g: typeof good) => g.lines.reduce((a, l) => a + Number(String(l[6]).replace(",", ".")), 0) + g.services.reduce((a, s) => a + (s[1] as number), 0);

  it("passes when lines + services equal the printed total", () => {
    const g = { ...good, net_total: sum(good) };
    const { parsed, totals } = mapExtraction(JSON.stringify(g), "m", opts);
    const r = controlInvoice(parsed, totals);
    expect(r.ok).toBe(true);
    expect(r.extraValue).toBe(230.5);
  });

  it("catches a line the model dropped", () => {
    const g = { ...good, net_total: sum(good) };
    const dropped = { ...g, lines: g.lines.slice(0, 2) }; // third line lost
    const { parsed, totals } = mapExtraction(JSON.stringify(dropped), "m", opts);
    const r = controlInvoice(parsed, { ...totals, netTotal: sum(good) });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.code === "TOTAL")?.severity).toBe("block");
  });

  it("warns about VAT the supplier charged on an export invoice", () => {
    const { parsed, totals } = mapExtraction(JSON.stringify({ ...good, net_total: sum(good) }), "m", opts);
    expect(controlInvoice(parsed, totals).checks.find((c) => c.code === "FOREIGN_VAT")?.text).toContain("70,19");
  });
});

describe("importInvoice with only a PDF", () => {
  const ctx = (reply: unknown): Ctx => {
    const db = new MemoryDb();
    seedDefaults(db);
    return {
      db,
      shopify: new FakeShopify(),
      who: "t",
      log: async () => {},
      now: () => new Date("2026-10-09T12:00:00Z"),
      claude: async () => ({ text: JSON.stringify(reply), model: "test" }),
    };
  };
  const pdf = { bytes: new Uint8Array([37, 80, 68, 70]), name: "invoice.pdf" };

  it("imports the lines, with the total checked", async () => {
    const c = ctx({ ...good, net_total: 1034.5 + 0 });
    const s = await createShipment(c, { name: "Leis", supplierName: "Leis" });
    const out = await importInvoice(c, s.id, { pdf, currency: "EUR" });
    expect(out).toMatchObject({ rawLines: 3, products: 3, currency: "EUR", invoiceNo: "LS-2026-77" });
    expect(out.control.checks.some((k) => k.code === "FOREIGN_VAT")).toBe(true);
    const view = await getShipmentView(c, s.id);
    expect(view.invoices[0]).toMatchObject({ spec_file: null, pdf_file: "invoice.pdf", vat_total: 70.19 });
    expect(view.invoices[0].extra_lines).toHaveLength(2);
  });

  it("needs the currency for a supplier whose profile does not fix one", async () => {
    const c = ctx(good);
    const s = await createShipment(c, { name: "New", supplierName: "A supplier we have no profile for" });
    await expect(importInvoice(c, s.id, { pdf })).rejects.toThrow(/valuta/);
  });

  it("uses the profile's currency when the supplier has one (Leis = EUR)", async () => {
    const c = ctx(good);
    const s = await createShipment(c, { name: "Leis", supplierName: "Leis" });
    await expect(importInvoice(c, s.id, { pdf })).resolves.toMatchObject({ currency: "EUR" });
  });

  it("refuses Stanro with only a PDF — it has no article numbers", async () => {
    const c = ctx(good);
    const s = await createShipment(c, { name: "S", supplierName: "Stanro" });
    await expect(importInvoice(c, s.id, { pdf })).rejects.toThrow(/varenummer/);
  });

  it("needs some file", async () => {
    const c = ctx(good);
    const s = await createShipment(c, { name: "L", supplierName: "Leis" });
    await expect(importInvoice(c, s.id, {})).rejects.toThrow(/Last opp/);
  });
});
