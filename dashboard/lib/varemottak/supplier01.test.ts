import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeLines } from "./merge";
import { detectDecimalStyle, parseGenericSpec } from "./suppliers/generic";
import { profileFor, SUPPLIER_PROFILES } from "./suppliers/registry";

const enc = (s: string) => new TextEncoder().encode(s);

describe("decimal style — the file decides, never an assumption", () => {
  it("1.234 is 1.234 in a dot-decimal file, not 1234", () => {
    const csv = "INDEX,NAME_ENG,QUANTITY,NET_VALUE,NET WEIGHT,GROSS_WEIGHT\n1,Sausage,29.978,855.87,29.978,121.856\n2,Chips,10,21.6,3.5,4.1";
    const p = parseGenericSpec(enc(csv), "f.csv", { supplier: "X", currency: "PLN" });
    expect(p.lines[0]).toMatchObject({ qty: 29.978, netWeightKg: 29.978, grossWeightKg: 121.856, lineValue: 855.87 });
  });
  it("still reads Norwegian/Polish comma files, where 1.234 is a thousand", () => {
    const csv = "INDEX;NAME_ENG;QUANTITY;NET_VALUE\n1;Thing;1.234;1.041,60\n2;Other;5;12,5";
    const p = parseGenericSpec(enc(csv), "f.csv", { supplier: "X", currency: "PLN" });
    expect(p.lines[0]).toMatchObject({ qty: 1234, lineValue: 1041.6 });
  });
  it("detects the style", () => {
    expect(detectDecimalStyle(["21.6", "116.48", "29.978"])).toBe("dot");
    expect(detectDecimalStyle(["12,5", "1.041,60"])).toBe("comma");
    expect(detectDecimalStyle(["1", "2"])).toBe("unknown");
  });
  it("warns when it cannot tell", () => {
    const p = parseGenericSpec(enc("INDEX,NAME_ENG,QUANTITY,NET_VALUE\n1,A,2,3"), "f.csv", { supplier: "X", currency: "PLN" });
    expect(p.warnings.join()).toContain("desimalformatet");
  });
});

describe("header handling", () => {
  it("reads UNDERSCORE headers and prefers the English name column", () => {
    const csv = "CODE_INTRASTAT,INDEX,NAME,NAME_ENG,INVOICE_NUMBER,CURRENCY,NET_VALUE,NET WEIGHT,QUANTITY,UNIT_OF_MEASUREMENT,NUMBER_OF_BOXES,GROSS_WEIGHT,COUNTRY_OF_ORIGIN\n0409 00 00,33198,APIS MIOD,APIS HONEY 225G,2610/1,PLN,600,13.5,60,szt,10,21.6,PL";
    const p = parseGenericSpec(enc(csv), "f.csv", { supplier: "X", currency: "PLN" });
    expect(p.lines[0]).toMatchObject({ idx: "33198", name: "APIS HONEY 225G", hs: "04090000", qty: 60, cartons: 10, country: "PL", lineValue: 600, netWeightKg: 13.5, grossWeightKg: 21.6, unit: "pcs", invoiceNo: "2610/1" });
    expect(mergeLines(p.lines)[0].pcsPerCartonInvoice).toBe(6);
  });
  it("combines several invoice numbers in one file instead of picking one", () => {
    const csv = "INDEX,NAME_ENG,QUANTITY,NET_VALUE,INVOICE_NUMBER\n1,A,1,2,I-1\n2,B,1,2,I-2";
    const p = parseGenericSpec(enc(csv), "f.csv", { supplier: "X", currency: "PLN" });
    expect(p.invoiceNo).toBe("I-1 + I-2");
    expect(p.warnings.join()).toContain("2 fakturaer");
  });
  it("refuses a currency that disagrees with the supplier profile, and mixed currencies", () => {
    expect(() => parseGenericSpec(enc("INDEX,NAME_ENG,QUANTITY,CURRENCY\n1,A,1,EUR"), "f.csv", { supplier: "X", currency: "PLN" })).toThrow(/sier valuta EUR/);
    expect(() => parseGenericSpec(enc("INDEX,NAME_ENG,QUANTITY,CURRENCY\n1,A,1,EUR\n2,B,1,PLN"), "f.csv", { supplier: "X", currency: null })).toThrow(/blander valutaer/);
  });
});

describe("supplier profiles", () => {
  it("each supplier states what to upload", () => {
    for (const p of SUPPLIER_PROFILES) expect(p.accepts.spec.length).toBeGreaterThan(10);
    expect(profileFor("Stanro")).toMatchObject({ reader: "stanro", currency: "PLN", usesPdf: true });
    expect(profileFor("Supplier 01 (Excel, PLN)")).toMatchObject({ reader: "generic", currency: "PLN", usesPdf: false });
    expect(profileFor("Some new supplier").reader).toBe("generic");
    expect(profileFor("Some new supplier").currency).toBeNull();
  });
});

