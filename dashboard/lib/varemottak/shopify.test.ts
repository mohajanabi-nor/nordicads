import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { impliedPackFromPrices, priceConsistencyWarning, resolveCarton, titlePackCount } from "./carton";
import { matchLine } from "./match";
import { mergeLines } from "./merge";
import { parseStanroCsv } from "./suppliers/stanro";
import { FakeShopify, PLACEHOLDER } from "./shopify/fake";
import { apiVersionSupportsProductUpdateInput } from "./shopify/live";
import { buildBatchRequest, chunk, formatDecimal, formatProductType, parseUnitPrice } from "./shopify/payloads";
import { LiveShopify } from "./shopify/live";
import { LiveWritesDisabledError, type PriceUpdate, type ShopProduct } from "./shopify/types";

const product = (o: Partial<ShopProduct> & { id: string }): ShopProduct => ({
  title: "Test product 8x1L",
  handle: "test",
  status: "ACTIVE",
  vendor: "Krakus",
  productType: "25",
  tags: [],
  imageUrl: null,
  variantId: `v${o.id}`,
  variantCount: 1,
  variantPrice: 200,
  unitCost: 19.66,
  inventoryItemId: `i${o.id}`,
  countryName: "Poland",
  barcodes: [],
  ...o,
});

const update = (o: Partial<PriceUpdate> & { productId: string }): PriceUpdate => ({
  variantId: `v${o.productId}`,
  productType: "28",
  casePrice: "224.00",
  unitCost: "21.50",
  activate: false,
  countryName: null,
  ...o,
});

describe("titlePackCount — shapes seen in the store", () => {
  it.each([
    ["Krakus Polsk Sour Rye soup / sur rug suppe 8x1L", 8],
    ["Red Bull Energy Classic Drink Boks 250Ml x 24", 24],
    ["Diamant Sugar Crystal 10 x 1 kg", 10],
    ["Zine Alsham Pickles 4 x 2,8 kg", 4],
    ["Dega Homemade Vegetable Salad XXL 4 x 1 Kg", 4],
    ["Duru Røde bønner (Fasulye) 1 kg x12", 12],
    ["Leis Spicy Marinated Tomato 900ml x12", 12],
    ["Sengeteppe 5 kg x 1", 1],
  ])("%s → %s", (title, expected) => expect(titlePackCount(title)).toBe(expected));
  it("gives nothing for the unfinished template titles", () => {
    expect(titlePackCount("Brajlovic Cold Smoked Beef Sujuk Sausage With Garlic 300g X")).toBeNull();
    expect(titlePackCount("Saleh Hvit ost Baladi 1 kg")).toBeNull();
  });
});

describe("pack from prices, productType and price formats", () => {
  it("derives the carton from the product's own prices", () => {
    expect(impliedPackFromPrices(200, "25")).toBe(8);
    expect(impliedPackFromPrices(690, "172,5")).toBe(4);
    expect(impliedPackFromPrices(460, "460")).toBe(1);
    expect(impliedPackFromPrices(100, "33")).toBeNull();
    expect(impliedPackFromPrices(100, "")).toBeNull();
  });
  it("reads both decimal styles that exist in the store", () => {
    expect(parseUnitPrice("8,5")).toBe(8.5);
    expect(parseUnitPrice("8.5")).toBe(8.5);
    expect(parseUnitPrice("125")).toBe(125);
    expect(parseUnitPrice("")).toBeNull();
    expect(parseUnitPrice("abc")).toBeNull();
  });
  it("writes Norwegian decimals", () => {
    expect(formatProductType(28)).toBe("28");
    expect(formatProductType(28.5)).toBe("28,5");
    expect(formatProductType(24.499)).toBe("24,5");
    expect(formatDecimal(196)).toBe("196.00");
  });
});

