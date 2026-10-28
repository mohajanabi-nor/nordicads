/**
 * The customs register on top of the database, and what happens when a declaration
 * arrives: its rates are recorded as verified, they replace estimates, and every product
 * they touch is recalculated — with a report of how much its cost and margin moved.
 *
 * The declaration PDF reader is a separate step (it needs an example); entering a
 * declaration's items by hand goes through exactly this code.
 */
import { calculate, type LineRow, type ShipmentRow } from "./lines";
import { dutyPerKgFromDeclaration, type CustomsRate } from "./customs";
import { getShipment, type Ctx } from "./service";

export interface RateRow extends CustomsRate {
  id: string;
  title_key: string | null;
  created_by: string | null;
  created_at: string;
}

const today = (ctx: Ctx) => ctx.now().toISOString().slice(0, 10);

export async function listRates(ctx: Ctx): Promise<RateRow[]> {
  return ctx.db.select<RateRow>("vm_customs_rates", { order: "source_date.desc" });
}

export interface NewRate {
  scope: "cn8" | "product";
  cn8?: string;
  supplier?: string;
  idx?: string;
  dutyPerKg: number;
  /** "typed by us, estimate" for hand-typed rates; a declaration number for verified ones. */
  sourceRef?: string;
  kind: "declaration" | "estimate";
  date?: string;
}

/** Checks a rate and shapes it as a row, without touching the database (the bulk importer inserts many at once). */
export function rateRow(ctx: Ctx, input: NewRate): Record<string, unknown> {
  if (!(input.dutyPerKg >= 0)) throw new Error("Toll kr/kg må være 0 eller mer");
  const cn8 = (input.cn8 ?? "").replace(/\D/g, "");
  if (input.scope === "cn8" && cn8.length !== 8) throw new Error("CN8 må være 8 siffer");
  if (input.scope === "product" && (!input.supplier || !input.idx)) throw new Error("Leverandør og varenummer mangler");
  if (input.scope === "cn8" && input.kind !== "declaration") throw new Error("En CN8-sats må komme fra en deklarasjon");
  return {
    scope: input.scope,
    cn8: input.scope === "cn8" ? cn8 : null,
    hs6: input.scope === "cn8" ? cn8.slice(0, 6) : null,
    supplier: input.scope === "product" ? input.supplier : null,
    idx: input.scope === "product" ? input.idx : null,
    title_key: null,
    duty_per_kg: input.dutyPerKg,
    source_kind: input.kind,
    source_ref: input.sourceRef?.trim() || (input.kind === "estimate" ? "typed by us, estimate" : "manuell"),
    source_date: input.date ?? today(ctx),
    created_by: ctx.who,
  };
}

/** Add a rate to the register by hand (and the one-off import of the client's existing rates uses rateRow). */
export async function addRate(ctx: Ctx, input: NewRate): Promise<RateRow> {
  const [row] = await ctx.db.insert<RateRow>("vm_customs_rates", rateRow(ctx, input));
  return row;
}

export async function deleteRate(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.remove("vm_customs_rates", { id: `eq.${id}` });
}

export interface DeclarationItem {
  cn8: string;
  /** Duty paid for the item in NOK: TL + RT (+ SU). The research levy (FA) is NOT included. */
  dutyNok: number;
  netWeightKg: number;
}

export interface CostChange {
  shipmentId: string;
  shipmentName: string;
  lineId: string;
  idx: string;
  name: string;
  cn8: string;
  dutyBefore: number | null;
  dutyAfter: number;
  costBefore: number | null;
  costAfter: number | null;
  marginBefore: number | null;
  marginAfter: number | null;
  pushed: boolean;
}

export interface DeclarationResult {
  declarationId: string;
  rates: Array<{ cn8: string; dutyPerKg: number }>;
  changes: CostChange[];
  /** Items whose weight was zero, so no rate could be derived. */
  skipped: string[];
}

/**
 * Record a customs declaration and recalculate the products it affects.
 *
 * Several items with the same CN8 are pooled (total duty ÷ total weight), because that
 * is the rate that reproduces what was actually paid. Lines already pushed are updated
 * too, and flagged in the result, since their cost in Shopify is now out of date.
 */
