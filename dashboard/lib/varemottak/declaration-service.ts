/**
 * A customs declaration PDF from the forwarder, read and applied.
 *
 *   1. Read it (declaration.ts) and run the control rule: statistical value + taxes must equal the VAT bases. Nothing is
 *      written unless it passes, because a misread declaration would put wrong duty on every product it touches.
 *   2. Tie each declared item to a row of the shipment it belongs to, by the supplier's article number (the declaration
 *      prints "ArtikkelNr").
 *   3. Put the declared rate on the row (a declaration always beats an estimate), the declared packaging fee per unit on
 *      drinks, and record the rates in the register: per CN8 (every distinct rate, so a code declared at two rates stays
 *      ambiguous) and per product.
 *   4. Recalculate and report how cost and margin moved, and which products now trip the price-increase alert.
 *
 * A draft declaration applies too, marked as such, and is replaced when the final one is uploaded. The same final
 * declaration twice is refused.
 */
import { controlDeclaration, dutyKrPerKg, packagingFeesNok, parseDeclaration, type ParsedDeclaration } from "./declaration";
import { isDrinkHs } from "./calc";
import { rateRow, type CostChange } from "./customs-service";
import { priceAlert } from "./history";
import { calculate, type LineRow, type ShipmentRow } from "./lines";
import type { Ctx } from "./service";

export interface DeclarationChange extends CostChange {
  packagingBefore: number | null;
  packagingAfter: number | null;
  /** Set when the new cost trips the price-increase alert against the previous purchase. */
  alert: string | null;
}

export interface DeclarationReport {
  number: string;
  status: ParsedDeclaration["status"];
  date: string | null;
  currency: string | null;
  rate: number | null;
  itemCount: number;
  /** Items tied to a row of a shipment. */
  matchedItems: number;
  unmatchedItems: Array<{ varepost: number; articleNo: string; name: string; cn8: string }>;
  /**
   * Sausages (HS 1601) the declaration charged 0 duty on (tariff quota). The rate is applied as declared, but the same product
   * has paid 84,31 kr/kg on other declarations, so the client looks at each one and may price it at the higher rate.
   */
  decisions: Array<{ lineId: string; shipmentName: string; idx: string; name: string; cn8: string; declaredDutyPerKg: number }>;
  ratesAdded: { cn8: number; product: number };
  /** A draft of the same declaration was replaced by this one. */
  replacedDraft: boolean;
  changes: DeclarationChange[];
  /** The shipment's exchange rate differs from the declaration's: shown, never overwritten. */
  rateDifferences: Array<{ shipmentName: string; currency: string; shipmentRate: number; declarationRate: number }>;
}

export type DeclarationOutcome =
  | { ok: false; checks: Array<{ code: string; ok: boolean; text: string }>; number: string | null }
  | { ok: true; checks: Array<{ code: string; ok: boolean; text: string }>; report: DeclarationReport };

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const norm = (s: string) => s.trim().toLowerCase();