const XLSX_FILE = path.resolve(__dirname, "../../../fwter/01.xlsx");
describe.skipIf(!existsSync(XLSX_FILE))("the real Supplier 01 file (fwter/01.xlsx)", () => {
  const parsed = () => parseGenericSpec(new Uint8Array(readFileSync(XLSX_FILE)), "01.xlsx", { supplier: "Supplier 01", currency: "PLN" });

  it("reads 238 lines with every column the pricing needs", () => {
    const p = parsed();
    expect(p.lines).toHaveLength(238);
    expect(p.currency).toBe("PLN");
    expect(p.warnings.filter((w) => /mangler/.test(w))).toEqual([]); // no missing hs / weight / price columns
    expect(p.lines.every((l) => l.hs && l.hs.length === 8 && l.lineValue !== null && l.netWeightKg !== null && l.country.length === 2)).toBe(true);
    expect(p.invoiceNo).toBe("2610-EX/01/00512 + 2610-EX/01/00513 + 2610-EX/01/00514");
  });

  it("totals match the file: value 170 441,10 PLN, net weight 6 729,910 kg, no 1000× weights", () => {
    const p = parsed();
    expect(p.lines.reduce((a, l) => a + (l.lineValue ?? 0), 0)).toBeCloseTo(170441.1, 2);
    expect(p.lines.reduce((a, l) => a + (l.netWeightKg ?? 0), 0)).toBeCloseTo(6729.91, 3);
    const sausage = p.lines.find((l) => l.idx === "8623")!;
    expect(sausage).toMatchObject({ unit: "kilo", qty: 29.978, netWeightKg: 29.978 });
  });

  it("merges to 232 articles, the six repeated ones summed", () => {
    expect(mergeLines(parsed().lines)).toHaveLength(232);
  });
});

describe("EAN columns", () => {
  it("reads piece and carton EANs as digits, and ignores cells that are not barcodes", () => {
    const csv = "INDEX,NAME_ENG,QUANTITY,EAN PCS,EAN BOX\n1,A,1,5901346352509,5901346350017\n2,B,1,2595110,\n3,C,1,n/a,12";
    const p = parseGenericSpec(new TextEncoder().encode(csv), "f.csv", { supplier: "X", currency: "PLN" });
    expect(p.lines[0]).toMatchObject({ ean: "5901346352509", eanBox: "5901346350017" });
    expect(p.lines[1]).toMatchObject({ ean: "2595110", eanBox: null }); // 7 digits still counts: the file said so
    expect(p.lines[2]).toMatchObject({ ean: null, eanBox: null });
  });
  it("keeps the EANs through the merge", () => {
    const csv = "INDEX,NAME_ENG,QUANTITY,EAN PCS\n1,A,1,5901346352509\n1,A,2,5901346352509";
    const m = mergeLines(parseGenericSpec(new TextEncoder().encode(csv), "f.csv", { supplier: "X", currency: "PLN" }).lines);
    expect(m[0]).toMatchObject({ qty: 3, ean: "5901346352509" });
  });
});

describe("several invoices in one file keep their own totals", () => {
  const csv = "INDEX,NAME_ENG,QUANTITY,NET_VALUE,NET WEIGHT,INVOICE\n1,A,10,100.5,5,INV-1\n2,B,20,200,10,INV-1\n3,C,5,50,2.5,INV-2\n1,A,10,100.5,5,INV-2";
  it("reports each invoice's lines, value and weight", () => {
    const p = parseGenericSpec(enc(csv), "f.csv", { supplier: "X", currency: "PLN" });
    expect(p.invoiceNo).toBe("INV-1 + INV-2");
    expect(p.parts).toEqual([
      { invoiceNo: "INV-1", lines: 2, value: 300.5, netWeightKg: 15 },
      { invoiceNo: "INV-2", lines: 2, value: 150.5, netWeightKg: 7.5 },
    ]);
    expect(p.parts!.reduce((a, x) => a + x.value, 0)).toBeCloseTo(p.lines.reduce((a, l) => a + (l.lineValue ?? 0), 0), 2);
  });
  it("has no parts for a single-invoice file", () => {
    const one = "INDEX,NAME_ENG,QUANTITY,NET_VALUE,INVOICE\n1,A,10,100.5,INV-1";
    expect(parseGenericSpec(enc(one), "f.csv", { supplier: "X", currency: "PLN" }).parts).toBeUndefined();
  });
});