describe("resolveCarton — the client's rule", () => {
  it("ACTIVE: Shopify wins, and a mismatch warns with the invoice's figure", () => {
    const r = resolveCarton(product({ id: "1", title: "Krakus soup 8x1L" }), 10);
    expect(r.value).toBe(8);
    expect(r.source).toBe("shopify");
    expect(r.warnings.join()).toContain("Shopify 8, faktura 10");
  });
  it("ACTIVE: when the title and the price arithmetic disagree, the price arithmetic wins and the conflict is shown", () => {
    // Kinder Joy Spiderman: the title says 144 (the inner count), the product sells 24 per carton.
    const r = resolveCarton(product({ id: "1", title: "Kinder Joy Spiderman 20g x 144", variantPrice: 528, productType: "22" }), 24);
    expect(r).toMatchObject({ value: 24, source: "shopify" });
    expect(r.warnings.join()).toContain("ikke konsekvent");
  });
  it("ACTIVE: no warning when they agree", () => {
    expect(resolveCarton(product({ id: "1", title: "Krakus soup 8x1L" }), 8).warnings).toEqual([]);
  });
  it("ACTIVE: falls back to the price arithmetic when the title has no count", () => {
    const r = resolveCarton(product({ id: "1", title: "Saleh Yougurt", variantPrice: 376, productType: "47" }), null);
    expect(r.value).toBe(8);
  });
  it("ACTIVE: uses the invoice when Shopify has no figure", () => {
    const r = resolveCarton(product({ id: "1", title: "Plain", variantPrice: 100, productType: "33" }), 12);
    expect(r).toMatchObject({ value: 12, source: "invoice" });
  });
  it("DRAFT: the template's price arithmetic is ignored; the invoice wins", () => {
    const d = product({ id: "2", status: "DRAFT", title: "Hit Baton 300g X", variantPrice: 1000, productType: "125" });
    const r = resolveCarton(d, 24);
    expect(r).toMatchObject({ value: 24, source: "invoice" }); // 1000/125 = 8 must NOT be used
  });
  it("DRAFT: warns when the title already has a different count", () => {
    const r = resolveCarton(product({ id: "2", status: "DRAFT", title: "Hit Baton 220g x 12" }), 24);
    expect(r.value).toBe(24);
    expect(r.warnings.join()).toContain("fakturaen 24");
  });
  it("DRAFT: falls back to the title's count when the invoice cannot say, and flags it", () => {
    const d = product({ id: "2", status: "DRAFT", title: "Milky Clouds vanilla flavor 1kg X 1", variantPrice: 1000, productType: "125" });
    const r = resolveCarton(d, null);
    expect(r).toMatchObject({ value: 1, source: "title" });
    expect(r.warnings.join()).toContain("hentet fra tittelen");
  });
  it("DRAFT: no count anywhere stays empty", () => {
    expect(resolveCarton(product({ id: "2", status: "DRAFT", title: "Hit Baton 300g X" }), null)).toMatchObject({ value: null, source: "none" });
  });
  it("is empty when nothing knows", () => {
    expect(resolveCarton(null, null)).toMatchObject({ value: null, source: "none" });
  });
});

describe("priceConsistencyWarning (ACTIVE products)", () => {
  it("is quiet when stk-pris × pcs equals the Shopify price", () => {
    expect(priceConsistencyWarning(product({ id: "1" }), 8)).toBeNull();
  });
  it("flags a product where one price was changed without the other", () => {
    expect(priceConsistencyWarning(product({ id: "1", variantPrice: 230 }), 8)).toContain("200");
  });
  it("ignores DRAFTs", () => {
    expect(priceConsistencyWarning(product({ id: "1", status: "DRAFT", variantPrice: 1000, productType: "125" }), 7)).toBeNull();
  });
});

describe("matchLine", () => {
  const krakus = product({ id: "1", title: "901 Krakus Polsk Sour Rye soup / sur rug suppe 8x1L", vendor: "Krakus", tags: ["4252", "71806000AXE"] });
  it("matches on the article number tag", () => {
    const r = matchLine({ idx: "71806000AXE", name: "Krakus żurek soup 1.0l E Agros Nova" }, [krakus], null);
    expect(r).toMatchObject({ status: "matched", via: "tag", productId: "1" });
  });
  it("is case-insensitive on the tag", () => {
    expect(matchLine({ idx: "71806000axe", name: "Krakus soup" }, [krakus], null).status).toBe("matched");
  });
  it("is unmatched when no product carries the number", () => {
    expect(matchLine({ idx: "999", name: "Krakus soup" }, [krakus], null)).toMatchObject({ status: "unmatched", via: "none" });
  });
  it("prefers a saved link over everything", () => {
    const other = product({ id: "9", tags: [] });
    expect(matchLine({ idx: "71806000AXE", name: "x" }, [krakus], other)).toMatchObject({ status: "matched", via: "link", productId: "9" });
  });
  it("calls a tag hit with no brand and no shared word doubtful", () => {
    const r = matchLine({ idx: "71806000AXE", name: "Zupełnie inny produkt" }, [krakus], null);
    expect(r.status).toBe("doubtful");
    expect(r.productId).toBe("1");
  });
  it("singles out the right product when a number is shared, by vendor (105080)", () => {
    const duru = product({ id: "10", title: "Duru Black Beans 12 x 1kg", vendor: "Duru", tags: ["105080"] });
    const burjonka = product({ id: "11", title: "Burjonka Wafer Rolls With Halva Cream 300g x 12", vendor: "Burjonka", tags: ["105080"] });
    expect(matchLine({ idx: "105080", name: "Burjonka wafer rolls halva 300g" }, [duru, burjonka], null)).toMatchObject({ status: "matched", productId: "11" });
    expect(matchLine({ idx: "105080", name: "Duru fasulye black beans 1kg" }, [duru, burjonka], null)).toMatchObject({ status: "matched", productId: "10" });
  });
  it("leaves a shared number to the operator when the brand does not decide", () => {
    const a = product({ id: "10", vendor: "Duru", tags: ["105080"] });
    const b = product({ id: "11", vendor: "Burjonka", tags: ["105080"] });
    const r = matchLine({ idx: "105080", name: "Some beans" }, [a, b], null);
    expect(r.status).toBe("doubtful");
    expect(r.productId).toBeNull();
    expect(r.candidates).toHaveLength(2);
  });
});

