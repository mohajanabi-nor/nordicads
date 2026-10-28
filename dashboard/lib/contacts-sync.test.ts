import { describe, expect, it } from "vitest";
import { refreshDetailsFromShopify } from "./contacts";

describe("refreshDetailsFromShopify", () => {
  it("takes a changed name, company or city from Shopify", () => {
    const c = { name: "Ola Nordmann", company: "Gamle AS", city: "Oslo" };
    expect(refreshDetailsFromShopify(c, { name: "Ola N. Hansen", company: "Nye AS", city: "Bergen" })).toBe(true);
    expect(c).toEqual({ name: "Ola N. Hansen", company: "Nye AS", city: "Bergen" });
  });

  it("changes nothing, and says so, when Shopify agrees", () => {
    const c = { name: "Ola", company: "AS", city: "Oslo" };
    expect(refreshDetailsFromShopify(c, { name: " Ola ", company: "AS", city: "Oslo" })).toBe(false);
  });

  it("never erases what we hold because Shopify has a blank", () => {
    const c = { name: "Ola", company: "AS", city: "Oslo" };
    expect(refreshDetailsFromShopify(c, { name: "", company: "  ", city: undefined })).toBe(false);
    expect(c).toEqual({ name: "Ola", company: "AS", city: "Oslo" });
  });

  it("updates only the fields that differ", () => {
    const c = { name: "Ola", company: "AS", city: "Oslo" };
    expect(refreshDetailsFromShopify(c, { city: "Trondheim" })).toBe(true);
    expect(c).toEqual({ name: "Ola", company: "AS", city: "Trondheim" });
  });
});
