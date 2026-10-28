import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  calcLine,
  freightToNok,
  isDrinkHs,
  isNonFoodVatHs,
  roundUpHalf,
  suggestPrice,
  summarize,
  type LineInput,
  type ShipmentTotals,
} from "./calc";

const base: LineInput = {
  rateToNok: 2.498,
  quantity: 80,
  unit: "pcs",
  lineValue: 364,
  netWeightKg: 80,
  hs: "21041000",
  dutyPerKg: 1,
  pcsPerCarton: 8,
  salesUnitKg: null,
  mva25: false,
  shopifyStatus: "DRAFT",
  shopifyUnitPrice: null,
  shopifyCasePrice: null,
  ourPriceOverride: null,
};
const totals: ShipmentTotals = { freightNok: 3800, totalNetWeightKg: 1000 };

describe("roundUpHalf", () => {
  it("rounds up to the nearest 0.5", () => {
    expect(roundUpHalf(24.168)).toBe(24.5);
    expect(roundUpHalf(24.5)).toBe(24.5);
    expect(roundUpHalf(24.51)).toBe(25);
    expect(roundUpHalf(24.0)).toBe(24);
  });
  it("is not fooled by float noise", () => {
    expect(roundUpHalf(20 * 1.3)).toBe(26); // 26.000000000000004
    expect(roundUpHalf(28.0000000000001)).toBe(28);
    expect(roundUpHalf(28.000001)).toBe(28.5); // a real cent-fraction above 28 still rounds up
  });
});

describe("suggestPrice", () => {
  it("markup mode: cost x 1.30", () => {
    expect(suggestPrice(18.590785, { markupMode: "markup", markupValue: 0.3 })).toBe(24.5);
  });
  it("margin mode: cost / 0.70", () => {
    expect(suggestPrice(20, { markupMode: "margin", markupValue: 0.3 })).toBe(29); // 28.57 -> 29
  });
});

describe("isDrinkHs", () => {
  it("recognises the six drink headings", () => {
    for (const hs of ["22021000", "22011000", "20091100", "22041000", "22051000", "22060010"]) {
      expect(isDrinkHs(hs)).toBe(true);
    }
  });
  it("does not treat food or missing codes as drinks", () => {
    expect(isDrinkHs("21041000")).toBe(false);
    expect(isDrinkHs(null)).toBe(false);
    expect(isDrinkHs("")).toBe(false);
  });
});

describe("calcLine — hand-worked Stanro soup line", () => {
  // goods 364 x 2.498 / 80 = 11.3659 ; duty 1 x 80 / 80 = 1 ; freight 3.8 x 80 / 80 = 3.8
  // landed 16.1659 ; x1.15 = 18.590785 ; x1.30 = 24.168 -> 24.5
  const r = calcLine(base, totals, DEFAULT_SETTINGS);
  it("builds the landed cost from goods, duty and freight", () => {
    expect(r.goodsNok).toBeCloseTo(11.3659, 4);
    expect(r.dutyNok).toBeCloseTo(1, 6);
    expect(r.freightNok).toBeCloseTo(3.8, 6);
    expect(r.packagingNok).toBe(0);
    expect(r.landedCost).toBeCloseTo(16.1659, 4);
  });
  it("adds 15 % VAT and the 30 % markup, rounded up to 0.5", () => {
    expect(r.costInclVat).toBeCloseTo(18.590785, 5);
    expect(r.suggestedPrice).toBe(24.5);
  });
  it("uses the suggestion as our price for a DRAFT, and prices the case", () => {
    expect(r.ourPrice).toBe(24.5);
    expect(r.casePrice).toBe(196); // 24.5 x 8
  });
  it("reports the margin", () => {
    expect(r.margin).toBeCloseTo((24.5 - 18.590785) / 24.5, 6);
    expect(r.flags.marginBelowThreshold).toBe(false); // ~24.1 %
  });
});

describe("calcLine — VAT", () => {
  it("uses 25 % for mva-25 products", () => {
    const r = calcLine({ ...base, mva25: true }, totals, DEFAULT_SETTINGS);
    expect(r.costInclVat).toBeCloseTo(16.1659 * 1.25, 5);
    expect(r.vatRate).toBe(0.25);
  });
});

