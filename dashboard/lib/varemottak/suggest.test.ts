import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { MemoryDb, seedDefaults } from "./db";
import { createShipment, getShipmentView, importInvoice, patchShipment, setMatch, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";
import type { ShopProduct } from "./shopify/types";
import { rankCandidates, searchWords, sizesIn } from "./suggest";
import { searchForPicker, suggestForLine } from "./suggest-service";

const product = (o: Partial<ShopProduct> & { id: string; title: string }): ShopProduct => ({
  handle: "h",
  status: "ACTIVE",
  vendor: "",
  productType: "25",
  tags: [],
  imageUrl: null,
  variantId: `v${o.id}`,
  variantCount: 1,
  variantPrice: 200,
  unitCost: 10,
  inventoryItemId: `i${o.id}`,
  countryName: null,
  barcodes: [],
  ...o,
});

describe("sizesIn", () => {
  it("normalises sizes to grams / millilitres", () => {
    expect(sizesIn("LAYS 130G")).toEqual([130]);
    expect(sizesIn("Coca-Cola 0,5l")).toEqual([500]);
    expect(sizesIn("Rice 1,5 kg")).toEqual([1500]);
    expect(sizesIn("Cola 33cl")).toEqual([330]);
    expect(sizesIn("no size here")).toEqual([]);
  });
});

describe("rankCandidates", () => {
  const lays = product({ id: "1", title: "Lays Chips Natural Salt 21 X 130G", vendor: "Lays", barcodes: ["5900259129284"] });
  const lays125 = product({ id: "2", title: "Lays Chips Barbeque 125g x 21", vendor: "Lays" });
  const other = product({ id: "3", title: "Krakus Sour Rye Soup 8x1L", vendor: "Krakus" });

  it("ranks the same size above another size when the words are the same, and drops the unrelated", () => {
    const a = product({ id: "8", title: "Lays Salted Potato Crisps 130G", vendor: "Lays" });
    const b = product({ id: "9", title: "Lays Salted Potato Crisps 125G", vendor: "Lays" });
    const r = rankCandidates({ idx: "27702", name: "FRITO LAY LAY'S SALTED POTATO CRISPS 130G" }, [other, b, a]);
    expect(r.map((c) => c.product.id)).toEqual(["8", "9"]);
    expect(r[0].reasons.join()).toContain("Samme størrelse (130 g/ml)");
  });

  it("proposes a product on size alone, with the reason", () => {
    const r = rankCandidates({ idx: "27702", name: "FRITO LAY LAY'S SALTED POTATO CRISPS 130G" }, [other, lays]);
    expect(r.map((c) => c.product.id)).toEqual(["1"]);
    expect(r[0].reasons).toEqual(["Samme størrelse (130 g/ml)"]);
  });

  it("puts an EAN match first and says why", () => {
    const r = rankCandidates({ idx: "9", name: "Some chips", ean: "5900259129284" }, [lays125, lays]);
    expect(r[0].product.id).toBe("1");
    expect(r[0].reasons).toContain("EAN stemmer");
  });

  it("uses the article number as a tag, and the pack size", () => {
    const tagged = product({ id: "4", title: "Duru Black Beans 12 x 1kg", vendor: "Duru", tags: ["105080"] });
    const r = rankCandidates({ idx: "105080", name: "DURU BLACK BEANS 1KG", pcsPerCarton: 12 }, [tagged]);
    expect(r[0].reasons).toEqual(expect.arrayContaining(["Varenummeret er tagg på produktet", "Samme antall per kartong (12)"]));
  });

  it("prefers a draft slightly (a new product is a draft) without letting that beat a real signal", () => {
    const draft = product({ id: "5", title: "Lays Chips Natural Salt 130G", vendor: "Lays", status: "DRAFT" });
    const active = product({ id: "6", title: "Lays Chips Natural Salt 130G", vendor: "Lays" });
    expect(rankCandidates({ idx: "1", name: "LAYS SALT CHIPS 130G" }, [active, draft])[0].product.id).toBe("5");
    expect(rankCandidates({ idx: "1", name: "LAYS SALT CHIPS 130G", ean: "123456789" }, [draft, product({ ...active, id: "7", barcodes: ["123456789"] })])[0].product.id).toBe("7");
  });

  it("proposes nothing when nothing resembles the line — a guess would be worse than silence", () => {
    expect(rankCandidates({ idx: "1", name: "ZZZ QQQ" }, [lays, other])).toEqual([]);
  });

  it("limits the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => product({ id: String(i + 10), title: "Lays Chips 130g", vendor: "Lays" }));
    expect(rankCandidates({ idx: "1", name: "LAYS CHIPS 130G" }, many, 5)).toHaveLength(5);
  });
});

describe("searchWords", () => {
  it("picks the longest distinctive words", () => {
    const words = searchWords("FRITO LAY LAY'S SALTED POTATO CRISPS 130G");
    expect([...words].sort()).toEqual(["crisps", "potato", "salted"]); // the three longest, in no particular order
    expect(searchWords("FRITO LAY LAY'S SALTED POTATO CRISPS 130G", 2)).toHaveLength(2);
  });
});

