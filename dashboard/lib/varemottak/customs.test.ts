import { describe, expect, it } from "vitest";
import { dutyPerKgFromDeclaration, lookupDuty, type CustomsRate } from "./customs";

const rate = (o: Partial<CustomsRate> & { duty_per_kg: number }): CustomsRate => ({
  scope: "cn8",
  cn8: null,
  hs6: null,
  supplier: null,
  idx: null,
  source_kind: "declaration",
  source_ref: "25NO1",
  source_date: "2026-08-01",
  ...o,
});

const line = { supplier: "Stanro", idx: "71806000AXE", hs: "21041000" };

describe("lookupDuty", () => {
  it("1. the same product in a declaration wins over everything, even over the CN8", () => {
    const r = lookupDuty(line, [
      rate({ scope: "product", supplier: "Stanro", idx: "71806000AXE", duty_per_kg: 6, source_kind: "declaration", source_ref: "88405" }),
      rate({ scope: "product", supplier: "Stanro", idx: "71806000AXE", duty_per_kg: 9, source_kind: "estimate", source_ref: "typed by us, estimate" }),
      rate({ cn8: "21041000", duty_per_kg: 4.5, source_ref: "25NO777" }),
    ]);
    expect(r).toMatchObject({ dutyPerKg: 6, kind: "declaration" });
    expect(r!.source).toContain("88405");
  });

  it("2. a declared CN8 is used when every declared rate for it agrees, and the latest is the source", () => {
    const r = lookupDuty(line, [
      rate({ scope: "product", supplier: "Stanro", idx: "71806000AXE", duty_per_kg: 9, source_kind: "estimate", source_ref: "typed by us, estimate" }),
      rate({ cn8: "21041000", duty_per_kg: 4.5, source_date: "2026-05-01", source_ref: "old" }),
      rate({ cn8: "21041000", duty_per_kg: 4.5, source_date: "2026-09-01", source_ref: "25NO777" }),
    ]);
    expect(r).toMatchObject({ dutyPerKg: 4.5, kind: "cn8" });
    expect(r!.source).toContain("25NO777");
  });

  it("2. a CN8 declared at two different rates is ambiguous and is never applied by itself", () => {
    // sausages: 84,31 kr/kg on three declarations and 0 on one (tariff quota)
    const sausage = { supplier: "Maspo", idx: "53020", hs: "16010000" };
    const rates = [
      rate({ cn8: "16010000", duty_per_kg: 84.31, source_date: "2026-10-17", source_ref: "89492" }),
      rate({ cn8: "16010000", duty_per_kg: 0, source_date: "2026-10-08", source_ref: "89060" }),
    ];
    expect(lookupDuty(sausage, rates)).toBeNull();
    // the product's own declared rate still works
    expect(lookupDuty(sausage, [...rates, rate({ scope: "product", supplier: "Maspo", idx: "53020", duty_per_kg: 84.31, source_kind: "declaration", source_ref: "89492" })])).toMatchObject({ dutyPerKg: 84.31, kind: "declaration" });
  });

  it("4. falls back to the rate typed for the same product earlier (an estimate)", () => {
    const r = lookupDuty(line, [
      rate({ scope: "product", supplier: "stanro", idx: "71806000AXE", duty_per_kg: 3.2, source_kind: "estimate", source_ref: "typed by us, estimate", source_date: "2026-07-01" }),
    ]);
    expect(r).toMatchObject({ dutyPerKg: 3.2, kind: "estimate" });
    expect(r!.source).toContain("typed by us, estimate");
  });

  it("does not use another supplier's rate for the same article number", () => {
    expect(
      lookupDuty(line, [rate({ scope: "product", supplier: "Leis", idx: "71806000AXE", duty_per_kg: 3.2, source_kind: "estimate", source_ref: "x" })]),
    ).toBeNull();
  });

  it("3. uses a verified HS6 rate when all verified rates under it agree", () => {
    const r = lookupDuty(line, [
      rate({ cn8: "21041010", duty_per_kg: 2, source_ref: "A" }),
      rate({ cn8: "21041090", duty_per_kg: 2, source_ref: "B" }),
    ]);
    expect(r).toMatchObject({ dutyPerKg: 2, kind: "hs6" });
  });

  it("3. refuses to pick when two CN8 codes under the HS6 disagree — never a guess", () => {
    expect(
      lookupDuty(line, [
        rate({ cn8: "21041010", duty_per_kg: 2, source_ref: "A" }),
        rate({ cn8: "21041090", duty_per_kg: 6, source_ref: "B" }),
      ]),
    ).toBeNull();
  });

  it("an estimate on a CN8 does not count as verified", () => {
    expect(lookupDuty(line, [rate({ cn8: "21041000", duty_per_kg: 4, source_kind: "estimate", source_ref: "guess" })])).toBeNull();
  });

  it("4. returns nothing — empty, to be filled in — when nothing matches", () => {
    expect(lookupDuty(line, [])).toBeNull();
    expect(lookupDuty({ ...line, hs: null }, [rate({ cn8: "21041000", duty_per_kg: 4 })])).toBeNull();
  });

  it("never matches on the HS family or a product name", () => {
    // Same chapter (21), different heading: must not match.
    expect(lookupDuty(line, [rate({ cn8: "21069098", duty_per_kg: 8 })])).toBeNull();
  });
});

describe("dutyPerKgFromDeclaration", () => {
  it("duty paid ÷ net weight", () => {
    expect(dutyPerKgFromDeclaration(360, 80)).toBe(4.5);
    expect(dutyPerKgFromDeclaration(0, 80)).toBe(0);
  });
  it("is null without a weight", () => {
    expect(dutyPerKgFromDeclaration(100, 0)).toBeNull();
  });
});
