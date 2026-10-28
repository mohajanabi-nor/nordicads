"use client";

/**
 * The review table: one row per product, product picture always visible, Art.nr / image /
 * name pinned on the left while the rest scrolls sideways.
 *
 * Colours (the client's): missing duty yellow, margin under the threshold red, supplier
 * price up = red row, price down = green row.
 */
import { memo, useState } from "react";
import { isNonFoodVatHs } from "@/lib/varemottak/calc";
import { changedSincePush as hasChangedSincePush, type CalculatedLine, type LineRow } from "@/lib/varemottak/lines";
import { Badge, NumCell, Thumb, fmt, fmtPct } from "./cells";
import { useTr } from "./useTr";

// Sticky column geometry (px): Art.nr, image, name.
const W = { art: 112, img: 64, name: 250 } as const;
const LEFT = { art: 0, img: W.art, name: W.art + W.img } as const;

export default function ReviewTable({
  rows,
  emptyText,
  onSave,
  onPick,
}: {
  rows: CalculatedLine[];
  emptyText: string;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onPick: (line: LineRow) => void;
}) {
  const { t } = useTr();
  return (
    <div data-testid="review-table" className="max-h-[78vh] overflow-auto rounded-2xl border border-line bg-white">
      <table className="min-w-max border-separate border-spacing-0 text-xs">
        <thead>
          <tr className="text-left text-[10px] font-bold uppercase tracking-[0.05em] text-[#5a5242]">
            <Band span={3} sticky>{t("Produkt", "Product")}</Band>
            <Band span={1} />
            <Band span={6}>{t("Fra fakturaen", "From the invoice")}</Band>
            <Band span={8}>{t("Kost per enhet, NOK", "Cost per unit, NOK")}</Band>
            <Band span={4} tint>{t("Pris", "Price")}</Band>
            <Band span={2}>{t("Forrige innkjøp", "Last purchase")}</Band>
            <Band span={2}>{t("I Shopify", "In Shopify")}</Band>
            <Band span={1}>{t("Kg-varer", "Kg goods")}</Band>
            <Band span={1}>{t("Merknader", "Notes")}</Band>
          </tr>
          <tr className="text-left text-[11px] uppercase tracking-wide text-[#5a5242]">
            <Th sticky style={{ left: LEFT.art, width: W.art, minWidth: W.art }} corner>{t("Art.nr", "Item no.")}</Th>
            <Th sticky style={{ left: LEFT.img, width: W.img, minWidth: W.img }} corner>{t("Bilde", "Image")}</Th>
            <Th sticky style={{ left: LEFT.name, width: W.name, minWidth: W.name }} corner edge>{t("Navn", "Name")}</Th>
            <Th>{t("Ferdig", "Done")}</Th>
            <Th>HS</Th>
            <Th>{t("Opprinn.", "Origin")}</Th>
            <Th>{t("Enhet", "Unit")}</Th>
            <Th right>{t("Antall", "Qty")}</Th>
            <Th right>{t("Stk/kart.", "Pcs/ctn")}</Th>
            <Th right>{t("Pris/enhet", "Price/unit")}</Th>
            <Th right>{t("Varekost NOK", "Goods cost NOK")}</Th>
            <Th right tint>{t("Toll kr/kg", "Duty NOK/kg")}</Th>
            <Th right>{t("Toll/enhet", "Duty/unit")}</Th>
            <Th right>{t("Emb.", "Pkg.")}</Th>
            <Th right>{t("Frakt/enhet", "Freight/unit")}</Th>
            <Th right>Landed</Th>
            <Th right>{t("MVA", "VAT")}</Th>
            <Th right>{t("Kost inkl. mva", "Cost incl. VAT")}</Th>
            <Th right>{t("Forslag", "Suggested")}</Th>
            <Th right tint>{t("DIN PRIS", "YOUR PRICE")}</Th>
            <Th right>{t("Kartongpris", "Carton price")}</Th>
            <Th right>Margin</Th>
            <Th right>{t("Forrige innkjøp", "Prev. purchase")}</Th>
            <Th right>{t("Endring", "Change")}</Th>
            <Th>Shopify</Th>
            <Th right>{t("Pris i Shopify", "Shopify price")}</Th>
            <Th right>{t("Salgsenhet kg", "Sales unit kg")}</Th>
            <Th>{t("Å se på", "What to look at")}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <Row key={c.line.id} c={c} onSave={onSave} onPick={() => onPick(c.line)} />
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={28} className="px-4 py-10 text-center text-mute">
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Height of the group-heading row; the column-heading row sticks right under it. */
const BAND_H = 28;

function Th({
  children,
  sticky,
  corner,
  edge,
  right,
  style,
  tint,
}: {
  children: React.ReactNode;
  sticky?: boolean;
  corner?: boolean;
  edge?: boolean;
  right?: boolean;
  style?: React.CSSProperties;
  /** The columns you work in (duty, your price) are set apart. */
  tint?: boolean;
}) {
  return (
    <th
      style={{ top: BAND_H, ...style }}
      className={`sticky border-b border-[#d9cba8] bg-[#f4ecd6] px-2 py-2 ${right ? "text-right" : ""} ${sticky ? "left-0" : ""} ${corner ? "z-30" : "z-20"} ${edge ? "border-r" : ""} ${tint ? "text-[#7a3606]" : ""} whitespace-nowrap`}
    >
      {children}
    </th>
  );
}

/** A heading that spans a group of columns (Invoice, Cost, Price …). */
function Band({ children, span, sticky, tint }: { children?: React.ReactNode; span: number; sticky?: boolean; tint?: boolean }) {
  return (
    <th
      colSpan={span}
      style={{ top: 0, height: BAND_H, ...(sticky ? { left: 0 } : {}) }}
      className={`sticky ${sticky ? "z-30" : "z-20"} whitespace-nowrap border-b border-[#d9cba8] ${sticky ? "" : "border-l"} bg-[#efe5cb] px-2 ${tint ? "text-[#7a3606]" : ""}`}
    >
      {children}
    </th>
  );
}

/**
 * One edit recalculates the whole shipment, but almost every row comes out the same. Re-rendering all of
 * them (27 cells and an image each) made a 300-row shipment lag, so a row only re-renders when its own
 * data changed. onPick is a fresh closure on every render and is deliberately not compared.
 */
const Row = memo(
  RowView,
  (a, b) =>
    a.onSave === b.onSave &&
    a.c.line === b.c.line &&
    a.c.blocked.join("|") === b.c.blocked.join("|") &&
    a.c.warnings.join("|") === b.c.warnings.join("|") &&
    JSON.stringify(a.c.result) === JSON.stringify(b.c.result),
);

function Td({ children, className = "", style, title }: { children?: React.ReactNode; className?: string; style?: React.CSSProperties; title?: string }) {
  return (
    <td style={style} title={title} className={`border-b border-line px-2 py-1 align-middle ${className}`}>
      {children}
    </td>
  );
}

function RowView({
  c,
  onSave,
  onPick,
}: {
  c: CalculatedLine;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onPick: () => void;
}) {
  const { t, m } = useTr();
  const { line: l, result: r } = c;
  // Duty is kr per kg for most goods, a share of the value for a few (Cedevita powder): the row shows one basis at a time.
  const [pctMode, setPctMode] = useState(false);
  const change = l.history?.change;
  const up = change?.direction === "up";
  const down = change?.direction === "down";
  const bg = up ? "bg-red-50" : down ? "bg-green-50" : "bg-white";
  const marginLow = r.flags.marginBelowThreshold || r.flags.priceBelowCost;
  const kg = l.unit === "kilo";

  // Edited after it was sent? Then it needs sending again.
  const changedSincePush = hasChangedSincePush(l, r);
  const notes = [...c.blocked, ...c.warnings, ...l.issues].map(m);

  const conflict = l.price_conflict;
  const unitPrice = l.chosen_unit_price ?? l.unit_price;

  return (
    <tr className={bg}>
      <Td className={`sticky z-10 font-mono ${bg} border-r-0`} style={{ left: LEFT.art, width: W.art, minWidth: W.art }}>
        <div className="font-semibold">{l.idx}</div>
        {l.hs_fixed && <Badge tone="yellow" title={t("Tollnummeret mistet en ledende 0, og den er lagt til", "The customs number lost a leading 0, and it was added back")}>{t("0 lagt til", "0 added")}</Badge>}
      </Td>
      <Td className={`sticky z-10 ${bg}`} style={{ left: LEFT.img, width: W.img, minWidth: W.img }}>
        <Thumb url={l.shopify?.imageUrl ?? null} size={56} />
      </Td>
      <Td className={`sticky z-10 border-r ${bg}`} style={{ left: LEFT.name, width: W.name, minWidth: W.name }}>
        {l.match_status === "matched" ? (
          <div className="leading-tight">
            <div className="line-clamp-2 font-semibold" title={l.shopify?.title}>
              {l.shopify?.title ?? l.name}
            </div>
            <div className="line-clamp-1 text-[11px] text-mute" title={l.name}>
              {l.name}
            </div>
          </div>
        ) : (
          <div className="leading-tight">
            <div className="line-clamp-1 text-[11px] text-mute" title={l.name}>
              {l.name}
            </div>
            <button onClick={onPick} className="mt-0.5 rounded bg-orange px-2 py-0.5 text-[11px] font-bold text-cream hover:opacity-90">
              {l.match_status === "doubtful" ? t("Sjekk kobling", "Check match") : t("Velg produkt", "Select product")}
            </button>
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap gap-1">
          {l.is_new ? <Badge tone="orange">{t("Ny", "New")}</Badge> : <Badge tone="gray">{t("Påfyll", "Restock")}</Badge>}
          {l.match_status === "matched" && l.match_via === "link" && <Badge tone="gray" title={t("Koblet av deg tidligere", "Matched by you earlier")}>{t("lagret", "saved")}</Badge>}
          {l.match_status === "doubtful" && l.shopify_product_id && (
            <button onClick={onPick} className="rounded-full bg-yellow-100 px-2 text-[11px] font-bold text-yellow-900" title={l.match_reason ? m(l.match_reason) : l.match_reason}>
              {t("Usikker", "Uncertain")}
            </button>
          )}
          {l.pushed_at && !changedSincePush && <Badge tone="green" title={t(`Sendt ${l.pushed_at}`, `Sent ${l.pushed_at}`)}>{t("Sendt ✓", "Sent ✓")}</Badge>}
          {changedSincePush && <Badge tone="yellow" title={t("Endret etter sending – send på nytt", "Changed after sending – send again")}>{t("Endret", "Changed")}</Badge>}
          {l.push_errors && !l.pushed_at && <Badge tone="red" title={l.push_errors.map((e) => m(e.message)).join("; ")}>{t("Feil", "Error")}</Badge>}
        </div>
      </Td>

      <Td className="text-center">
        <input type="checkbox" checked={l.done} onChange={(e) => onSave(l.id, { done: e.target.checked })} className="h-4 w-4 accent-orange" aria-label={t("Ferdig", "Done")} />
      </Td>
      <Td className="font-mono">{l.hs ?? "–"}</Td>
      <Td>{l.country}</Td>
      <Td>{kg ? "kg" : t("stk", "pcs")}</Td>
      <Td className="text-right tabular-nums">{fmt(Number(l.qty), Number(l.qty) % 1 ? 3 : 0)}</Td>
      <Td className="w-20">
        <NumCell
          value={l.pcs_per_carton}
          digits={0}
          className={`${l.pcs_per_carton ? "" : "!border-yellow-400 !bg-yellow-100"} ${l.pcs_source === "typed" ? "font-bold" : ""}`}
          title={l.pcs_source === "shopify" ? t("Fra Shopify", "From Shopify") : l.pcs_source === "invoice" ? t("Fra fakturaen", "From the invoice") : l.pcs_source === "title" ? t("Fra tittelen", "From the title") : l.pcs_source === "typed" ? t("Lagt inn av deg", "Entered by you") : t("Ukjent", "Unknown")}
          onCommit={(n) => onSave(l.id, { pcs_per_carton: n })}
        />
      </Td>
      <Td className="text-right tabular-nums">
        {conflict && l.chosen_unit_price === null ? (
          <select
            defaultValue=""
            onChange={(e) => e.target.value && onSave(l.id, { chosen_unit_price: Number(e.target.value) })}
            className="rounded border border-red-400 bg-red-100 px-1 py-0.5 text-[11px] font-bold"
            title={t("Samme varenummer til ulik pris – velg", "Same item number at different prices – choose")}
          >
            <option value="">{t("Velg pris …", "Choose price …")}</option>
            {conflict.map((p) => (
              <option key={p.unitPrice} value={p.unitPrice}>
                {fmt(p.unitPrice)} ({p.qty} {t("stk", "pcs")})
              </option>
            ))}
          </select>
        ) : (
          <>
            {fmt(unitPrice, 2)} <span className="text-mute">{l.currency}</span>
          </>
        )}
      </Td>
      <Td className="text-right tabular-nums">{fmt(r.goodsNok)}</Td>
      <Td className={`w-24 ${r.flags.missingDuty ? "bg-yellow-100" : ""}`}>
        {!r.isDrink && (l.duty_pct != null || pctMode) ? (
          <div className="flex items-center gap-1">
            <NumCell
              value={l.duty_pct == null ? null : Math.round(Number(l.duty_pct) * 10000) / 100}
              digits={1}
              placeholder="%"
              className={r.flags.missingDuty ? "!border-yellow-500 placeholder:text-yellow-800" : ""}
              title={l.duty_source ? m(l.duty_source) : t("Toll i prosent av varens verdi", "Duty as a percentage of the goods value")}
              onCommit={(n) => onSave(l.id, { duty_pct: n === null ? null : n / 100 })}
            />
            <span className="text-xs text-mute">%</span>
          </div>
        ) : (
          <NumCell
            value={l.duty_per_kg}
            digits={2}
            disabled={r.isDrink}
            placeholder={r.isDrink ? t("drikke", "drink") : t("fyll inn", "fill in")}
            className={r.flags.missingDuty ? "!border-yellow-500 placeholder:text-yellow-800" : ""}
            title={r.isDrink ? t("Drikke: 0 i toll + emballasje", "Drink: 0 duty + packaging") : l.duty_source ? m(l.duty_source) : t("Mangler – fyll inn", "Missing – fill in")}
            onCommit={(n) => onSave(l.id, { duty_per_kg: n })}
          />
        )}
        {!r.isDrink && (
          <button
            type="button"
            onClick={() => {
              if (l.duty_pct != null || pctMode) {
                setPctMode(false);
                if (l.duty_pct != null) onSave(l.id, { duty_pct: null });
              } else setPctMode(true);
            }}
            className="block w-full text-right text-[10px] text-mute underline decoration-dotted hover:text-orange"
            title={t("Bytt mellom kr per kg og prosent av verdi (for varer der tollen regnes av verdien)", "Switch between kr per kg and a percentage of value (for goods where the duty is charged on the value)")}
          >
            {l.duty_pct != null || pctMode ? t("bruk kr/kg", "use kr/kg") : t("% av verdi", "% of value")}
          </button>
        )}
        {l.duty_source_kind && !r.isDrink && (
          <div className="truncate text-right text-[10px] text-mute" title={m(l.duty_source ?? "")}>
            {l.duty_source_kind === "declaration" ? t("deklarasjon", "declaration") : l.duty_source_kind === "product" ? t("tidligere", "previous") : l.duty_source_kind === "cn8" ? t("register", "register") : l.duty_source_kind === "hs6" ? "HS6" : t("anslag", "estimate")}
          </div>
        )}
      </Td>
      <Td className="text-right tabular-nums">{fmt(r.dutyNok)}</Td>
      <Td className="w-16 text-right tabular-nums">
        {r.isDrink || l.packaging_nok != null ? (
          <NumCell
            value={l.packaging_nok}
            digits={2}
            placeholder={fmt(r.packagingNok)}
            title={t("Emballasjeavgift per stk. Tom = standard for drikke. Skriv inn avgiften fra deklarasjonen (for eksempel 2,05, eller 0).", "Packaging fee per unit. Empty = the standard drink fee. Type the fee from the declaration (for example 2.05, or 0).")}
            onCommit={(n) => onSave(l.id, { packaging_nok: n })}
          />
        ) : r.packagingNok ? (
          fmt(r.packagingNok)
        ) : (
          "–"
        )}
      </Td>
      <Td className="text-right tabular-nums">{fmt(r.freightNok)}</Td>
      <Td className="text-right tabular-nums">{fmt(r.landedCost)}</Td>
      <Td>
        <select
          value={l.vat_rate === null || l.vat_rate === undefined ? "" : String(Number(l.vat_rate))}
          onChange={(e) => onSave(l.id, { vat_rate: e.target.value === "" ? null : Number(e.target.value) })}
          className={`w-full rounded border bg-white px-1 py-1 text-right text-xs ${l.vat_rate !== null && l.vat_rate !== undefined ? "border-[#b8500a] font-bold" : "border-[#cdbf9d]"}`}
          title={t("15 % for mat, 25 % for leker, kosmetikk, børster og annet som ikke er mat. «Auto» følger mva-25-taggen og tollnummeret.", "15% for food, 25% for toys, cosmetics, brushes and other non-food. \"Auto\" follows the mva-25 tag and the customs code.")}
          aria-label={t("MVA", "VAT")}
        >
          <option value="">{t("auto", "auto")} {Math.round((l.mva25 || isNonFoodVatHs(l.hs) ? 0.25 : 0.15) * 100)} %</option>
          <option value="0.15">15 %</option>
          <option value="0.25">25 %</option>
        </select>
      </Td>
      <Td className="text-right font-semibold tabular-nums">{fmt(r.costInclVat)}</Td>
      <Td className="text-right tabular-nums">{fmt(r.suggestedPrice, 1)}</Td>
      <Td className="w-24">
        <NumCell
          value={r.ourPrice}
          digits={1}
          className={`!border-2 !border-[#b8500a] text-sm font-bold ${l.price_override !== null ? "text-[#b8500a]" : ""}`}
          title={l.price_override !== null ? t("Din egen pris", "Your own price") : r.ourPrice !== null && l.shopify?.status === "ACTIVE" ? t("Dagens pris i Shopify", "Current price in Shopify") : t("Foreslått pris", "Suggested price")}
          onCommit={(n) => onSave(l.id, { price_override: n })}
        />
      </Td>
      <Td className="text-right tabular-nums">{fmt(r.casePrice)}</Td>
      <Td className="text-right">
        {r.margin === null ? (
          <span className="text-mute">–</span>
        ) : (
          <span
            className={`inline-block rounded px-1.5 py-0.5 font-bold tabular-nums ${marginLow ? "bg-[#fbe3df] text-[#8f1f15]" : "bg-[#e6f3e6] text-[#1f5c33]"}`}
            title={marginLow ? t("Under marginvarselet", "Below the margin warning") : undefined}
          >
            {marginLow ? "▼ " : ""}
            {fmtPct(r.margin)}
          </span>
        )}
      </Td>
      <Td className="text-right tabular-nums">{change?.previousUnitPrice != null ? fmt(change.previousUnitPrice) : "–"}</Td>
      <Td className={`text-right font-semibold tabular-nums ${up ? "text-red-700" : down ? "text-green-700" : ""}`}>
        {change?.changePct != null ? `${change.changePct > 0.0005 ? "▲ " : change.changePct < -0.0005 ? "▼ " : ""}${Math.abs(change.changePct * 100).toFixed(1).replace(".", ",")} %` : change?.direction === "other-currency" ? t("annen valuta", "other currency") : "–"}
        {change?.raisedWhileOurPriceUnchanged && (
          <div className="text-[10px] font-bold text-red-700" title={t(`Ny foreslått pris: ${fmt(r.suggestedPrice, 1)}`, `New suggested price: ${fmt(r.suggestedPrice, 1)}`)}>
            {t(`Leverandør hevet – sjekk vår pris (${fmt(r.suggestedPrice, 1)})`, `Supplier raised the price – check our price (${fmt(r.suggestedPrice, 1)})`)}
          </div>
        )}
      </Td>
      <Td>
        {l.shopify ? <Badge tone={l.shopify.status === "ACTIVE" ? "green" : "yellow"}>{l.shopify.status === "ACTIVE" ? t("Aktiv", "Active") : t("Utkast", "Draft")}</Badge> : <span className="text-mute">–</span>}
      </Td>
      <Td className="text-right tabular-nums">{l.shopify?.status === "ACTIVE" ? l.shopify.productType : "–"}</Td>
      <Td className="w-20">
        {kg ? (
          <NumCell
            value={l.sales_unit_kg}
            digits={2}
            placeholder={t("kg/enhet", "kg/unit")}
            className={l.sales_unit_kg ? "" : "!border-yellow-400 !bg-yellow-100"}
            title={t("Størrelsen på salgsenheten (f.eks. 1,5 kg). Huskes for produktet.", "The size of the sales unit (e.g. 1.5 kg). Remembered for the product.")}
            onCommit={(n) => onSave(l.id, { sales_unit_kg: n })}
          />
        ) : (
          <span className="block text-right text-mute">–</span>
        )}
      </Td>
      <Td className="max-w-[260px]">
        <div className="line-clamp-2 text-[11px]" title={notes.join("\n")}>
          {c.blocked.map((n, i) => (
            <span key={`b${i}`} className="mr-1 font-semibold text-red-700">
              {m(n)}.
            </span>
          ))}
          {c.warnings.map((n, i) => (
            <span key={`w${i}`} className="mr-1 text-amber">
              {m(n)}.
            </span>
          ))}
          {l.issues.map((n, i) => (
            <span key={`i${i}`} className="mr-1 text-mute">
              {m(n)}.
            </span>
          ))}
        </div>
      </Td>
    </tr>
  );
}