// ---- the real file against the real catalogue (client files; skipped where absent)
const F = path.resolve(__dirname, "../../../fwter");
const have = existsSync(path.join(F, "01.xlsx")) && existsSync(path.join(F, "shopify-snapshot-all.json"));

describe.skipIf(!have)("the picker on the real Supplier 01 shipment", () => {
  const rows = () => XLSX.utils.sheet_to_json<Record<string, string>>(XLSX.readFile(path.join(F, "01.xlsx")).Sheets.Sheet0, { raw: false, defval: "" });

  async function setup(prepare?: (fake: FakeShopify) => void) {
    const fake = FakeShopify.fromSnapshot(JSON.parse(readFileSync(path.join(F, "shopify-snapshot-all.json"), "utf8")), { draftEvery: 0 });
    prepare?.(fake);
    const db = new MemoryDb();
    seedDefaults(db);
    const ctx: Ctx = { db, shopify: fake, who: "t", log: async () => {}, now: () => new Date("2026-10-09T12:00:00Z") };
    const s = await createShipment(ctx, { name: "S", supplierName: "Supplier 01 (Excel, PLN)", arrivalDate: "2026-10-08" });
    await patchShipment(ctx, s.id, { rates: { PLN: 2.5 } });
    await importInvoice(ctx, s.id, { spec: { bytes: new Uint8Array(readFileSync(path.join(F, "01.xlsx"))), name: "01.xlsx" } });
    return { ctx, fake, shipmentId: s.id, view: await getShipmentView(ctx, s.id) };
  }

  it("offers the two products an EAN contradiction is about, and the likely one for Lay's", async () => {
    const { ctx, view } = await setup();
    const milka = view.lines.find((l) => l.idx === "10930")!;
    const titles = (await suggestForLine(ctx, milka.id)).map((p) => p.title);
    expect(titles.some((t) => /Toffee Cr/.test(t))).toBe(true); // the product the tag points to
    expect(titles.some((t) => /Caramel Creme/.test(t))).toBe(true); // the product the barcode points to

    const lays = view.lines.find((l) => l.idx === "27702")!;
    const top = (await suggestForLine(ctx, lays.id))[0];
    expect(top.title).toBe("Lays Chips Natural Salt 21 X 130G");
    expect(top.reasons.join()).toContain("Samme størrelse");
  });

  it("flags a proposal that another row of the shipment already uses", async () => {
    const { ctx, view } = await setup();
    const a = view.lines.find((l) => l.idx === "27702")!; // doubtful: proposal is the Lays product
    const b = view.lines.find((l) => l.match_status === "matched" && l.shopify_product_id !== a.shopify_product_id)!;
    await setMatch(ctx, b.id, a.shopify_product_id!); // b is (wrongly) pointed at a's product
    const sug = await suggestForLine(ctx, a.id);
    expect(sug.find((p) => p.id === a.shopify_product_id)?.usedBy).toBe(b.idx);
  });

  it("finds a product by typed article number, by EAN, and by words", async () => {
    const { ctx } = await setup();
    expect((await searchForPicker(ctx, "27702")).map((p) => p.title)).toEqual(["Lays Chips Natural Salt 21 X 130G"]); // tag
    expect((await searchForPicker(ctx, "5900259129284")).map((p) => p.title)).toEqual(["Lays Chips Natural Salt 21 X 130G"]); // barcode
    expect((await searchForPicker(ctx, "lays salt")).length).toBeGreaterThan(0); // words
    expect(await searchForPicker(ctx, "ab")).toEqual([]); // too short to search
  });

  it("finds the right product among the proposals even when the shop has neither the tag nor the barcode", async () => {
    // For every fourth article, take the tag and the barcode off the right product — the worst case for the system.
    const expected = new Map<string, string>();
    const { ctx, view } = await setup((fake) => {
      [...new Set(rows().map((r) => r.INDEX))].forEach((idx, i) => {
        const p = fake.all().find((x) => x.tags.includes(idx));
        if (p && i % 4 === 0) {
          expected.set(idx, p.id);
          const live = fake.get(p.id)!;
          live.tags = live.tags.filter((t) => t !== idx);
          live.barcodes = [];
        }
      });
    });
    const ranks: number[] = [];
    for (const l of view.lines.filter((x) => expected.has(x.idx))) {
      ranks.push((await suggestForLine(ctx, l.id)).findIndex((p) => p.id === expected.get(l.idx)));
    }
    const within = (k: number) => ranks.filter((r) => r >= 0 && r < k).length / ranks.length;
    // measured on the real data: 83 % first, 91 % in the top three, 93 % in the list at all; the rest the operator finds by search
    expect(within(1)).toBeGreaterThanOrEqual(0.75);
    expect(within(3)).toBeGreaterThanOrEqual(0.85);
    expect(within(8)).toBeGreaterThanOrEqual(0.88);
  }, 300_000);
});