describe("calcLine — drinks", () => {
  // goods 1184.40 x 2.498 / 360 = 8.21842 ; duty 0 ; packaging 2 ; freight 3.8 x 180/360 = 1.9
  const drink: LineInput = { ...base, quantity: 360, lineValue: 1184.4, netWeightKg: 180, hs: "22021000", dutyPerKg: null };
  const r = calcLine(drink, totals, DEFAULT_SETTINGS);
  it("has zero duty and a flat packaging cost, even with no duty rate", () => {
    expect(r.isDrink).toBe(true);
    expect(r.dutyNok).toBe(0);
    expect(r.packagingNok).toBe(2);
    expect(r.flags.missingDuty).toBe(false);
  });
  it("lands at 12.118 and prices at 18.5", () => {
    expect(r.landedCost).toBeCloseTo(12.11842, 4);
    expect(r.suggestedPrice).toBe(18.5);
  });
  it("ignores a duty rate on a drink: the rule is duty 0, even when the code carries a small rate", () => {
    const withRate = calcLine({ ...drink, dutyPerKg: 9 }, totals, DEFAULT_SETTINGS);
    expect(withRate.dutyNok).toBe(0);
  });
});

describe("calcLine — missing duty is never guessed", () => {
  const r = calcLine({ ...base, dutyPerKg: null }, totals, DEFAULT_SETTINGS);
  it("leaves cost and price empty and flags the row", () => {
    expect(r.dutyNok).toBeNull();
    expect(r.landedCost).toBeNull();
    expect(r.costInclVat).toBeNull();
    expect(r.suggestedPrice).toBeNull();
    expect(r.ourPrice).toBeNull();
    expect(r.margin).toBeNull();
    expect(r.flags.missingDuty).toBe(true);
  });
  it("still shows an operator-typed price, without a margin", () => {
    const typed = calcLine({ ...base, dutyPerKg: null, ourPriceOverride: 30 }, totals, DEFAULT_SETTINGS);
    expect(typed.ourPrice).toBe(30);
    expect(typed.casePrice).toBe(240);
    expect(typed.margin).toBeNull();
  });
});

describe("calcLine — our price (step 9)", () => {
  it("keeps Shopify's price for an ACTIVE product", () => {
    const r = calcLine({ ...base, shopifyStatus: "ACTIVE", shopifyUnitPrice: 22 }, totals, DEFAULT_SETTINGS);
    expect(r.ourPrice).toBe(22);
    expect(r.suggestedPrice).toBe(24.5); // still shown, next to it
    expect(r.margin).toBeCloseTo((22 - 18.590785) / 22, 6); // 15.5 %
    expect(r.flags.marginBelowThreshold).toBe(true);
  });
  it("ignores Shopify's price on a DRAFT (it is the template's placeholder)", () => {
    const r = calcLine({ ...base, shopifyStatus: "DRAFT", shopifyUnitPrice: 1000 }, totals, DEFAULT_SETTINGS);
    expect(r.ourPrice).toBe(24.5);
  });
  it("lets the operator override everything", () => {
    const r = calcLine(
      { ...base, shopifyStatus: "ACTIVE", shopifyUnitPrice: 22, ourPriceOverride: 26 },
      totals,
      DEFAULT_SETTINGS,
    );
    expect(r.ourPrice).toBe(26);
  });
  it("flags a price below cost", () => {
    const r = calcLine({ ...base, ourPriceOverride: 18 }, totals, DEFAULT_SETTINGS);
    expect(r.flags.priceBelowCost).toBe(true);
    expect(r.margin).toBeLessThan(0);
  });
  it("has no case price without a carton size", () => {
    const r = calcLine({ ...base, pcsPerCarton: null }, totals, DEFAULT_SETTINGS);
    expect(r.casePrice).toBeNull();
  });
});