export async function importDeclarationPdf(ctx: Ctx, file: { bytes: Uint8Array; name: string }): Promise<DeclarationOutcome> {
  let parsed: ParsedDeclaration;
  try {
    parsed = await parseDeclaration(file.bytes);
  } catch {
    throw new Error("Filen kunne ikke leses som en tolldeklarasjon. Last opp PDF-en du fikk fra speditøren.");
  }
  const control = controlDeclaration(parsed);
  if (!control.ok || !parsed.number) return { ok: false, checks: control.checks, number: parsed.number };
  const number = parsed.number;

  // The same declaration again: a draft is replaced by whatever comes next, a final one stays.
  const [existing] = await ctx.db.select<{ id: string; status: string | null }>("vm_declarations", { number: `eq.${number}`, limit: 1 });
  let replacedDraft = false;
  if (existing) {
    if ((existing.status ?? "final") !== "draft") throw new Error(`Deklarasjon ${number} er allerede registrert`);
    await ctx.db.remove("vm_customs_rates", { source_ref: `in.("${number}","${number} (utkast)")`, source_kind: "eq.declaration" });
    await ctx.db.remove("vm_declarations", { id: `eq.${existing.id}` });
    replacedDraft = true;
  }
  const sourceRef = parsed.status === "draft" ? `${number} (utkast)` : number;
  const date = parsed.date ?? ctx.now().toISOString().slice(0, 10);

  // Which shipment is this declaration for? The one whose rows carry most of its article numbers.
  const shipments = (await ctx.db.select<ShipmentRow>("vm_shipments", {})).filter((s) => s.status !== "archived");
  const linesOf = new Map<string, LineRow[]>();
  for (const s of shipments) linesOf.set(s.id, await ctx.db.select<LineRow>("vm_lines", { shipment_id: `eq.${s.id}` }));
  const hits = shipments.map((s) => ({ s, n: parsed.items.filter((it) => it.articleNo && (linesOf.get(s.id) ?? []).some((l) => norm(l.idx) === norm(it.articleNo))).length }));
  const best = Math.max(0, ...hits.map((h) => h.n));
  const targets = best > 0 ? hits.filter((h) => h.n === best).map((h) => h.s) : [];

  interface Match { item: ParsedDeclaration["items"][number]; line: LineRow; shipment: ShipmentRow }
  const matches: Match[] = [];
  const unmatched: DeclarationReport["unmatchedItems"] = [];
  for (const item of parsed.items) {
    let found = false;
    for (const s of targets) {
      const line = (linesOf.get(s.id) ?? []).find((l) => item.articleNo && norm(l.idx) === norm(item.articleNo));
      if (line) {
        matches.push({ item, line, shipment: s });
        found = true;
      }
    }
    if (!found) unmatched.push({ varepost: item.varepost, articleNo: item.articleNo, name: item.name, cn8: item.cn8 });
  }

  // ---- the register: every distinct rate per CN8, and the product's own rate ----
  const cn8Rows = new Map<string, Record<string, unknown>>();
  for (const item of parsed.items) {
    const rate = dutyKrPerKg(item);
    if (rate === null || item.cn8.length !== 8) continue;
    const key = `${item.cn8}|${rate}`;
    if (!cn8Rows.has(key)) cn8Rows.set(key, rateRow(ctx, { scope: "cn8", cn8: item.cn8, dutyPerKg: rate, kind: "declaration", sourceRef, date }));
  }
  const productRows: Array<Record<string, unknown>> = [];
  for (const m of matches) {
    const rate = dutyKrPerKg(m.item);
    if (rate === null) continue;
    productRows.push(rateRow(ctx, { scope: "product", supplier: m.shipment.supplier_name, idx: m.line.idx, dutyPerKg: rate, kind: "declaration", sourceRef, date }));
  }
  // Estimates for these products are superseded: a declaration always wins.
  for (const m of matches) {
    await ctx.db.remove("vm_customs_rates", { scope: "eq.product", supplier: `eq.${m.shipment.supplier_name}`, idx: `eq.${m.line.idx}`, source_kind: "eq.estimate" });
  }
  if (cn8Rows.size) await ctx.db.insert("vm_customs_rates", [...cn8Rows.values()]);
  if (productRows.length) await ctx.db.insert("vm_customs_rates", productRows);

  await ctx.db.insert("vm_declarations", {
    number,
    declared_at: parsed.date,
    file: file.name,
    status: parsed.status === "draft" ? "draft" : "final",
    items: parsed.items.map((it) => ({ varepost: it.varepost, articleNo: it.articleNo, cn8: it.cn8, netWeightKg: it.netKg, dutyKrPerKg: dutyKrPerKg(it), packagingNok: packagingFeesNok(it) })),
    created_by: ctx.who,
  });

  // ---- the rows: declared duty, declared packaging, then the before/after ----
  const changes: DeclarationChange[] = [];
  const decisions: DeclarationReport["decisions"] = [];
  const rateDifferences: DeclarationReport["rateDifferences"] = [];
  for (const s of targets) {
    const lines = linesOf.get(s.id) ?? [];
    const mine = matches.filter((m) => m.shipment.id === s.id);
    const patchOf = new Map<string, Partial<LineRow>>();
    for (const { item, line } of mine) {
      const rate = dutyKrPerKg(item);
      const fees = packagingFeesNok(item);
      const qty = Number(line.qty);
      const patch: Partial<LineRow> = {};
      if (rate === 0 && item.cn8.startsWith("1601")) decisions.push({ lineId: line.id, shipmentName: s.name, idx: line.idx, name: line.shopify?.title ?? line.name, cn8: item.cn8, declaredDutyPerKg: rate });
      if (rate !== null) Object.assign(patch, { duty_per_kg: rate, duty_pct: null, duty_source: `Deklarasjon ${sourceRef}`, duty_source_kind: "declaration" as const });
      if (qty > 0 && fees > 0) patch.packaging_nok = round4(fees / qty);
      else if (isDrinkHs(item.cn8) || isDrinkHs(line.hs)) patch.packaging_nok = 0; // a drink the declaration charged no fee for
      if (Object.keys(patch).length) patchOf.set(line.id, patch);
    }
    const before = calculate(s, lines);
    const afterLines = lines.map((l) => (patchOf.has(l.id) ? ({ ...l, ...patchOf.get(l.id) } as LineRow) : l));
    const after = calculate(s, afterLines);
    for (const [lineId, patch] of patchOf) {
      const b = before.rows.find((r) => r.line.id === lineId)!;
      const a = after.rows.find((r) => r.line.id === lineId)!;
      const l = b.line;
      const alert = priceAlert(l.history?.change, l.history?.previous, a.result.costInclVat);
      changes.push({
        shipmentId: s.id,
        shipmentName: s.name,
        lineId,
        idx: l.idx,
        name: l.shopify?.title ?? l.name,
        cn8: (l.hs ?? "").replace(/\D/g, "").slice(0, 8),
        dutyBefore: l.duty_per_kg === null ? null : Number(l.duty_per_kg),
        dutyAfter: patch.duty_per_kg !== undefined && patch.duty_per_kg !== null ? Number(patch.duty_per_kg) : Number(l.duty_per_kg ?? 0),
        costBefore: b.result.costInclVat,
        costAfter: a.result.costInclVat,
        marginBefore: b.result.margin,
        marginAfter: a.result.margin,
        pushed: !!l.pushed_at,
        packagingBefore: b.result.packagingNok,
        packagingAfter: a.result.packagingNok,
        alert: alert ? [alert.costPct !== null ? `kost +${Math.round(alert.costPct * 1000) / 10} %` : "", alert.supplierPct !== null ? `leverandør +${Math.round(alert.supplierPct * 1000) / 10} %` : ""].filter(Boolean).join(", ") : null,
      });
      await ctx.db.update("vm_lines", { id: `eq.${lineId}` }, { ...patch, updated_at: ctx.now().toISOString() });
    }

    // The exchange rate on the declaration (box 23): filled in when the shipment has none, otherwise only reported.
    if (parsed.currency && parsed.rate && parsed.currency !== "NOK") {
      const own = Number(s.rates[parsed.currency]) || 0;
      if (!own) await ctx.db.update("vm_shipments", { id: `eq.${s.id}` }, { rates: { ...s.rates, [parsed.currency]: parsed.rate }, updated_at: ctx.now().toISOString() });
      else if (Math.abs(own - parsed.rate) > 0.0005) rateDifferences.push({ shipmentName: s.name, currency: parsed.currency, shipmentRate: own, declarationRate: parsed.rate });
    }
  }

  await ctx.log("info", "varemottak.declaration.pdf", `Deklarasjon ${sourceRef} lest inn av ${ctx.who}: ${matches.length} av ${parsed.items.length} poster koblet, ${changes.length} varer omregnet`, { number, file: file.name });
  return {
    ok: true,
    checks: control.checks,
    report: {
      number,
      status: parsed.status,
      date: parsed.date,
      currency: parsed.currency,
      rate: parsed.rate,
      itemCount: parsed.items.length,
      matchedItems: new Set(matches.map((m) => m.item.varepost)).size,
      unmatchedItems: unmatched,
      decisions,
      ratesAdded: { cn8: cn8Rows.size, product: productRows.length },
      replacedDraft,
      changes,
      rateDifferences,
    },
  };
}