describe("matchLine — the EAN cross-check", () => {
  const lays = product({ id: "1", title: "Lays Chips Natural Salt 21 X 130G", vendor: "Lays", tags: ["27702"], barcodes: ["5900259099181"] });
  const caramel = product({ id: "2", title: "Milka Caramel Creme 100g X 23", vendor: "Milka", tags: ["11111"], barcodes: ["7622210000001"] });
  const toffee = product({ id: "3", title: "Milka Toffee Crème Alpine Milk Chocolate 100G x 23", vendor: "Milka", tags: ["10930"], barcodes: ["7622210000999"] });

  it("a matching EAN confirms a tag match whose names look nothing alike (the Lay's case)", () => {
    // without the EAN this was 'doubtful': "FRITO LAY LAY'S SALTED POTATO CRISPS" shares no word with "Lays Chips Natural Salt"
    const noEan = matchLine({ idx: "27702", name: "FRITO LAY LAY'S SALTED POTATO CRISPS 130G" }, [lays], null);
    expect(noEan.status).toBe("doubtful");
    const withEan = matchLine({ idx: "27702", name: "FRITO LAY LAY'S SALTED POTATO CRISPS 130G", ean: "5900259099181" }, [lays], null, [lays]);
    expect(withEan).toMatchObject({ status: "matched", via: "tag", productId: "1", reason: "Varenummer-tagg og EAN stemmer" });
  });

  it("flags a tag whose EAN belongs to a different product — one of them is wrong (the Milka case)", () => {
    // the tag says Toffee, the barcode says Caramel
    const r = matchLine({ idx: "10930", name: "MILKA TOFFEE CREME ALPINE MILK CHOCOLATE 100G", ean: "7622210000001" }, [toffee], null, [caramel]);
    expect(r.status).toBe("doubtful");
    expect(r.productId).toBe("3"); // the tag product stays the proposal
    expect(r.candidates).toEqual(["2"]); // and the EAN product is offered next to it
    expect(r.reason).toContain("EAN peker på «Milka Caramel Creme");
  });

  it("finds a product by EAN alone when nothing carries the article number as a tag", () => {
    const r = matchLine({ idx: "99999", name: "Some product", eanBox: "7622210000001" }, [], null, [caramel]);
    expect(r).toMatchObject({ status: "matched", via: "ean", productId: "2" });
    expect(r.reason).toContain("Funnet på EAN");
  });

  it("does not guess when the EAN is on several products and there is no tag", () => {
    const twin = product({ id: "4", title: "Other", tags: [], barcodes: ["7622210000001"] });
    const r = matchLine({ idx: "99999", name: "x", ean: "7622210000001" }, [], null, [caramel, twin]);
    expect(r).toMatchObject({ status: "doubtful", via: "ean", productId: null });
    expect(r.candidates.sort()).toEqual(["2", "4"]);
  });

  it("uses the EAN to pick between products that share an article number", () => {
    const a = product({ id: "10", title: "Duru Black Beans", vendor: "Duru", tags: ["105080"], barcodes: ["111111111111"] });
    const b = product({ id: "11", title: "Burjonka Wafer Rolls", vendor: "Burjonka", tags: ["105080"], barcodes: ["222222222222"] });
    expect(matchLine({ idx: "105080", name: "Some beans", ean: "222222222222" }, [a, b], null, [b])).toMatchObject({ status: "matched", productId: "11" });
  });

  it("ignores leading zeros when comparing barcodes", () => {
    const p = product({ id: "5", tags: ["7"], barcodes: ["0012345678905"] });
    expect(matchLine({ idx: "7", name: "Krakus soup", ean: "12345678905" }, [p], null, [p]).reason).toBe("Varenummer-tagg og EAN stemmer");
  });

  it("agrees when the carton EAN also hits another product (two real cases: the tag product is still right)", () => {
    const tagP = product({ id: "6", title: "Malwa Lemon Balm With Orange Herbal Tea", vendor: "Malwa", tags: ["11008"], barcodes: ["5902781001038"] });
    const other = product({ id: "7", title: "Wedel Ptasie Mleczko", tags: ["105"], barcodes: ["5902781001038"] });
    expect(matchLine({ idx: "11008", name: "MALWA LEMON BALM WITH ORANGE HERBAL TEA", ean: "5902781001038" }, [tagP], null, [tagP, other])).toMatchObject({ status: "matched", productId: "6" });
  });

  it("changes nothing for a file without EANs (Stanro)", () => {
    expect(matchLine({ idx: "27702", name: "Krakus soup" }, [product({ id: "1", tags: ["27702"] })], null)).toMatchObject({ status: "matched", via: "tag" });
  });
});

