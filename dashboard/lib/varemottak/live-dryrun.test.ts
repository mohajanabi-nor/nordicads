/**
 * OPT-IN, READ-ONLY: the whole Supplier 01 flow against the REAL Shopify catalogue, ending in a dry-run.
 *
 *   SHOPIFY_LIVE_CHECK=1 npx vitest run lib/varemottak/live-dryrun.test.ts
 *
 * Reads products from the live store and runs the same flow on the fake (snapshot). Nothing is written to
 * Shopify: the dry-run builds the request but never sends it, and live writes stay off.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb, seedDefaults } from "./db";
import { calcLine, createShipment, getShipmentView, importInvoice, patchLine, patchShipment, pushShipment, setDone, type Ctx } from "./service";
import { FakeShopify } from "./shopify/fake";
import { LiveShopify } from "./shopify/live";
import type { ShopifyPort } from "./shopify/types";

const F = path.resolve(__dirname, "../../../fwter");
const ENV_FILE = process.env.SHOPIFY_ENV_FILE ?? path.resolve(__dirname, "../../../worker/.env");
const enabled = process.env.SHOPIFY_LIVE_CHECK === "1" && existsSync(ENV_FILE) && existsSync(path.join(F, "01.xlsx")) && existsSync(path.join(F, "shopify-snapshot-all.json"));

describe.skipIf(!enabled)("Supplier 01 against the real catalogue (dry-run, nothing is sent)", () => {
  async function run(shopify: ShopifyPort) {
    const db = new MemoryDb();
    seedDefaults(db);
    const ctx: Ctx = { db, shopify, who: "t", log: async () => {}, now: () => new Date("2026-10-09T12:00:00Z") };
    const s = await createShipment(ctx, { name: "S", supplierName: "Supplier 01 (Excel, PLN)", arrivalDate: "2026-10-08" });
    await patchShipment(ctx, s.id, { rates: { PLN: 2.5 }, freightAmount: 5000, freightCurrency: "NOK" });
    await importInvoice(ctx, s.id, { spec: { bytes: new Uint8Array(readFileSync(path.join(F, "01.xlsx"))), name: "01.xlsx" } });
    const view = await getShipmentView(ctx, s.id);
    // Typed values the client has not sent yet: a flat duty of 5 kr/kg and 1 kg per kg-unit, only so rows can be priced.
    for (const l of view.lines) {
      const patch: Record<string, unknown> = { duty_per_kg: 5 };
      if (l.unit === "kilo") patch.sales_unit_kg = 1;
      await patchLine(ctx, l.id, patch);
    }
    const priced = (await getShipmentView(ctx, s.id)).lines;
    await setDone(ctx, s.id, priced.map((l) => l.id), true);
    const out = await pushShipment(ctx, s.id, { dryRun: true });
    return { view: await getShipmentView(ctx, s.id), out };
  }

  it("matches and builds the same payloads on the live catalogue as on the snapshot", async () => {
    delete process.env.VAREMOTTAK_LIVE_WRITES; // writes stay off, whatever the environment says
    const env = Object.fromEntries(
      readFileSync(ENV_FILE, "utf8")
        .split(/\r?\n/)
        .filter((l) => /^\s*SHOPIFY_/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
    Object.assign(process.env, { SHOPIFY_STORE_DOMAIN: "nordic-engros.myshopify.com", SHOPIFY_CLIENT_ID: env.SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET: env.SHOPIFY_CLIENT_SECRET, SHOPIFY_API_VERSION: env.SHOPIFY_API_VERSION || "2024-10" });

    const liveRun = await run(new LiveShopify());
    const fakeRun = await run(FakeShopify.fromSnapshot(JSON.parse(readFileSync(path.join(F, "shopify-snapshot-all.json"), "utf8")), { draftEvery: 0 }));

    const status = (r: typeof liveRun) => r.view.lines.reduce<Record<string, number>>((a, l) => ((a[l.match_status] = (a[l.match_status] ?? 0) + 1), a), {});
    console.log("LIVE match:", JSON.stringify(status(liveRun)), "| FAKE match:", JSON.stringify(status(fakeRun)));
    console.log("LIVE dry-run:", liveRun.out.mode, "requested", liveRun.out.requested, "blocked", liveRun.out.blocked.length, "requests", liveRun.out.requests?.length, "| FAKE:", fakeRun.out.requested, fakeRun.out.blocked.length, fakeRun.out.requests?.length);

    // Which rows differ between the live shop and the snapshot, and why (the shop may have changed since the snapshot).
    const payload = (r: typeof liveRun) => new Map(r.view.lines.map((l) => [l.idx, l.shopify_product_id]));
    const liveIds = payload(liveRun);
    const diffMatch = [...payload(fakeRun)].filter(([idx, id]) => liveIds.get(idx) !== id).map(([idx]) => idx);
    console.log("ROWS WITH A DIFFERENT PRODUCT live vs snapshot:", diffMatch.length, diffMatch.slice(0, 10).join(","));

    const vars = (r: typeof liveRun) => JSON.stringify(r.out.requests?.map((q) => q.variables));
    const same = vars(liveRun) === vars(fakeRun);
    console.log("PAYLOADS IDENTICAL:", same);
    if (!same) {
      const a = (liveRun.out.requests ?? []).flatMap((q) => Object.values(q.variables)).map((v) => JSON.stringify(v));
      const b = new Set((fakeRun.out.requests ?? []).flatMap((q) => Object.values(q.variables)).map((v) => JSON.stringify(v)));
      const only = a.filter((x) => !b.has(x));
      console.log("PAYLOAD VARIABLES ONLY ON LIVE:", only.length);
      // For each differing product, show the live value next to the snapshot's, and what the shop holds now.
      const flat = (r: typeof liveRun) => new Map((r.out.requests ?? []).flatMap((q) => Object.values(q.variables)).flatMap((v) => (Array.isArray(v) ? v : [v])).map((v) => [JSON.stringify(v).includes("inventoryItem") ? `V${(v as { id: string }).id}` : `P${(v as { id: string }).id}`, JSON.stringify(v)] as const));
      const lf = flat(liveRun);
      const ff = flat(fakeRun);
      const shown = [...lf].filter(([k, v]) => ff.get(k) !== v).slice(0, 6);
      for (const [k, v] of shown) console.log("DIFF", k, "| live:", v, "| snapshot:", ff.get(k));
      const kinds = [...lf].filter(([k, v]) => ff.get(k) !== v).reduce<Record<string, number>>((a, [k]) => ((a[k[0]] = (a[k[0]] ?? 0) + 1), a), {});
      console.log("DIFF BY KIND (P=productUpdate, V=variant):", JSON.stringify(kinds));
    }

    // Safety: only price fields and status/country, no stock, tags or arrival_date anywhere in what would be sent.
    const text = JSON.stringify(liveRun.out.requests);
    expect(text).not.toMatch(/inventorySetQuantities|tagsAdd|tagsRemove|arrival_date|"tags"/);
    expect(liveRun.out.mode).toBe("dry-run");
    expect(liveRun.out.sent).toBe(0);
    void calcLine;
  }, 600_000);
});