describe("calcLine — Shopify prices that do not multiply out", () => {
  // Wawel pralines 2,4kg x 1: productType 140 is per KG, the variant price 336 is the box (140 × 2.4).
  const wawel: LineInput = {
    ...base,
    unit: "kilo",
    quantity: 12,
    lineValue: 390.36,
    netWeightKg: 12,
    dutyPerKg: 2,
    salesUnitKg: 2.4,
    pcsPerCarton: 1,
    shopifyStatus: "ACTIVE",
    shopifyUnitPrice: 140,
    shopifyCasePrice: 336,
  };
  const none = { freightNok: 0, totalNetWeightKg: 1000 };
  const r = calcLine(wawel, none, DEFAULT_SETTINGS);

  it("keeps the shop's case price instead of 140 × 1", () => {
    expect(r.casePriceKept).toBe(true);
    expect(r.casePrice).toBe(336);
  });
  it("judges the margin on what the shop really charges per box", () => {
    expect(r.ourPrice).toBe(336);
    expect(r.margin).toBeCloseTo((336 - r.costInclVat!) / 336, 6);
  });
  it("changes nothing about this when the operator types a price", () => {
    const typed = calcLine({ ...wawel, ourPriceOverride: 350 }, none, DEFAULT_SETTINGS);
    expect(typed.casePriceKept).toBe(false);
    expect(typed.casePrice).toBe(350);
  });
  it("keeps the shop's price for an ACTIVE product with NO unit price at all (empty productType, priced per kg)", () => {
    const perKg: LineInput = { ...wawel, shopifyUnitPrice: null, shopifyCasePrice: 179, pcsPerCarton: 10, salesUnitKg: 0.6 };
    const k = calcLine(perKg, none, DEFAULT_SETTINGS);
    expect(k.casePriceKept).toBe(true);
    expect(k.casePrice).toBe(179); // not a suggested price × 10
    expect(k.ourPrice).toBeCloseTo(17.9, 6);
  });
  it("does not trigger when the prices do multiply out", () => {
    const ok = calcLine({ ...base, shopifyStatus: "ACTIVE", shopifyUnitPrice: 25, shopifyCasePrice: 200 }, totals, DEFAULT_SETTINGS);
    expect(ok.casePriceKept).toBe(false);
    expect(ok.casePrice).toBe(200);
  });
  it("tolerates a rounding difference", () => {
    const ok = calcLine({ ...base, shopifyStatus: "ACTIVE", shopifyUnitPrice: 25, shopifyCasePrice: 200.3 }, totals, DEFAULT_SETTINGS);
    expect(ok.casePriceKept).toBe(false);
  });
  it("never applies to a DRAFT, whose prices are the template's placeholders", () => {
    const d = calcLine({ ...base, shopifyStatus: "DRAFT", shopifyUnitPrice: null, shopifyCasePrice: null }, totals, DEFAULT_SETTINGS);
    expect(d.casePriceKept).toBe(false);
  });
});

describe("calcLine — kg products sold per box", () => {
  // 10 kg for 180.80 PLN, per kg: goods 45.16384, duty 4 -> 49.16384 ; box of 1.5 kg -> 73.74576
  // x1.15 = 84.8076 ; x1.30 = 110.25 -> 110.5
  const kg: LineInput = {
    ...base,
    unit: "kilo",
    quantity: 10,
    lineValue: 180.8,
    netWeightKg: 10,
    dutyPerKg: 4,
    salesUnitKg: 1.5,
    pcsPerCarton: 10,
  };
  const r = calcLine(kg, { freightNok: 0, totalNetWeightKg: 1000 }, DEFAULT_SETTINGS);
  it("scales every per-unit amount to the box", () => {
    expect(r.goodsNok).toBeCloseTo(45.16384 * 1.5, 4);
    expect(r.dutyNok).toBeCloseTo(6, 6);
    expect(r.landedCost).toBeCloseTo(73.74576, 4);
    expect(r.suggestedPrice).toBe(110.5);
  });
  it("counts the boxes", () => {
    expect(r.soldUnits).toBeCloseTo(10 / 1.5, 6);
  });
  it("is per kg when no box size is set", () => {
    const perKg = calcLine({ ...kg, salesUnitKg: null }, { freightNok: 0, totalNetWeightKg: 1000 }, DEFAULT_SETTINGS);
    expect(perKg.landedCost).toBeCloseTo(49.16384, 4);
    expect(perKg.soldUnits).toBe(10);
  });
});

describe("calcLine — freight", () => {
  it("is spread over net weight: a heavy line carries more freight per unit", () => {
    // 3800 NOK / 1000 kg = 3.8 per kg. 5 kg over 10 units = 0.5 kg each -> 1.9 per unit.
    const r = calcLine({ ...base, quantity: 10, netWeightKg: 5 }, totals, DEFAULT_SETTINGS);
    expect(r.freightNok).toBeCloseTo(1.9, 6);
  });
  it("is zero when no freight has been entered yet", () => {
    const r = calcLine(base, { freightNok: 0, totalNetWeightKg: 1000 }, DEFAULT_SETTINGS);
    expect(r.freightNok).toBe(0);
  });
});

describe("calcLine — degenerate input", () => {
  it("does not divide by zero", () => {
    const r = calcLine({ ...base, quantity: 0 }, totals, DEFAULT_SETTINGS);
    expect(r.flags.missingQuantity).toBe(true);
    expect(r.landedCost).toBeNull();
    expect(Number.isNaN(r.goodsNok)).toBe(false);
  });
  it("flags a missing weight (duty and freight both depend on it)", () => {
    expect(calcLine({ ...base, netWeightKg: 0 }, totals, DEFAULT_SETTINGS).flags.missingWeight).toBe(true);
  });
});