export async function applyDeclaration(
  ctx: Ctx,
  input: { number: string; date?: string | null; items: DeclarationItem[] },
): Promise<DeclarationResult> {
  const number = input.number.trim();
  if (!number) throw new Error("Deklarasjonsnummer mangler");
  if (!input.items.length) throw new Error("Deklarasjonen har ingen varelinjer");
  const existing = await ctx.db.select("vm_declarations", { number: `eq.${number}`, limit: 1 });
  if (existing.length) throw new Error(`Deklarasjon ${number} er allerede registrert`);

  // Pool items per CN8.
  const pooled = new Map<string, { duty: number; weight: number }>();
  const skipped: string[] = [];
  for (const it of input.items) {
    const cn8 = it.cn8.replace(/\D/g, "");
    if (cn8.length !== 8) throw new Error(`Ugyldig CN8 «${it.cn8}»`);
    if (!(it.netWeightKg > 0)) {
      skipped.push(cn8);
      continue;
    }
    const p = pooled.get(cn8) ?? { duty: 0, weight: 0 };
    p.duty += it.dutyNok;
    p.weight += it.netWeightKg;
    pooled.set(cn8, p);
  }
  const rates = Array.from(pooled, ([cn8, p]) => ({ cn8, dutyPerKg: dutyPerKgFromDeclaration(p.duty, p.weight) as number }));

  const [decl] = await ctx.db.insert<{ id: string }>("vm_declarations", {
    number,
    declared_at: input.date ?? null,
    file: null,
    items: input.items,
    created_by: ctx.who,
  });
  const date = input.date ?? today(ctx);
  for (const r of rates) {
    await addRate(ctx, { scope: "cn8", cn8: r.cn8, dutyPerKg: r.dutyPerKg, sourceRef: number, kind: "declaration", date });
  }

  // Recalculate: every line in a live shipment whose tariff number is one of these.
  const rateOf = new Map(rates.map((r) => [r.cn8, r.dutyPerKg]));
  const shipments = (await ctx.db.select<ShipmentRow>("vm_shipments")).filter((s) => s.status !== "archived");
  const changes: CostChange[] = [];

  for (const s of shipments) {
    const lines = await ctx.db.select<LineRow>("vm_lines", { shipment_id: `eq.${s.id}` });
    const affected = lines.filter((l) => {
      const cn8 = (l.hs ?? "").replace(/\D/g, "").slice(0, 8);
      const rate = rateOf.get(cn8);
      return rate !== undefined && !(l.duty_source_kind === "declaration" && Number(l.duty_per_kg) === rate);
    });
    if (!affected.length) continue;

    const before = calculate(s, lines);
    const afterLines = lines.map((l) => {
      if (!affected.includes(l)) return l;
      const cn8 = (l.hs ?? "").replace(/\D/g, "").slice(0, 8);
      return { ...l, duty_per_kg: rateOf.get(cn8) as number, duty_source_kind: "declaration" as const, duty_source: `Deklarasjon ${number}` };
    });
    const after = calculate(s, afterLines);

    for (const l of affected) {
      const b = before.rows.find((r) => r.line.id === l.id)!;
      const a = after.rows.find((r) => r.line.id === l.id)!;
      const cn8 = (l.hs ?? "").replace(/\D/g, "").slice(0, 8);
      changes.push({
        shipmentId: s.id,
        shipmentName: s.name,
        lineId: l.id,
        idx: l.idx,
        name: l.shopify?.title ?? l.name,
        cn8,
        dutyBefore: l.duty_per_kg === null ? null : Number(l.duty_per_kg),
        dutyAfter: rateOf.get(cn8) as number,
        costBefore: b.result.costInclVat,
        costAfter: a.result.costInclVat,
        marginBefore: b.result.margin,
        marginAfter: a.result.margin,
        pushed: !!l.pushed_at,
      });
      await ctx.db.update("vm_lines", { id: `eq.${l.id}` }, {
        duty_per_kg: rateOf.get(cn8),
        duty_source_kind: "declaration",
        duty_source: `Deklarasjon ${number}`,
        updated_at: ctx.now().toISOString(),
      });
    }
  }

  await ctx.log("info", "varemottak.declaration", `Deklarasjon ${number} registrert av ${ctx.who}: ${rates.length} satser, ${changes.length} varer omregnet`, {
    number,
  });
  return { declarationId: decl.id, rates, changes, skipped };
}

export { getShipment };