describe("buildBatchRequest — what a push sends", () => {
  const req = buildBatchRequest([update({ productId: "1", activate: true, countryName: "Poland" }), update({ productId: "2" })], "gid://shopify/Publication/9");

  it("sends only price fields, status and the origin metafield", () => {
    expect(req.variables.p0).toEqual({
      id: "gid://shopify/Product/1",
      productType: "28",
      status: "ACTIVE",
      metafields: [{ namespace: "custom", key: "country_name", type: "single_line_text_field", value: "Poland" }],
    });
    expect(req.variables.p1).toEqual({ id: "gid://shopify/Product/2", productType: "28" }); // no status for an ACTIVE product
    expect(req.variables.v0).toEqual([{ id: "gid://shopify/ProductVariant/v1", price: "224.00", inventoryItem: { cost: "21.50" } }]);
  });
  it("publishes to the Online Store only the products being activated", () => {
    expect(req.query).toContain("m0_publish: publishablePublish");
    expect(req.query).not.toContain("m1_publish");
    expect(req.query).toContain("gid://shopify/Publication/9");
  });
  it("can never touch stock, tags, arrival date or collections", () => {
    const text = JSON.stringify(req).toLowerCase();
    for (const forbidden of ["inventorysetquantities", "inventoryadjust", "tagsadd", "tagsremove", "arrival_date", "collection", "\"tags\"", "quantities"]) {
      expect(text).not.toContain(forbidden);
    }
  });
  it("has syntactically valid GraphQL", async () => {
    const { parse } = await import("graphql");
    expect(() => parse(req.query)).not.toThrow();
  }, 60_000); // the first import of the graphql library can be slow on a busy machine
  it("batches about 20 products per request", () => {
    expect(chunk(Array.from({ length: 45 }, (_, i) => i)).map((c) => c.length)).toEqual([20, 20, 5]);
  });
  it("knows which API versions support productUpdate(product:)", () => {
    expect(apiVersionSupportsProductUpdateInput("2024-10")).toBe(true);
    expect(apiVersionSupportsProductUpdateInput("2026-04")).toBe(true);
    expect(apiVersionSupportsProductUpdateInput("2024-07")).toBe(false);
  });
});

describe("the live store refuses to write unless the owner switched it on", () => {
  it("throws before sending anything", async () => {
    delete process.env.VAREMOTTAK_LIVE_WRITES;
    await expect(new LiveShopify().pushBatch([update({ productId: "1" })])).rejects.toBeInstanceOf(LiveWritesDisabledError);
  });
});