describe("summarize", () => {
  const a = calcLine(base, totals, DEFAULT_SETTINGS); // sells 80 x 24.5
  const missing = calcLine({ ...base, dutyPerKg: null }, totals, DEFAULT_SETTINGS);
  const s = summarize([{ result: a }, { result: missing }], 750);
  it("sums sales and cost over priced rows, and counts the rest", () => {
    expect(s.unpricedRows).toBe(1);
    expect(s.salesInclVat).toBeCloseTo(80 * 24.5, 6);
    expect(s.costInclVat).toBeCloseTo(80 * 18.590785 + 750, 4);
  });
  it("shows the figures both incl. and excl. VAT", () => {
    expect(s.salesExclVat).toBeCloseTo((80 * 24.5) / 1.15, 6);
    expect(s.costExclVat).toBeCloseTo(80 * 16.1659 + 750, 4);
  });
  it("counts separate shipment costs (customs clearance, pallets) against profit", () => {
    const without = summarize([{ result: a }], 0);
    expect(without.profitInclVat - s.profitInclVat).toBeCloseTo(750, 6);
  });
});

describe("freightToNok", () => {
  it("converts with the freight currency's own rate", () => {
    expect(freightToNok(2400, "EUR", { EUR: 11, PLN: 2.498 })).toBe(26400);
    expect(freightToNok(3800, "NOK", {})).toBe(3800);
  });
  it("is null when the rate is missing, never a guess", () => {
    expect(freightToNok(100, "SEK", { EUR: 11 })).toBeNull();
  });
});

describe("VAT by customs code", () => {
  it("is 25 % for toys, cosmetics, hygiene and brushes, 15 % for food", () => {
    for (const hs of ["95030049", "33051000", "34011100", "34022000", "96031000"]) expect(isNonFoodVatHs(hs)).toBe(true);
    for (const hs of ["21041000", "22021000", "96131000", null, ""]) expect(isNonFoodVatHs(hs)).toBe(false);
  });
  it("is applied to the cost, and the mva-25 tag still works on its own", () => {
    const toy: LineInput = { ...base, hs: "95030049", dutyPerKg: 0 };
    expect(calcLine(toy, totals, DEFAULT_SETTINGS).vatRate).toBe(0.25);
    expect(calcLine({ ...base, hs: "21041000", dutyPerKg: 0 }, totals, DEFAULT_SETTINGS).vatRate).toBe(0.15);
    expect(calcLine({ ...base, hs: "21041000", dutyPerKg: 0, mva25: true }, totals, DEFAULT_SETTINGS).vatRate).toBe(0.25);
  });
});

describe("duty as a percentage of value, a typed packaging fee, and a drink priced by its declaration", () => {
  it("19 % of the goods value: Cedevita-style powder is charged on value, never per kg", () => {
    const r = calcLine({ ...base, hs: "21069039", dutyPerKg: null, dutyPctOfValue: 0.19 }, totals, DEFAULT_SETTINGS);
    const goods = (364 * 2.498) / 80;
    expect(r.dutyNok).toBeCloseTo(goods * 0.19, 6);
    expect(r.flags.missingDuty).toBe(false);
    // a percentage beats a kr/kg that is also present, so a stale value cannot double the duty
    const both = calcLine({ ...base, dutyPerKg: 5, dutyPctOfValue: 0.19 }, totals, DEFAULT_SETTINGS);
    expect(both.dutyNok).toBeCloseTo(goods * 0.19, 6);
    // 0 % is a real answer (EEA origin proof), not a missing one
    expect(calcLine({ ...base, dutyPerKg: null, dutyPctOfValue: 0 }, totals, DEFAULT_SETTINGS).dutyNok).toBe(0);
  });

  it("a typed packaging fee replaces the flat drink fee, and 0 means no fee", () => {
    const drink = { ...base, hs: "22021000", dutyPerKg: 0 };
    expect(calcLine(drink, totals, DEFAULT_SETTINGS).packagingNok).toBe(2);
    expect(calcLine({ ...drink, packagingOverride: 2.05 }, totals, DEFAULT_SETTINGS).packagingNok).toBe(2.05);
    expect(calcLine({ ...drink, packagingOverride: 0 }, totals, DEFAULT_SETTINGS).packagingNok).toBe(0);
  });

  it("a drink's duty stays 0 until a declaration priced the product itself; then what it charged counts", () => {
    const milkDrink = { ...base, hs: "22029999", dutyPerKg: 3.55, netWeightKg: 11, quantity: 50 };
    expect(calcLine(milkDrink, totals, DEFAULT_SETTINGS).dutyNok).toBe(0);
    expect(calcLine({ ...milkDrink, dutyDeclared: true }, totals, DEFAULT_SETTINGS).dutyNok).toBeCloseTo((3.55 * 11) / 50, 6);
    // a declared drink with no rate recorded is still 0, not "missing"
    expect(calcLine({ ...milkDrink, dutyPerKg: null, dutyDeclared: true }, totals, DEFAULT_SETTINGS).dutyNok).toBe(0);
  });
});
