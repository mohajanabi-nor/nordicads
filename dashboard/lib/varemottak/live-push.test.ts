/**
 * The live store's write path, with Shopify's transport mocked: nothing here can reach a real
 * shop. It checks what the code does with Shopify's answers — per-row userErrors, cost limits,
 * failures — because those are the situations a real push will meet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceUpdate } from "./shopify/types";

const gql = vi.fn();
vi.mock("../shopify-admin", () => ({
  shopifyConfig: () => ({ storeDomain: "x.myshopify.com", clientId: "id", clientSecret: "s", apiVersion: "2026-04" }),
  shopifyGraphQL: (...args: unknown[]) => gql(...args),
}));

const { LiveShopify } = await import("./shopify/live");

const update = (id: string, over: Partial<PriceUpdate> = {}): PriceUpdate => ({
  productId: id,
  variantId: `v${id}`,
  productType: "28",
  casePrice: "224.00",
  unitCost: "21.50",
  activate: false,
  countryName: null,
  ...over,
});

/** Shopify's answer for a mutation document: success for every alias, unless told otherwise. */
const answer = (query: string, errorsFor: Record<string, string> = {}) => {
  const data: Record<string, { userErrors: Array<{ field: string[] | null; message: string }> }> = {};
  for (const m of query.matchAll(/(m\d+_(?:product|variant|publish)):/g)) {
    const alias = m[1];
    data[alias] = { userErrors: errorsFor[alias] ? [{ field: ["x"], message: errorsFor[alias] }] : [] };
  }
  return data;
};

describe("LiveShopify.pushBatch", () => {
  beforeEach(() => {
    gql.mockReset();
    process.env.VAREMOTTAK_LIVE_WRITES = "1";
  });
  afterEach(() => {
    delete process.env.VAREMOTTAK_LIVE_WRITES;
  });

  it("refuses without the owner's switch, before any request", async () => {
    delete process.env.VAREMOTTAK_LIVE_WRITES;
    await expect(new LiveShopify().pushBatch([update("1")])).rejects.toThrow(/avslått/);
    expect(gql).not.toHaveBeenCalled();
  });

  it("maps each alias's userErrors to its own product", async () => {
    gql.mockImplementation(async (query: string) => answer(query, { m1_variant: "Price must be greater than 0" }));
    const out = await new LiveShopify().pushBatch([update("1"), update("2"), update("3")]);
    expect(out.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out[1].userErrors[0].message).toContain("greater than 0");
    expect(gql).toHaveBeenCalledTimes(1); // three products, one request
  });

  it("sends 20 products per request", async () => {
    gql.mockImplementation(async (query: string) => answer(query));
    await new LiveShopify().pushBatch(Array.from({ length: 45 }, (_, i) => update(String(i + 1))));
    expect(gql).toHaveBeenCalledTimes(3);
    const sizes = gql.mock.calls.map((c) => (String(c[0]).match(/m\d+_product:/g) ?? []).length);
    expect(sizes).toEqual([20, 20, 5]);
  });

  it("publishes a product it activates, and says so when the Online Store channel cannot be found", async () => {
    gql.mockImplementation(async (query: string) => {
      if (query.includes("publications(")) return { publications: { nodes: [{ id: "gid://shopify/Publication/9", name: "Online Store" }] } };
      return answer(query);
    });
    const out = await new LiveShopify().pushBatch([update("1", { activate: true }), update("2")]);
    expect(out.every((r) => r.ok)).toBe(true);
    const mutation = String(gql.mock.calls.find((c) => String(c[0]).includes("mutation"))![0]);
    expect(mutation).toContain("m0_publish: publishablePublish");
    expect(mutation).not.toContain("m1_publish");
  });

  it("splits a request Shopify refuses as too costly, and still sends every product", async () => {
    gql.mockImplementation(async (query: string) => {
      if ((query.match(/m\d+_product:/g) ?? []).length > 5) throw new Error("GraphQL-feil: MAX_COST_EXCEEDED");
      return answer(query);
    });
    const out = await new LiveShopify().pushBatch(Array.from({ length: 20 }, (_, i) => update(String(i + 1))));
    expect(out).toHaveLength(20);
    expect(out.every((r) => r.ok)).toBe(true);
    // 20 → 10+10 → 5+5+5+5, each accepted
    const accepted = gql.mock.calls.filter((c) => (String(c[0]).match(/m\d+_product:/g) ?? []).length <= 5).length;
    expect(accepted).toBe(4);
  });

  it("a failing batch marks only its own rows failed — the other batches are still sent", async () => {
    let call = 0;
    gql.mockImplementation(async (query: string) => {
      if (++call === 2) throw new Error("Shopify svarte 500");
      return answer(query);
    });
    const out = await new LiveShopify().pushBatch(Array.from({ length: 45 }, (_, i) => update(String(i + 1))));
    expect(out).toHaveLength(45);
    expect(out.slice(0, 20).every((r) => r.ok)).toBe(true);
    expect(out.slice(20, 40).every((r) => !r.ok && r.userErrors[0].message.includes("Shopify avviste kallet"))).toBe(true);
    expect(out.slice(40).every((r) => r.ok)).toBe(true);
  });
});
