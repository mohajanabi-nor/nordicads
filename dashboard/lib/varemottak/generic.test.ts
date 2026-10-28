import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { parseGenericSpec } from "./suppliers/generic";

const enc = (s: string) => new TextEncoder().encode(s);
const opts = { supplier: "Leis", currency: "EUR" };

describe("parseGenericSpec — CSV", () => {
  it("reads English headers, comma delimiter, derives value from unit price", () => {
    const csv = ["Art.nr,Description,Quantity,Unit,Price,Country,HS code,Net weight", "101397,Kobra Sauce 280ml,100,pcs,2.50,PL,21039090,30"].join("\n");
    const p = parseGenericSpec(enc(csv), "leis-0042.csv", opts);
    expect(p.invoiceNo).toBe("leis-0042");
    expect(p.currency).toBe("EUR");
    expect(p.lines[0]).toMatchObject({ idx: "101397", name: "Kobra Sauce 280ml", qty: 100, unit: "pcs", lineValue: 250, country: "PL", hs: "21039090", netWeightKg: 30 });
  });

  it("reads Norwegian headers with ; and decimal commas", () => {
    const csv = ["Varenummer;Beskrivelse;Antall;Enhet;Verdi;Opprinnelsesland", '="004051011";Smør 200g;240;stk;1.197,60;PL'].join("\n");
    const p = parseGenericSpec(enc(csv), "f.csv", { ...opts, supplier: "X", currency: "PLN" });
    expect(p.lines[0]).toMatchObject({ idx: "004051011", qty: 240, lineValue: 1197.6, unit: "pcs" });
  });

  it("recognises kg lines", () => {
    const csv = "Art.nr,Description,Quantity,Unit,Value\nA,Jelly,45,kg,1048.95";
    expect(parseGenericSpec(enc(csv), "f.csv", opts).lines[0].unit).toBe("kilo");
  });

  it("skips spacer and total rows", () => {
    const csv = "Art.nr,Description,Quantity,Value\nA,One,1,10\n,,,\nTotal,,,10\n";
    expect(parseGenericSpec(enc(csv), "f.csv", opts).lines.map((l) => l.idx)).toEqual(["A"]);
  });

  it("finds the header below a title block", () => {
    const csv = "Invoice 123\nSupplier GmbH\n\nArt.nr,Description,Quantity\nA,One,1";
    expect(parseGenericSpec(enc(csv), "f.csv", opts).lines).toHaveLength(1);
  });

  it("uses a saved mapping for unusual headers", () => {
    const csv = "Kode X,Tekst,Mengde\nA,One,3";
    expect(() => parseGenericSpec(enc(csv), "f.csv", opts)).toThrow(/Overskrifter i filen: Kode X \| Tekst \| Mengde/);
    const p = parseGenericSpec(enc(csv), "f.csv", { ...opts, mapping: { idx: "Kode X", name: "Tekst", qty: "Mengde" } });
    expect(p.lines[0]).toMatchObject({ idx: "A", qty: 3 });
  });

  it("says what is missing rather than guessing", () => {
    expect(() => parseGenericSpec(enc("a,b,c\n1,2,3"), "f.csv", opts)).toThrow(/fant ikke kolonnene/);
  });

  it("warns about missing HS, weight and price columns", () => {
    const w = parseGenericSpec(enc("Art.nr,Description,Quantity\nA,One,1"), "f.csv", opts).warnings.join();
    expect(w).toContain("tollnummer");
    expect(w).toContain("nettovekt");
    expect(w).toContain("pris må fylles inn");
  });

  it("renumbers when the file's line numbers repeat", () => {
    const p = parseGenericSpec(enc("No,Art.nr,Description,Quantity\n1,A,One,1\n1,B,Two,2"), "f.csv", opts);
    expect(p.lines.map((l) => l.no)).toEqual([1, 2]);
    expect(p.warnings.join()).toContain("nummerert på nytt");
  });
});

describe("parseGenericSpec — Excel", () => {
  it("reads an .xlsx", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Article", "Description", "Qty", "Unit price", "Origin"],
      ["105080", "Burjonka Wafer Rolls", 120, 3.2, "UA"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const p = parseGenericSpec(bytes, "inv.xlsx", opts);
    expect(p.lines[0]).toMatchObject({ idx: "105080", qty: 120, lineValue: 384, country: "UA" });
  });
});
