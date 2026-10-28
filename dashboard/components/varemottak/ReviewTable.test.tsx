import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryDb, seedDefaults } from "@/lib/varemottak/db";
import { calculate } from "@/lib/varemottak/lines";
import { createShipment, getShipmentView, importInvoice, patchLine, patchShipment, type Ctx } from "@/lib/varemottak/service";
import { FakeShopify } from "@/lib/varemottak/shopify/fake";
import ReviewTable from "./ReviewTable";

const FWTER = path.resolve(__dirname, "../../../fwter");
const have = ["000033_S33_2026_spec.csv", "shopify-snapshot.json"].every((f) => existsSync(path.join(FWTER, f)));

// A server-side render of the review table over a real shipment: it proves the screen
// draws every row with real data, without needing a browser or a login.
describe.skipIf(!have)("ReviewTable over the real Stanro shipment", () => {
  async function render() {
    const db = new MemoryDb();
    seedDefaults(db);
    const ctx: Ctx = {
      db,
      shopify: FakeShopify.fromSnapshot(JSON.parse(readFileSync(path.join(FWTER, "shopify-snapshot.json"), "utf8"))),
      who: "t",
      log: async () => {},
      now: () => new Date("2026-10-09T12:00:00Z"),
    };
    const s = await createShipment(ctx, { name: "Stanro", supplierName: "Stanro" });
    await patchShipment(ctx, s.id, { rates: { PLN: 2.498 }, freight_amount: 3800 });
    await importInvoice(ctx, s.id, { spec: { bytes: new Uint8Array(readFileSync(path.join(FWTER, "000033_S33_2026_spec.csv"))), name: "a.csv" } });
    let view = await getShipmentView(ctx, s.id);
    // Give one product a duty so both states (missing / filled) are on screen.
    await patchLine(ctx, view.lines.find((l) => l.idx === "71806000AXE")!.id, { duty_per_kg: 1.5 });
    view = await getShipmentView(ctx, s.id);
    const calc = calculate(view.shipment, view.lines);
    const html = renderToStaticMarkup(<ReviewTable rows={calc.rows} emptyText="tom" onSave={() => {}} onPick={() => {}} />);
    return { html, calc, view };
  }

  it("draws one row per product, with the column headers from the spec", async () => {
    const { html } = await render();
    expect(html.match(/<tr/g)!.length).toBe(2 + 238); // group headings + column headings + rows
    for (const h of ["Art.nr", "Bilde", "Navn", "Toll kr/kg", "Kost inkl. mva", "Foreslått", "DIN PRIS", "Kartongpris", "Margin", "Forrige innkjøp", "Endring", "Pris i Shopify", "Salgsenhet kg"]) {
      expect(html).toContain(h);
    }
  });

  it("shows the product picture in the rows, lazily loaded and resized by Shopify's CDN", async () => {
    const { html } = await render();
    const imgs = html.match(/<img [^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(200);
    expect(imgs.every((i) => i.includes('loading="lazy"') && i.includes("width="))).toBe(true);
  });

  it("pins Art.nr, image and name on the left", async () => {
    const { html } = await render();
    expect(html).toContain("left:0;");
    expect(html).toContain("left:112px");
    expect(html).toContain("left:176px");
  });

  it("highlights missing duty yellow, and only where it is missing", async () => {
    const { html, calc } = await render();
    const missing = calc.rows.filter((r) => r.result.flags.missingDuty).length;
    expect(missing).toBeGreaterThan(100);
    expect((html.match(/w-24 bg-yellow-100/g) ?? []).length).toBe(missing);
  });

  it("offers a price choice on the one row with two prices for the same article", async () => {
    const { html } = await render();
    expect((html.match(/Velg pris …/g) ?? []).length).toBe(1);
  });

  it("marks new products and restocked ones", async () => {
    const { html } = await render();
    expect(html).toContain(">Ny<");
    expect(html).toContain(">Påfyll<");
  });

  it("never prints NaN or undefined", async () => {
    const { html } = await render();
    expect(html).not.toMatch(/NaN|undefined|\[object/);
  });

  it("says so when there is nothing to show", () => {
    const html = renderToStaticMarkup(<ReviewTable rows={[]} emptyText="Importer en faktura" onSave={() => {}} onPick={() => {}} />);
    expect(html).toContain("Importer en faktura");
  });
});
