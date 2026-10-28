import { describe, expect, it } from "vitest";
import {
  buildReport,
  isBeverageHs,
  parseTermCode,
  previousTerm,
  rateOn,
  reportCsv,
  sameTermLastYear,
  suggestGpCode,
  termForDate,
  termOf,
  volumeMl,
  type GpCategory,
  type GpImportedUnits,
  type GpRate,
} from "./gp";

describe("terms — the portal's fixed two-month periods", () => {
  it("2026-RT3 is 1 May – 30 June, due 22 July (as in the portal)", () => {
    expect(termOf(2026, 3)).toEqual({
      code: "2026-RT3",
      year: 2026,
      number: 3,
      start: "2026-05-01",
      end: "2026-06-30",
      deadline: "2026-07-22",
    });
  });
  it("covers the whole year", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => termOf(2026, n).start)).toEqual([
      "2026-01-01", "2026-03-01", "2026-05-01", "2026-07-01", "2026-09-01", "2026-11-01",
    ]);
    expect(termOf(2026, 1).end).toBe("2026-02-28");
    expect(termOf(2028, 1).end).toBe("2028-02-29"); // leap year
  });
  it("RT6 is due in January of the next year", () => {
    expect(termOf(2026, 6).deadline).toBe("2027-01-22");
  });
  it("finds the term for a date", () => {
    expect(termForDate("2026-06-30").code).toBe("2026-RT3");
    expect(termForDate("2026-07-01").code).toBe("2026-RT4");
    expect(termForDate("2026-10-09").code).toBe("2026-RT5");
  });
  it("finds the previous term and the same term last year", () => {
    expect(previousTerm(termOf(2026, 3)).code).toBe("2026-RT2");
    expect(previousTerm(termOf(2026, 1)).code).toBe("2025-RT6");
    expect(sameTermLastYear(termOf(2026, 3)).code).toBe("2025-RT3");
  });
  it("parses a term code", () => {
    expect(parseTermCode("2026-RT3")?.start).toBe("2026-05-01");
    expect(parseTermCode("2026-RT7")).toBeNull();
    expect(parseTermCode("junk")).toBeNull();
  });
});

describe("beverages and sizes", () => {
  it("recognises the six beverage headings", () => {
    expect(isBeverageHs("22021000")).toBe(true);
    expect(isBeverageHs("21041000")).toBe(false);
  });
  it("reads the volume in the name", () => {
    expect(volumeMl("Coca-Cola pet 0.5l/18 pcs")).toBe(500);
    expect(volumeMl("Energy Drink White Peach Can 0,25l 12s")).toBe(250);
    expect(volumeMl("Mirinda orange pet 2.0l/8 pcs")).toBe(2000);
    expect(volumeMl("Kinder Joy 20g")).toBeNull();
  });
});

describe("suggestGpCode — real names from the Stanro invoice", () => {
  it.each([
    ["Carbonated drink. Coca-Cola pet 0.5l/18 pcs. DRS Coca-Cola", "1017"],
    ["Carbonated drink. Mirinda orange pet 2.0l/8 pcs. DRS Pepsi", "1017"],
    ["Gas drink.Pepsi non-return glass 0.25l/12pcs 7G Pepsi", "4005"],
    ["Energy Monster Monarch can 0.5l/12 pcs DRS Coca-Cola", "5020"],
  ])("%s → %s", (name, code) => expect(suggestGpCode(name).code).toBe(code));

  it("reads the invoice name and the shop title together (the title often omits pet/can)", () => {
    // shop: "Mirinda 2L x 8"   invoice: "Carbonated drink. Mirinda orange pet 2.0l/8 pcs. DRS Pepsi"
    expect(suggestGpCode("Carbonated drink. Mirinda orange pet 2.0l/8 pcs. DRS Pepsi Mirinda 2L x 8").code).toBe("1017");
    // shop: "Coca-Cola Monster Energy Drink Ultra Violet 500ml x 12"   invoice: "… cans 0.5l/12 pcs …"
    expect(suggestGpCode("Energy Monster Ult.Violet cans 0.5l/12 pcs DRS Coca-Cola Coca-Cola Monster Energy Drink Ultra Violet 500ml x 12").code).toBe("5020");
    expect(suggestGpCode("Mirinda 2L x 8").code).toBeNull(); // the title alone says nothing about the package
  });

  it("says so — and suggests nothing — for a 0,25 l aluminium can, which has no code", () => {
    const s = suggestGpCode("Energy drink can 0,25l *8pcs/3pack DRS Red Bull");
    expect(s.code).toBeNull();
    expect(s.reason).toContain("ingen kode");
  });
  it("does not guess when the package cannot be read", () => {
    expect(suggestGpCode("Some beverage 1l").code).toBeNull();
  });
});

