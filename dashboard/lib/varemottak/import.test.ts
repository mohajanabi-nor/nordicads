import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  controlInvoice,
  lineWarnings,
  valueTolerance,
  weightPerUnitLooksWrong as weightPerUnitLooks,
} from "./invoice-control";
import { fixHs, mergeLines } from "./merge";
import { parseStanroCsv, parseStanroPdf, pdfTextLines } from "./suppliers/stanro";
import { decodeSupplierText, num } from "./text";
import type { InvoiceLine } from "./types";

// The client's real files live in fwter/ (gitignored); those tests are skipped where it is absent.
const FWTER = path.resolve(__dirname, "../../../fwter");
const CSV = path.join(FWTER, "000033_S33_2026_spec.csv");
const PDF = path.join(FWTER, "000033-S33-2026.pdf");
const haveFiles = existsSync(CSV) && existsSync(PDF);

const line = (o: Partial<InvoiceLine> & { no: number; idx: string }): InvoiceLine => ({
  name: "Test",
  qty: 10,
  unit: "pcs",
  cartons: 1,
  country: "PL",
  hs: "19053191",
  netWeightKg: 1,
  grossWeightKg: 1,
  lineValue: 10,
  invoiceNo: "X/1",
  ...o,
});

describe("num", () => {
  it("reads Norwegian/Polish and plain formats", () => {
    expect(num("1.041,60")).toBe(1041.6);
    expect(num("9,814")).toBe(9.814);
    expect(num("1.234")).toBe(1234);
    expect(num("1.5")).toBe(1.5);
    expect(num("")).toBeNull();
    expect(num("abc")).toBeNull();
  });
});

describe("decodeSupplierText", () => {
  it("reads cp1250 Polish letters", () => {
    // "żurek" in windows-1250: ż = 0xBF, ú not needed
    const bytes = new Uint8Array([0xbf, 0x75, 0x72, 0x65, 0x6b]);
    expect(decodeSupplierText(bytes).text).toBe("żurek");
  });
  it("accepts UTF-8 and a BOM", () => {
    const utf8 = new TextEncoder().encode("Łaciate");
    expect(decodeSupplierText(utf8).text).toBe("Łaciate");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
    expect(decodeSupplierText(bom).text).toBe("Łaciate");
  });
});

describe("fixHs — the safe rule", () => {
  it("adds the lost leading zero to a code one digit short", () => {
    expect(fixHs("4051011")).toEqual({ hs: "04051011", fixed: true });
    expect(fixHs("402010099")).toEqual({ hs: "0402010099", fixed: true });
  });
  it("never touches a full-length code, food or not", () => {
    expect(fixHs("04051011")).toEqual({ hs: "04051011", fixed: false });
    expect(fixHs("96131000")).toEqual({ hs: "96131000", fixed: false }); // lighters
    expect(fixHs("3401300000")).toEqual({ hs: "3401300000", fixed: false }); // soap, 10 digits
    expect(fixHs("9503009500")).toEqual({ hs: "9503009500", fixed: false }); // toys, 10 digits
  });
  it("copes with empty and decorated input", () => {
    expect(fixHs(null)).toEqual({ hs: null, fixed: false });
    expect(fixHs("0405.10.11")).toEqual({ hs: "04051011", fixed: false });
  });
});

describe("mergeLines", () => {
  it("sums quantity, cartons, weight and value for the same article number", () => {
    const [m] = mergeLines([
      line({ no: 1, idx: "A", qty: 100, cartons: 10, netWeightKg: 5, lineValue: 50 }),
      line({ no: 2, idx: "A", qty: 50, cartons: 5, netWeightKg: 2.5, lineValue: 25 }),
    ]);
    expect(m.qty).toBe(150);
    expect(m.cartons).toBe(15);
    expect(m.netWeightKg).toBe(7.5);
    expect(m.lineValue).toBe(75);
    expect(m.unitPrice).toBe(0.5);
    expect(m.lines).toEqual([1, 2]);
    expect(m.priceConflict).toBeNull();
    expect(m.pcsPerCartonInvoice).toBe(10);
  });
  it("flags — does not average — the same article at two prices", () => {
    const [m] = mergeLines([
      line({ no: 1, idx: "A", qty: 160, lineValue: 958.4 }), // 5.99
      line({ no: 2, idx: "A", qty: 160, lineValue: 1038.4 }), // 6.49
    ]);
    expect(m.priceConflict).toHaveLength(2);
    expect(m.priceConflict![0]).toMatchObject({ unitPrice: 5.99, lines: [1] });
    expect(m.priceConflict![1]).toMatchObject({ unitPrice: 6.49, lines: [2] });
  });
  it("does not flag cent rounding as a conflict", () => {
    const [m] = mergeLines([
      line({ no: 1, idx: "A", qty: 144, lineValue: 501.12 }),
      line({ no: 2, idx: "A", qty: 336, lineValue: 1169.28 }),
    ]);
    expect(m.priceConflict).toBeNull();
  });
  it("flags a cheap item whose price moved a cent", () => {
    const [m] = mergeLines([
      line({ no: 1, idx: "A", qty: 1000, lineValue: 150 }), // 0.15
      line({ no: 2, idx: "A", qty: 1000, lineValue: 160 }), // 0.16
    ]);
    expect(m.priceConflict).toHaveLength(2);
  });
  it("derives pieces per carton only when it comes out whole", () => {
    expect(mergeLines([line({ no: 1, idx: "A", qty: 6048, cartons: 84 })])[0].pcsPerCartonInvoice).toBe(72);
    expect(mergeLines([line({ no: 1, idx: "A", qty: 195, cartons: 9.286 })])[0].pcsPerCartonInvoice).toBe(21);
    const odd = mergeLines([line({ no: 1, idx: "A", qty: 100, cartons: 7 })])[0];
    expect(odd.pcsPerCartonInvoice).toBeNull();
    expect(odd.issues.join()).toContain("går ikke opp");
  });
  it("gives no carton size for kg lines", () => {
    expect(mergeLines([line({ no: 1, idx: "A", unit: "kilo", qty: 80, cartons: 10 })])[0].pcsPerCartonInvoice).toBeNull();
  });
  it("repairs the HS code and marks it", () => {
    const [m] = mergeLines([line({ no: 1, idx: "A", hs: "4051011" })]);
    expect(m.hs).toBe("04051011");
    expect(m.hsFixed).toBe(true);
  });
  it("reports mixed units, countries and tariff numbers", () => {
    const [m] = mergeLines([
      line({ no: 1, idx: "A", unit: "pcs", country: "PL", hs: "11111111" }),
      line({ no: 2, idx: "A", unit: "kilo", country: "UA", hs: "22222222" }),
    ]);
    expect(m.issues).toHaveLength(3);
  });
});