describe("FakeShopify", () => {
  const seed = () =>
    new FakeShopify(
      [
        product({ id: "1", tags: ["A1", "nyhet"], status: "DRAFT", productType: "125", variantPrice: 1000, unitCost: 101.17, countryName: null }),
        product({ id: "2", tags: ["B2", "påfyll"], status: "ACTIVE", productType: "25", variantPrice: 200, unitCost: 19.66 }),
        product({ id: "3", title: "FAKE_ERROR product", tags: ["C3"] }),
      ],
      { "1": 0, "2": 8, "3": 5 },
    );

  it("finds products by tag, DRAFTs included", async () => {
    const f = seed();
    expect((await f.productsByTags(["A1", "B2"])).map((p) => p.id).sort()).toEqual(["1", "2"]);
    expect((await f.productsByTags(["a1"])).map((p) => p.id)).toEqual(["1"]);
  });

  it("applies a price update and activates a DRAFT", async () => {
    const f = seed();
    const [r] = await f.pushBatch([update({ productId: "1", activate: true, countryName: "Poland", productType: "28,5", casePrice: "228.00", unitCost: "21.50" })]);
    expect(r).toEqual({ productId: "1", ok: true, userErrors: [] });
    expect(f.get("1")).toMatchObject({ status: "ACTIVE", productType: "28,5", variantPrice: 228, unitCost: 21.5, countryName: "Poland" });
  });

  it("never changes stock or tags", async () => {
    const f = seed();
    const before = f.inventorySnapshot();
    await f.pushBatch([update({ productId: "1", activate: true }), update({ productId: "2" })]);
    const after = f.inventorySnapshot();
    expect(after.stock).toEqual(before.stock);
    expect(after.tags).toEqual(before.seededTags);
  });

  it("returns userErrors per row without stopping the batch", async () => {
    const f = seed();
    const results = await f.pushBatch([
      update({ productId: "1" }),
      update({ productId: "3" }), // FAKE_ERROR
      update({ productId: "999" }), // unknown
      update({ productId: "2", casePrice: "0.00" }), // invalid price
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false, false, false]);
    expect(results[1].userErrors[0].message).toContain("Simulated");
    expect(results[2].userErrors[0].message).toContain("does not exist");
    expect(results[3].userErrors[0].message).toContain("greater than 0");
    expect(f.get("2")!.variantPrice).toBe(200); // the failed row was not applied
  });

  it("re-push corrects prices and does not touch status again", async () => {
    const f = seed();
    await f.pushBatch([update({ productId: "1", activate: true, productType: "28" })]);
    await f.pushBatch([update({ productId: "1", activate: false, productType: "30", casePrice: "240.00" })]);
    expect(f.get("1")).toMatchObject({ status: "ACTIVE", productType: "30", variantPrice: 240 });
  });

  it("does not overwrite an existing origin", async () => {
    const f = seed();
    await f.pushBatch([update({ productId: "2", countryName: "Ukraine" })]);
    expect(f.get("2")!.countryName).toBe("Poland");
  });
});

// ------------------------------------------------------------ the real snapshot

const SNAPSHOT = path.resolve(__dirname, "../../../fwter/shopify-snapshot.json");
const CSV = path.resolve(__dirname, "../../../fwter/000033_S33_2026_spec.csv");

describe.skipIf(!existsSync(SNAPSHOT) || !existsSync(CSV))("Stanro shipment against the Shopify snapshot", () => {
  const fake = () => FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
  const merged = () => mergeLines(parseStanroCsv(new Uint8Array(readFileSync(CSV)), "spec.csv").lines);

  it("seeds 238 products, a fifth of them DRAFTs with the template's placeholder values", () => {
    const f = fake();
    expect(f.all()).toHaveLength(238);
    const drafts = f.all().filter((p) => p.status === "DRAFT");
    expect(drafts.length).toBeGreaterThan(40);
    expect(drafts.every((p) => p.variantPrice === PLACEHOLDER.variantPrice && p.productType === PLACEHOLDER.productType)).toBe(true);
  });

  it("matches every article number on the invoice", async () => {
    const f = fake();
    const lines = merged();
    const products = await f.productsByTags(lines.map((l) => l.idx));
    const results = lines.map((l) => ({ l, r: matchLine(l, products, null) }));
    const counts = { matched: 0, doubtful: 0, unmatched: 0 };
    for (const { r } of results) counts[r.status]++;
    expect(counts.unmatched).toBe(0);
    expect(counts.matched + counts.doubtful).toBe(238);
    // Most are certain; a few doubtful picks are acceptable, a flood is a matcher problem.
    expect(counts.matched).toBeGreaterThan(150);
  });

  it("pushes the whole shipment in batches of 20 without moving stock or tags", async () => {
    const f = fake();
    const before = f.inventorySnapshot();
    const lines = merged();
    const products = await f.productsByTags(lines.map((l) => l.idx));
    const updates = products.map((p) => update({ productId: p.id, variantId: p.variantId, activate: p.status === "DRAFT", countryName: "Poland" }));
    const out = [];
    for (const group of chunk(updates)) out.push(...(await f.pushBatch(group)));
    expect(out).toHaveLength(238);
    expect(out.every((r) => r.ok)).toBe(true);
    expect(f.calls.map((c) => c.length)).toEqual([20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 18]);
    expect(f.all().every((p) => p.status === "ACTIVE")).toBe(true);
    expect(f.inventorySnapshot().stock).toEqual(before.stock);
    expect(f.inventorySnapshot().tags).toEqual(before.seededTags);
  });
});
