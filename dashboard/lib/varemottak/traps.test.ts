/**
 * The client's documented traps (package 6_special_cases.md, "Matching traps" and "Things a new person gets wrong"),
 * run against the real Shopify snapshot. Client files: skipped where absent.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchLine, packSizes } from "./match";
import { FakeShopify } from "./shopify/fake";

const SNAP = path.resolve(__dirname, "../../../fwter/shopify-snapshot-all.json");
const have = existsSync(SNAP);

describe.skipIf(!have)("matching traps from the client's real deliveries", () => {
  const shop = have ? FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAP, "utf8")), { draftEvery: 0 }) : (null as unknown as FakeShopify);

  const match = async (idx: string, name: string) => {
    const tagged = await shop.productsByTags([idx]);
    return { tagged, result: matchLine({ idx, name }, tagged, null, []) };
  };

  it("59214: the tag sits on Prince Polo Black Dark, the invoice says Milk Crispy → asks, never silently matches", async () => {
    const { tagged, result } = await match("59214", "PRINCE POLO XXL MILK CRISPY 28G");
    console.log("59214 tagged:", tagged.map((p) => p.title), "->", result.status, result.reason);
    expect(result.status).toBe("doubtful");
    expect(result.reason).toMatch(/størrelsen/);
  });

  it("pack sizes in names: units, decimals, multipacks", () => {
    expect(packSizes("PRINCE POLO XXL MILK CRISPY 28G")).toEqual([28]);
    expect(packSizes("Kwas 0,5L")).toEqual([500]);
    expect(packSizes("Lollipops 2400 g (200 Pieces)")).toEqual([2400]);
    expect(packSizes("Chupa Chups Lollipops 12g x 200")).toEqual([12, 2400]);
    expect(packSizes("Bake Rolls 6 x 1kg")).toEqual([1000, 6000]);
    expect(packSizes("Pickles 2.4kg")).toEqual([2400]);
    expect(packSizes("No size here x 12")).toEqual([]);
  });

  it("51116: one number on two products (a Lisner herring and a Maestro spice) – the brand tells them apart", async () => {
    const spice = await match("51116", "MAESTRO ALLKRYDDA 850G");
    const herring = await match("51116", "LISNER CHANTERELLES MILD MARINATED HERRING FILLETS 600G");
    console.log("51116 spice ->", spice.result.reason, "| herring ->", herring.result.reason);
    expect(spice.result.status).toBe("matched");
    expect(herring.result.status).toBe("matched");
    expect(spice.result.productId).not.toBe(herring.result.productId);
  });

  it("105080 / 105081: Burjonka, not Duru beans", async () => {
    const { tagged, result } = await match("105080", "DURU BEANS 400G");
    console.log("105080 tagged:", tagged.map((p) => `${p.vendor}: ${p.title}`), "->", result.status, result.reason);
    const right = await match("105080", "BURJONKA CHOCOLATE SPREAD");
    console.log("105080 as Burjonka ->", right.result.status);
  });

  it("one Shopify product carrying two suppliers' numbers (8623 and 714540001TX) is found from either number", async () => {
    const a = await match("8623", "TARCZYNSKI SILESIAN KIELBASA SLASKA");
    const b = await match("714540001TX", "TARCZYNSKI SILESIAN KIELBASA SLASKA");
    console.log("8623 ->", a.result.status, a.result.productId, "| 714540001TX ->", b.result.status, b.result.productId);
    expect(a.result.productId).toBeTruthy();
    expect(a.result.productId).toBe(b.result.productId);
  });
});
