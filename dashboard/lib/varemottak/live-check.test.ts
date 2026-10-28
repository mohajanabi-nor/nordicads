/**
 * OPT-IN checks against the real Shopify store. Read-only: it introspects the schema and runs
 * the same read queries the app runs; it never sends a mutation.
 *
 *   SHOPIFY_LIVE_CHECK=1 npx vitest run lib/varemottak/live-check.test.ts
 *
 * Credentials come from worker/.env (override the path with SHOPIFY_ENV_FILE).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildClientSchema, getIntrospectionQuery, Kind, parse, validate } from "graphql";
import { getVariableValues } from "graphql/execution/values";
import { describe, expect, it } from "vitest";
import { matchLine } from "./match";
import { mergeLines } from "./merge";
import { LiveShopify } from "./shopify/live";
import { buildBatchRequest } from "./shopify/payloads";
import { parseStanroCsv } from "./suppliers/stanro";

const ENV_FILE = process.env.SHOPIFY_ENV_FILE ?? path.resolve(__dirname, "../../../worker/.env");
const CSV = path.resolve(__dirname, "../../../fwter/000033_S33_2026_spec.csv");
const enabled = process.env.SHOPIFY_LIVE_CHECK === "1" && existsSync(ENV_FILE);

describe.skipIf(!enabled)("the real Shopify store (read-only)", () => {
  const env = Object.fromEntries(
    (enabled ? readFileSync(ENV_FILE, "utf8") : "")
      .split(/\r?\n/)
      .filter((l) => /^\s*SHOPIFY_/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
  const domain = "nordic-engros.myshopify.com"; // worker/.env carries a placeholder domain

  async function token() {
    const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, grant_type: "client_credentials" }),
    });
    return ((await res.json()) as { access_token: string }).access_token;
  }

  const sample = buildBatchRequest(
    [
      { productId: "1", variantId: "2", productType: "28,5", casePrice: "228.00", unitCost: "21.50", activate: true, countryName: "Poland" },
      { productId: "3", variantId: "4", productType: "30", casePrice: "240.00", unitCost: "22.00", activate: false, countryName: null },
    ],
    "gid://shopify/Publication/123",
  );

  describe.each(["2024-10", "2025-07", "2026-04"])("Admin API %s", (version) => {
    it("accepts the mutations Varemottak sends — document and variable values (nothing is sent)", async () => {
      const res = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await token() },
        body: JSON.stringify({ query: getIntrospectionQuery() }),
      });
      const body = (await res.json()) as { data?: Parameters<typeof buildClientSchema>[0]; errors?: unknown };
      expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
      // Shopify's schema trips graphql-js' strict self-check (an unrelated deprecation mismatch).
      const schema = buildClientSchema(body.data!, { assumeValid: true });

      expect(validate(schema, parse(sample.query)).map((e) => e.message)).toEqual([]);

      const op = parse(sample.query).definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION)!;
      const defs = (op as { variableDefinitions?: readonly never[] }).variableDefinitions ?? [];
      expect(getVariableValues(schema, defs, sample.variables).errors?.map((e) => e.message) ?? []).toEqual([]);
      // a deliberately wrong value is caught — the check above is not vacuous
      const bad = getVariableValues(schema, defs, { ...sample.variables, p0: { id: "gid://shopify/Product/1", productTypo: "x" } });
      expect((bad.errors ?? []).length).toBeGreaterThan(0);
    }, 120_000);
  });

  describe("the read queries the app runs", () => {
    Object.assign(process.env, { SHOPIFY_STORE_DOMAIN: domain, SHOPIFY_CLIENT_ID: env.SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET: env.SHOPIFY_CLIENT_SECRET, SHOPIFY_API_VERSION: env.SHOPIFY_API_VERSION || "2024-10" });
    const live = new LiveShopify();
    const lines = existsSync(CSV) ? mergeLines(parseStanroCsv(new Uint8Array(readFileSync(CSV)), "x").lines) : [];

    it("finds every Stanro article number by tag, and matches them all", async () => {
      const products = await live.productsByTags(lines.map((l) => l.idx));
      const results = lines.map((l) => matchLine(l, products, null));
      expect(results.filter((r) => r.status === "unmatched")).toHaveLength(0);
      expect(results.filter((r) => r.status === "matched").length).toBeGreaterThan(200);
      const p = products.find((x) => x.tags.includes("71806000AXE"))!;
      expect(p).toMatchObject({ vendor: "Krakus", status: "ACTIVE", variantCount: 1 });
      expect(p.variantPrice).toBeGreaterThan(0);
      expect(p.unitCost).toBeGreaterThan(0);
      expect(p.imageUrl).toMatch(/^https:\/\//);
    }, 180_000);

    it("reads products by id", async () => {
      const [first] = await live.productsByTags(["71806000AXE"]);
      const byId = await live.productsByIds([first.id]);
      expect(byId.get(first.id)?.title).toBe(first.title);
    }, 60_000);

    it("searches by text, as the match picker does", async () => {
      const hits = await live.searchProducts("krakus soup", 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => /krakus|soup/i.test(`${h.title} ${h.vendor}`))).toBe(true);
    }, 60_000);

    it("refuses to write while live writes are off", async () => {
      delete process.env.VAREMOTTAK_LIVE_WRITES;
      await expect(live.pushBatch([{ productId: "1", variantId: "2", productType: "1", casePrice: "1.00", unitCost: "1.00", activate: false, countryName: null }])).rejects.toThrow(/avslått/);
    });
  });
});
