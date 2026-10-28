/**
 * Grønt Punkt on top of the database: which beverage lines were imported in a term,
 * which packaging code each product has, and the report built from them.
 */
import {
  buildReport,
  isBeverageHs,
  parseTermCode,
  suggestGpCode,
  termForDate,
  sameTermLastYear,
  type GpCategory,
  type GpImportedUnits,
  type GpRate,
  type GpReport,
  type GpSuggestion,
} from "./gp";
import type { LineRow, ShipmentRow } from "./lines";
import { saveProductSettings, type Ctx, type ProductSettings } from "./service";

export interface BeverageProduct {
  productId: string | null;
  idx: string;
  name: string;
  shopifyTitle: string | null;
  /** How many units arrived across the shown shipments, for context. */
  units: number;
  gpCode: string | null;
  gpPackagingKg: number | null;
  suggestion: GpSuggestion;
}

export interface GpOverview {
  report: GpReport;
  categories: Array<GpCategory & { archived: boolean }>;
  rates: GpRate[];
  /** Beverages seen in these shipments, each with the code they are reported under. */
  products: BeverageProduct[];
  /** Beverage lines with no code yet — flagged at import, listed here. */
  unassigned: number;
  /** Shipments left out because they have no arrival date. */
  undated: string[];
}

export async function gpCategories(ctx: Ctx) {
  return ctx.db.select<GpCategory & { archived: boolean }>("vm_gp_categories", { order: "sort.asc" });
}

export async function gpRates(ctx: Ctx) {
  return ctx.db.select<GpRate>("vm_gp_rates", { order: "valid_from.asc" });
}

export async function gpOverview(ctx: Ctx, termCode: string): Promise<GpOverview> {
  const term = parseTermCode(termCode);
  if (!term) throw new Error("Ugyldig periode (bruk f.eks. 2026-RT3)");
  const from = sameTermLastYear(term).start;

  const [categories, rates, shipments, lines, settings] = await Promise.all([
    gpCategories(ctx),
    gpRates(ctx),
    ctx.db.select<ShipmentRow>("vm_shipments"),
    ctx.db.select<LineRow>("vm_lines"),
    ctx.db.select<ProductSettings>("vm_product_settings"),
  ]);
  const settingOf = new Map(settings.map((s) => [s.shopify_product_id, s]));
  const live = shipments.filter((s) => s.status !== "archived");
  const dated = new Map(live.filter((s) => s.arrival_date).map((s) => [s.id, s.arrival_date as string]));
  const undated = live.filter((s) => !s.arrival_date).map((s) => s.name);

  const rows: GpImportedUnits[] = [];
  const productMap = new Map<string, BeverageProduct>();
  let unassigned = 0;

  for (const l of lines) {
    const arrival = dated.get(l.shipment_id);
    if (!arrival || !isBeverageHs(l.hs) || arrival < from || arrival > term.end) continue;

    const set = l.shopify_product_id ? settingOf.get(l.shopify_product_id) : undefined;
    const code = set?.gp_code ?? null;
    const key = l.shopify_product_id ?? `idx:${l.idx}`;
    const existing = productMap.get(key);
    if (existing) existing.units += Number(l.qty);
    else {
      productMap.set(key, {
        productId: l.shopify_product_id,
        idx: l.idx,
        name: l.name,
        shopifyTitle: l.shopify?.title ?? null,
        units: Number(l.qty),
        gpCode: code,
        gpPackagingKg: set?.gp_packaging_kg === null || set?.gp_packaging_kg === undefined ? null : Number(set.gp_packaging_kg),
        // The shop title ("Mirinda 2L x 8") often omits the package type that the invoice name
        // states ("… pet 2.0l …", "… cans 0.5l …"), so read both.
        suggestion: suggestGpCode(`${l.name} ${l.shopify?.title ?? ""}`),
      });
    }
    if (!code) {
      // Only the current term's missing codes make the report incomplete; older ones are history.
      if (arrival >= term.start) unassigned++;
      continue;
    }
    rows.push({
      arrivalDate: arrival,
      code,
      units: Number(l.qty),
      packagingKg: set?.gp_packaging_kg === null || set?.gp_packaging_kg === undefined ? null : Number(set.gp_packaging_kg),
      idx: l.idx,
      name: l.shopify?.title ?? l.name,
    });
  }

  const report = buildReport(term, categories.filter((c) => !c.archived), rates, rows);
  if (unassigned) report.problems.unshift(`${unassigned} drikkevarelinje(r) i perioden mangler Grønt Punkt-kode og er ikke med i tallene`);
  if (undated.length) report.problems.push(`Forsendelser uten ankomstdato er ikke telt: ${undated.join(", ")}`);

  return {
    report,
    categories,
    rates,
    products: Array.from(productMap.values()).sort((a, b) => Number(!!a.gpCode) - Number(!!b.gpCode) || b.units - a.units),
    unassigned,
    undated,
  };
}

export async function setProductGp(
  ctx: Ctx,
  productId: string,
  input: { gpCode: string | null; gpPackagingKg: number | null },
): Promise<ProductSettings> {
  if (input.gpCode !== null) {
    const [cat] = await ctx.db.select<GpCategory>("vm_gp_categories", { code: `eq.${input.gpCode}`, limit: 1 });
    if (!cat) throw new Error(`Kategorien ${input.gpCode} finnes ikke`);
    if (cat.unit === "kg" && !(input.gpPackagingKg !== null && input.gpPackagingKg > 0)) {
      throw new Error(`Kategori ${cat.code} rapporteres i kg – legg inn emballasjevekt per flaske`);
    }
  }
  if (input.gpPackagingKg !== null && !(input.gpPackagingKg > 0 && input.gpPackagingKg < 5)) {
    throw new Error("Emballasjevekt per enhet må være over 0 og under 5 kg");
  }
  return saveProductSettings(ctx, productId, { gp_code: input.gpCode, gp_packaging_kg: input.gpPackagingKg });
}

export async function upsertCategory(
  ctx: Ctx,
  input: { code: string; name: string; unit: "kg" | "pcs"; rate: number; validFrom: string },
): Promise<void> {
  const code = input.code.trim();
  if (!/^\d{3,6}$/.test(code)) throw new Error("Koden må være 3–6 siffer");
  if (!input.name.trim()) throw new Error("Navn mangler");
  if (!(input.rate >= 0)) throw new Error("Satsen må være 0 eller mer");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validFrom)) throw new Error("Gyldig fra-dato må være ÅÅÅÅ-MM-DD");

  const [existing] = await ctx.db.select<GpCategory>("vm_gp_categories", { code: `eq.${code}`, limit: 1 });
  if (existing && existing.unit !== input.unit) throw new Error("Enheten på en eksisterende kategori kan ikke endres");
  if (!existing) {
    const all = await gpCategories(ctx);
    await ctx.db.insert("vm_gp_categories", { code, name: input.name.trim(), unit: input.unit, sort: (all.at(-1)?.sort ?? 0) + 10, archived: false });
  } else {
    await ctx.db.update("vm_gp_categories", { code: `eq.${code}` }, { name: input.name.trim(), archived: false });
  }
  await ctx.db.insert("vm_gp_rates", { code, valid_from: input.validFrom, rate: input.rate }, { onConflict: "code,valid_from", merge: true });
}

export async function archiveCategory(ctx: Ctx, code: string): Promise<void> {
  await ctx.db.update("vm_gp_categories", { code: `eq.${code}` }, { archived: true });
}

export { termForDate };
