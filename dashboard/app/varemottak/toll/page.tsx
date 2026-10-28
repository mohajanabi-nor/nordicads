"use client";

/**
 * Customs register: duty in NOK per kg, so the same rate is never typed twice.
 * A declaration always overrides an estimate, and registering one recalculates the
 * products it touches and shows what moved.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import BulkImportCard from "@/components/varemottak/BulkImportCard";
import DeclarationPdfCard from "@/components/varemottak/DeclarationPdfCard";
import { Badge, fmt, fmtPct } from "@/components/varemottak/cells";
import { useTr } from "@/components/varemottak/useTr";

interface Rate {
  id: string;
  scope: "cn8" | "product" | "hs6";
  cn8: string | null;
  supplier: string | null;
  idx: string | null;
  duty_per_kg: number;
  source_kind: "declaration" | "estimate";
  source_ref: string;
  source_date: string;
}

interface Change {
  shipmentName: string;
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

interface Item {
  cn8: string;
  dutyNok: string;
  netWeightKg: string;
}

export default function TollPage() {
  const { t, m } = useTr();
  const [rates, setRates] = useState<Rate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [number, setNumber] = useState("");
  const [date, setDate] = useState("");
  const [items, setItems] = useState<Item[]>([{ cn8: "", dutyNok: "", netWeightKg: "" }]);
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState<Change[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/varemottak/customs");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRates(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/varemottak/customs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? t("Feilet", "Failed"));
    return data;
  }

  async function submitDeclaration(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await post({
        action: "declaration",
        number,
        date,
        items: items.filter((i) => i.cn8.trim()).map((i) => ({ cn8: i.cn8, dutyNok: Number(i.dutyNok.replace(",", ".")), netWeightKg: Number(i.netWeightKg.replace(",", ".")) })),
      });
      setChanges(out.changes);
      setNumber("");
      setItems([{ cn8: "", dutyNok: "", netWeightKg: "" }]);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shown = rates.filter((r) => !filter || `${r.cn8 ?? ""} ${r.supplier ?? ""} ${r.idx ?? ""} ${r.source_ref}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/varemottak" className="text-xs font-semibold text-orange hover:underline">
          {t("← Varemottak", "← Goods receipt")}
        </Link>
        <h1 className="text-2xl font-extrabold tracking-tight">{t("Tollregister", "Customs register")}</h1>
        <p className="mt-1 max-w-3xl text-sm text-mute">
          {t(
            "Toll i kr per kg. Oppslag i denne rekkefølgen: deklarasjon på samme CN8 → samme vare tidligere → verifisert sats på samme HS6 (bare hvis alle er like). Ellers står cellen tom og du fyller den inn. En deklarasjon vinner alltid over et anslag.",
            "Duty in NOK per kg. Looked up in this order: declaration on the same CN8 → same product earlier → verified rate on the same HS6 (only if all are equal). Otherwise the cell is left empty and you fill it in. A declaration always wins over an estimate.",
          )}
        </p>
      </div>

      {error && <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{m(error)}</p>}

      <BulkImportCard
        title={t("Importer satser fra fil", "Import rates from file")}
        help={t(
          "Én rad per sats. Kolonner: tollnummer (CN8, 8 siffer) eller varenummer + leverandør, og toll kr/kg; valgfritt kilde (deklarasjonsnummer) og dato. CN8-satser regnes som verifiserte. Satser for en vare regnes som anslag, med mindre raden har en kilde. Tomme tollsatser i åpne forsendelser fylles ut.",
          "One row per rate. Columns: customs number (CN8, 8 digits) or article number + supplier, and duty NOK/kg; optional source (declaration number) and date. CN8 rates count as verified. Rates for a product count as estimates unless the row has a source. Empty duty rates in open shipments are filled in.",
        )}
        endpoint="/api/varemottak/customs/import"
        onDone={load}
      />

      <BulkImportCard
        title={t("Importer kg-varer fra fil", "Import products sold by kg from file")}
        help={t(
          "Én rad per vare: varenummer (flere kan stå med / mellom), navn og boksstørrelse. Står det «per BOX» regnes boksen som salgsenhet, ellers selges varen per kg. Lagres per produkt, og åpne kg-rader får salgsenheten med en gang.",
          "One row per product: article number (several can be separated by /), name and box size. If the row says \"per BOX\" the box is the selling unit, otherwise the product is sold per kg. Saved per product, and open kg rows get the selling unit at once.",
        )}
        endpoint="/api/varemottak/kg/import"
        hideSupplier
        onDone={load}
      />

      <DeclarationPdfCard onDone={load} />

      <form onSubmit={submitDeclaration} className="space-y-3 rounded-2xl border border-line bg-cream-2 p-4">
        <h2 className="font-extrabold">{t("Registrer en tolldeklarasjon", "Register a customs declaration")}</h2>
        <p className="text-xs text-mute">
          {t(
            "Toll per vare er TL + RT (+ SU) i NOK. Forskningsavgiften (FA) skal ikke være med. Varer på samme CN8 slås sammen.",
            "Duty per product is TL + RT (+ SU) in NOK. The research levy (FA) must not be included. Products on the same CN8 are merged.",
          )}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-semibold">{t("Deklarasjonsnummer", "Declaration number")}</span>
            <input value={number} onChange={(e) => setNumber(e.target.value)} required className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2" />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">{t("Dato", "Date")}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2" />
          </label>
        </div>
        <div className="space-y-2">
          {items.map((it, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
              <input value={it.cn8} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, cn8: e.target.value } : x)))} placeholder={t("CN8 (8 siffer)", "CN8 (8 digits)")} className="rounded-lg border border-line bg-white px-3 py-2 text-sm" />
              <input value={it.dutyNok} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, dutyNok: e.target.value } : x)))} placeholder={t("Toll NOK", "Duty NOK")} className="rounded-lg border border-line bg-white px-3 py-2 text-sm" />
              <input value={it.netWeightKg} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, netWeightKg: e.target.value } : x)))} placeholder={t("Nettovekt kg", "Net weight kg")} className="rounded-lg border border-line bg-white px-3 py-2 text-sm" />
              <button type="button" onClick={() => setItems(items.length > 1 ? items.filter((_, j) => j !== i) : items)} className="rounded px-2 text-mute hover:bg-black/5" aria-label={t("Fjern linje", "Remove line")}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setItems([...items, { cn8: "", dutyNok: "", netWeightKg: "" }])} className="text-sm font-semibold text-orange hover:underline">
            {t("+ Legg til linje", "+ Add line")}
          </button>
        </div>
        <button disabled={busy} className="rounded-lg bg-orange px-4 py-2 text-sm font-bold text-cream hover:opacity-90 disabled:opacity-50">
          {busy ? t("Registrerer …", "Registering …") : t("Registrer og regn om", "Register and recalculate")}
        </button>
      </form>

      {changes && (
        <section className="rounded-2xl border-2 border-orange/40 bg-white p-4">
          <div className="flex items-start justify-between">
            <h2 className="font-extrabold">{t(`Omregnet: ${changes.length} varer`, `Recalculated: ${changes.length} items`)}</h2>
            <button onClick={() => setChanges(null)} className="text-mute hover:text-ink" aria-label={t("Lukk", "Close")}>
              ✕
            </button>
          </div>
          {changes.length === 0 ? (
            <p className="text-sm text-mute">{t("Ingen åpne varer berørt.", "No open items affected.")}</p>
          ) : (
            <div className="mt-2 max-h-80 overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-mute">
                  <tr>
                    <th className="py-1">{t("Vare", "Item")}</th>
                    <th className="text-right">{t("Toll kr/kg", "Duty NOK/kg")}</th>
                    <th className="text-right">{t("Kost inkl. mva", "Cost incl. VAT")}</th>
                    <th className="text-right">{t("Margin", "Margin")}</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {changes.map((c, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1">
                        <div className="font-semibold">{c.name}</div>
                        <div className="text-mute">
                          {c.shipmentName} · {c.idx} {c.pushed && <Badge tone="yellow">{t("sendt – send på nytt", "sent – resend")}</Badge>}
                        </div>
                      </td>
                      <td className="text-right">
                        {c.dutyBefore === null ? "–" : fmt(c.dutyBefore)} → <b>{fmt(c.dutyAfter)}</b>
                      </td>
                      <td className="text-right">
                        {fmt(c.costBefore)} → <b>{fmt(c.costAfter)}</b>
                      </td>
                      <td className={`text-right ${c.marginAfter !== null && c.marginBefore !== null && c.marginAfter < c.marginBefore ? "text-red-700" : "text-green-700"}`}>
                        {fmtPct(c.marginBefore)} → <b>{fmtPct(c.marginAfter)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="font-extrabold">{t(`Satser (${rates.length})`, `Rates (${rates.length})`)}</h2>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("Søk CN8, leverandør, varenummer …", "Search CN8, supplier, article number …")} className="w-72 rounded-lg border border-line bg-white px-3 py-1.5 text-sm" />
        </div>
        <div className="max-h-[55vh] overflow-auto rounded-2xl border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-cream-2 text-left text-xs uppercase tracking-wide text-mute">
              <tr>
                <th className="px-3 py-2">{t("Gjelder", "Applies to")}</th>
                <th className="px-3 py-2 text-right">{t("kr/kg", "NOK/kg")}</th>
                <th className="px-3 py-2">{t("Kilde", "Source")}</th>
                <th className="px-3 py-2">{t("Dato", "Date")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-3 py-1.5 font-mono text-xs">{r.scope === "cn8" ? `CN8 ${r.cn8}` : `${r.supplier} · ${r.idx}`}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(Number(r.duty_per_kg))}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone={r.source_kind === "declaration" ? "green" : "yellow"}>{r.source_kind === "declaration" ? t("Deklarasjon", "Declaration") : t("Anslag", "Estimate")}</Badge> <span className="text-xs text-mute">{r.source_ref}</span>
                  </td>
                  <td className="px-3 py-1.5 text-xs">{r.source_date}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      onClick={async () => {
                        if (!confirm(t("Slette satsen?", "Delete this rate?"))) return;
                        try {
                          await post({ action: "delete", id: r.id });
                          load();
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }}
                      className="text-xs text-mute hover:text-red-700"
                    >
                      {t("Slett", "Delete")}
                    </button>
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-mute">
                    {t("Ingen satser.", "No rates.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