describe("weightPerUnitLooksWrong", () => {
  it("stays silent when the name has no size and there is no gross weight to compare", () => {
    expect(weightPerUnitLooks("FOLDABLE CAGE LIGHTER", "pcs", 100, 0.1)).toBeNull();
  });
  it("catches net weight far below gross weight", () => {
    expect(weightPerUnitLooks("FOLDABLE CAGE LIGHTER", "pcs", 100, 0.1, 10)).toContain("bruttovekt");
    expect(weightPerUnitLooks("Round lighter", "pcs", 80, 3.52, 4)).toBeNull();
  });
  it("catches a typo against the grams in the name", () => {
    expect(weightPerUnitLooks("Bahlsen Hit 220g", "pcs", 240, 5.28)).not.toBeNull(); // 22 g each, not 220
    expect(weightPerUnitLooks("Bahlsen Hit 220g", "pcs", 240, 52.8)).toBeNull(); // 220 g each
  });
  it("accepts packaging weight on top of the content", () => {
    expect(weightPerUnitLooks("Krakus soup 1.0l", "pcs", 80, 80)).toBeNull();
  });
  it("treats a starred multi-pack like an x multi-pack (20*2G tea bags are not 2 g each)", () => {
    expect(weightPerUnitLooks("MALWA FOREST FRUIT TEA 20*2G", "pcs", 120, 4.8)).toBeNull();
    expect(weightPerUnitLooks("ZOTT MONTE SNACK 8*29G", "pcs", 80, 18.56)).toBeNull();
    expect(weightPerUnitLooks("Bahlsen Hit 220g", "pcs", 240, 5.28)).not.toBeNull(); // a single size is still checked
  });
  it("checks kg lines against the quantity", () => {
    expect(weightPerUnitLooks("Jelly 1kg", "kilo", 45, 45)).toBeNull();
    expect(weightPerUnitLooks("Jelly 1kg", "kilo", 45, 4.5)).not.toBeNull();
  });
});

describe("lineWarnings — sanctions", () => {
  it("marks Russia and Belarus", () => {
    const w = lineWarnings([line({ no: 1, idx: "A", country: "RU" }), line({ no: 2, idx: "B", country: "PL" })]);
    expect(w).toHaveLength(1);
    expect(w[0].text).toContain("1 A");
  });
});

