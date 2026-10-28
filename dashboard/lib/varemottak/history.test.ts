import { describe, expect, it } from "vitest";
import { compareToHistory, summarizeImport, type PreviousPurchase } from "./history";

const prev = (o: Partial<PreviousPurchase> = {}): PreviousPurchase => ({
  unit_price: 4,
  currency: "PLN",
  our_price: 24.5,
  cost_incl_vat: 19,
  invoice_no: "000025/S33/2026",
  occurred_on: "2026-08-05",
  ...o,
});

describe("compareToHistory", () => {
  it("is 'new' with no history", () => {
    expect(compareToHistory(4.5, "PLN", null, null).direction).toBe("new");
  });
  it("up: change in percent", () => {
    const c = compareToHistory(4.5, "PLN", prev(), 24.5);
    expect(c.direction).toBe("up");
    expect(c.changePct).toBeCloseTo(0.125, 6);
    expect(c.previousUnitPrice).toBe(4);
  });
  it("down", () => {
    const c = compareToHistory(3.6, "PLN", prev(), 24.5);
    expect(c.direction).toBe("down");
    expect(c.changePct).toBeCloseTo(-0.1, 6);
  });
  it("ignores half-percent rounding noise", () => {
    expect(compareToHistory(4.01, "PLN", prev(), null).direction).toBe("same");
  });
  it("does not compare across currencies", () => {
    const c = compareToHistory(1.2, "EUR", prev(), null);
    expect(c.direction).toBe("other-currency");
    expect(c.changePct).toBeNull();
  });
  it("flags a supplier increase while our shop price did not move", () => {
    expect(compareToHistory(4.5, "PLN", prev(), 24.5).raisedWhileOurPriceUnchanged).toBe(true);
  });
  it("does not flag it when we already raised our price", () => {
    expect(compareToHistory(4.5, "PLN", prev(), 26).raisedWhileOurPriceUnchanged).toBe(false);
  });
  it("does not flag it for a DRAFT (no shop price to compare)", () => {
    expect(compareToHistory(4.5, "PLN", prev(), null).raisedWhileOurPriceUnchanged).toBe(false);
  });
  it("does not flag a price drop", () => {
    expect(compareToHistory(3.6, "PLN", prev(), 24.5).raisedWhileOurPriceUnchanged).toBe(false);
  });
});

describe("summarizeImport", () => {
  const row = (idx: string, pct: number | null, margin: number | null, dir?: "up" | "down" | "same" | "new", raised = false) => ({
    idx,
    name: idx,
    margin,
    change: {
      direction: dir ?? (pct === null ? "new" : pct > 0.005 ? "up" : pct < -0.005 ? "down" : "same"),
      previousUnitPrice: 1,
      previousDate: null,
      changePct: pct,
      raisedWhileOurPriceUnchanged: raised,
    } as const,
  });
  const s = summarizeImport(
    [row("A", 0.3, 0.2, "up", true), row("B", 0.1, 0.3, "up"), row("C", -0.05, 0.25), row("D", null, null), row("E", 0, 0.1), row("F", 0.5, 0.4, "up")],
    0.23,
    2,
  );
  it("counts the directions", () => {
    expect(s).toMatchObject({ total: 6, up: 3, down: 1, same: 1, new: 1 });
  });
  it("lists the largest increases, largest first", () => {
    expect(s.largestIncreases.map((r) => r.idx)).toEqual(["F", "A"]);
  });
  it("lists rows under the margin threshold, worst first", () => {
    expect(s.belowMargin.map((r) => r.idx)).toEqual(["E", "A"]);
  });
  it("counts supplier increases that came with an unchanged shop price", () => {
    expect(s.raisedWithoutPriceChange).toBe(1);
  });
});