const categories: GpCategory[] = [
  { code: "1017", name: "Flasker av plast - drikkevare", unit: "kg", sort: 10 },
  { code: "2001", name: "Drikkekartong - drikkevare", unit: "pcs", sort: 20 },
  { code: "5020", name: "Aluminium drikkevare 251-500 ml", unit: "pcs", sort: 40 },
];
const rates: GpRate[] = [
  { code: "1017", valid_from: "2026-01-01", rate: 6 },
  { code: "2001", valid_from: "2026-01-01", rate: 0.18 },
  { code: "5020", valid_from: "2026-01-01", rate: 0.18 },
  { code: "5020", valid_from: "2026-07-01", rate: 0.2 },
];

describe("rateOn", () => {
  it("uses the rate in force at the end of the term", () => {
    expect(rateOn(rates, "5020", "2026-06-30")).toBe(0.18);
    expect(rateOn(rates, "5020", "2026-08-31")).toBe(0.2);
    expect(rateOn(rates, "9999", "2026-06-30")).toBeNull();
  });
});

describe("buildReport", () => {
  const rows: GpImportedUnits[] = [
    { arrivalDate: "2026-05-10", code: "5020", units: 1000, packagingKg: null },
    { arrivalDate: "2026-06-30", code: "5020", units: 500, packagingKg: null },
    { arrivalDate: "2026-07-01", code: "5020", units: 9999, packagingKg: null }, // next term
    { arrivalDate: "2026-05-02", code: "1017", units: 2592, packagingKg: 0.025, name: "Coca-Cola pet" },
    { arrivalDate: "2026-03-15", code: "5020", units: 700, packagingKg: null }, // previous term
    { arrivalDate: "2025-05-20", code: "5020", units: 400, packagingKg: null }, // same term last year
  ];
  const report = buildReport(termOf(2026, 3), categories, rates, rows);
  const line = (c: string) => report.lines.find((l) => l.code === c)!;

  it("counts pieces by arrival date within the term only", () => {
    expect(line("5020").quantity).toBe(1500);
  });
  it("converts plastic bottles to kg with the packaging weight", () => {
    expect(line("1017").quantity).toBe(64.8); // 2592 × 0.025
    expect(line("1017").sum).toBe(388.8); // × 6,00 kr/kg
  });
  it("multiplies by the rate", () => {
    expect(line("5020").sum).toBe(270); // 1500 × 0,18
  });
  it("shows the previous period and the same period last year", () => {
    expect(line("5020").previousPeriod).toBe(700);
    expect(line("5020").sameLastYear).toBe(400);
  });
  it("reports a category with nothing imported as zero", () => {
    expect(line("2001")).toMatchObject({ quantity: 0, sum: 0 });
  });
  it("totals the sums", () => {
    expect(report.total).toBe(658.8);
    expect(report.problems).toEqual([]);
  });

  it("flags a plastic bottle without packaging weight instead of silently undercounting", () => {
    const r = buildReport(termOf(2026, 3), categories, rates, [
      { arrivalDate: "2026-05-02", code: "1017", units: 100, packagingKg: null, name: "Mirinda pet" },
    ]);
    expect(r.problems.join()).toContain("mangler vekt per flaske for Mirinda pet");
  });
  it("flags a code that is not a category", () => {
    const r = buildReport(termOf(2026, 3), categories, rates, [{ arrivalDate: "2026-05-02", code: "9999", units: 5, packagingKg: null }]);
    expect(r.problems.join()).toContain("9999");
  });
});

describe("reportCsv", () => {
  it("follows the portal's column order with Norwegian decimals", () => {
    const csv = reportCsv(buildReport(termOf(2026, 3), categories, rates, [{ arrivalDate: "2026-05-10", code: "5020", units: 1000, packagingKg: null }]));
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Kode;Emballasjetype/produkt;Enhet;Forrige periode;Samme periode i fjor;Denne perioden;Pris pr. enhet;Sum");
    expect(lines.find((l) => l.startsWith("5020"))).toBe("5020;Aluminium drikkevare 251-500 ml;stk;0;0;1000;0,18;180");
    expect(lines.at(-1)).toContain("Totalbeløp (ekskl. mva.);180");
  });
});