describe("controlInvoice (synthetic)", () => {
  const parsed = {
    supplier: "T",
    invoiceNo: "X/1",
    currency: "PLN",
    warnings: [],
    lines: [line({ no: 2, idx: "A", qty: 10, lineValue: 100 }), line({ no: 3, idx: "B", qty: 5, lineValue: 50 })],
  };
  const totals = (over = {}) => ({
    invoiceNo: "X/1",
    invoiceDate: null,
    currency: "PLN",
    netTotal: 450,
    vatTotal: 0,
    grossTotal: 450,
    netWeightKg: null,
    extraLines: [],
    items: [
      { no: 1, name: "Export customs clearance", qty: 1, unit: "pcs", unitPrice: 300, value: 300 },
      { no: 2, name: "A", qty: 10, unit: "pcs", unitPrice: 10, value: 100 },
      { no: 3, name: "B", qty: 5, unit: "pcs", unitPrice: 10, value: 50 },
    ],
    ...over,
  });
  it("passes when lines + separate costs equal the total", () => {
    const r = controlInvoice(parsed, totals());
    expect(r.ok).toBe(true);
    expect(r.extraLines).toHaveLength(1);
    expect(r.extraValue).toBe(300);
    expect(r.checks.find((c) => c.code === "TOTAL")?.severity).toBe("ok");
  });
  it("blocks when the total is off by more than rounding", () => {
    const r = controlInvoice(parsed, totals({ netTotal: 480 }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.code === "TOTAL")?.severity).toBe("block");
  });
  it("blocks a quantity that differs from the PDF", () => {
    const t = totals();
    t.items[1].qty = 11;
    expect(controlInvoice(parsed, t).checks.some((c) => c.code === "QTY_MISMATCH")).toBe(true);
  });
  it("blocks a product that is on the PDF but not in the file", () => {
    const t = totals();
    t.items.push({ no: 4, name: "Chocolate bar", qty: 3, unit: "pcs", unitPrice: 5, value: 15 });
    const r = controlInvoice(parsed, t);
    expect(r.checks.some((c) => c.code === "MISSING_FROM_FILE")).toBe(true);
    expect(r.ok).toBe(false);
  });
  it("warns when the supplier charged VAT on an export invoice", () => {
    const r = controlInvoice(parsed, totals({ vatTotal: 70.19 }));
    expect(r.checks.find((c) => c.code === "FOREIGN_VAT")?.severity).toBe("warn");
  });
  it("says so when there is no PDF, rather than passing silently", () => {
    const r = controlInvoice(parsed, null);
    expect(r.checks[0].code).toBe("NO_PDF");
    expect(r.ok).toBe(true);
  });
  it("scales the rounding tolerance with the number of lines", () => {
    expect(valueTolerance(275)).toBeGreaterThan(valueTolerance(10));
  });
});

describe.skipIf(!haveFiles)("Stanro 000033/S33/2026 — the real files", () => {
  const csv = () => parseStanroCsv(new Uint8Array(readFileSync(CSV)), "spec.csv");

  it("reads 275 lines with Polish letters intact", () => {
    const p = csv();
    expect(p.lines).toHaveLength(275);
    expect(p.invoiceNo).toBe("000033/S33/2026");
    expect(p.currency).toBe("PLN");
    expect(p.warnings).toEqual([]);
    const names = p.lines.map((l) => l.name).join("|");
    expect(names).toContain("Piątnica");
    expect(names).toContain("Krakus żurek");
    expect(names).not.toContain("�");
  });

  it("unwraps Excel-escaped article numbers and keeps tariff numbers whole", () => {
    const p = csv();
    expect(p.lines[0]).toMatchObject({ no: 2, idx: "71806000AXE", hs: "21041000", qty: 80, cartons: 10, lineValue: 364 });
    expect(p.lines.every((l) => l.hs && l.hs.length === 8)).toBe(true);
  });

  it("merges to 238 article numbers", () => {
    expect(mergeLines(csv().lines)).toHaveLength(238);
  });

  it("finds the price conflict on 86018000DAN and no other", () => {
    const merged = mergeLines(csv().lines);
    const conflicts = merged.filter((m) => m.priceConflict);
    expect(conflicts.map((m) => m.idx)).toEqual(["86018000DAN"]);
    expect(conflicts[0].priceConflict!.map((c) => c.unitPrice).sort()).toEqual([5.99, 6.49]);
  });

  it("derives 72 pieces per carton for Kinder Joy", () => {
    const m = mergeLines(csv().lines).find((x) => x.idx === "11287100FEJ")!;
    expect(m.pcsPerCartonInvoice).toBe(72);
  });

  it("reads the paper invoice: totals, 277 item lines, VAT 0", async () => {
    const t = parseStanroPdf(await pdfTextLines(new Uint8Array(readFileSync(PDF))));
    expect(t.invoiceNo).toBe("000033/S33/2026");
    expect(t.invoiceDate).toBe("2026-09-24");
    expect(t.currency).toBe("PLN");
    expect(t.netTotal).toBe(279883.75);
    expect(t.vatTotal).toBe(0);
    expect(t.netWeightKg).toBe(17849.185);
    expect(t.items).toHaveLength(277); // line 1 customs + 275 products + line 277 pallets
  });

  it("controls the file against the PDF: ok within rounding, 2 separate costs, pallets in the weight", async () => {
    const t = parseStanroPdf(await pdfTextLines(new Uint8Array(readFileSync(PDF))));
    const r = controlInvoice(csv(), t);
    expect(r.ok).toBe(true);
    expect(r.extraLines.map((e) => e.no)).toEqual([1, 277]);
    expect(r.extraValue).toBe(750);
    expect(r.linesValue).toBeCloseTo(279133.74, 2);
    expect(r.checks.find((c) => c.code === "TOTAL")?.severity).toBe("ok");
    expect(r.checks.find((c) => c.code === "WEIGHT")?.text).toContain("450");
  });

  it("flags the 100 lighters at 0.1 kg net / 10 kg gross, and nothing else on the invoice", () => {
    const flagged = csv().lines.filter((l) =>
      weightPerUnitLooks(l.name, l.unit, l.qty, l.netWeightKg, l.grossWeightKg),
    );
    expect(flagged.map((l) => l.idx)).toEqual(["87939000KTA"]);
  });
});
