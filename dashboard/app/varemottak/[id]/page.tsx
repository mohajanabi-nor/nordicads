"use client";

/**
 * Review screen — the Excel sheet it replaces, one row per product, with the product
 * picture in every row so 270 rows can be priced quickly.
 *
 * The numbers are computed here with the same pure engine the server runs before a push
 * (lib/varemottak/calc.ts + lines.ts), so editing a duty rate or a price updates the row
 * at once, and what is on screen is what would be sent.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { summarize } from "@/lib/varemottak/calc";
import type { CustomsRate } from "@/lib/varemottak/customs";
import { shipmentQuestions } from "@/lib/varemottak/questions";
import { calculate, needsPush, shipmentWarnings, type CalculatedLine, type InvoiceRow, type LineRow, type ShipmentRow } from "@/lib/varemottak/lines";
import { Badge } from "@/components/varemottak/cells";
import ReviewTable from "@/components/varemottak/ReviewTable";
import MatchPicker from "@/components/varemottak/MatchPicker";
import PushDialog from "@/components/varemottak/PushDialog";
import PushLogDialog from "@/components/varemottak/PushLogDialog";
import QuestionList from "@/components/varemottak/QuestionList";
import ShipmentHeader, { ImportSummaryCard, type ImportOutcome } from "@/components/varemottak/ShipmentHeader";
import { useTr } from "@/components/varemottak/useTr";

interface View {
  shipment: ShipmentRow;
  invoices: InvoiceRow[];
  lines: LineRow[];
  pushLog: number;
  shopifyMode: "live" | "fake";
  liveWritesEnabled: boolean;
}

type FilterKey = "all" | "duty" | "margin" | "up" | "notdone" | "unmatched" | "blocked" | "conflict" | "pushed";

const FILTERS: Array<{ key: FilterKey; no: string; en: string }> = [
  { key: "all", no: "Alle", en: "All" },
  { key: "duty", no: "Mangler toll", en: "Missing duty" },
  { key: "margin", no: "Lav margin", en: "Low margin" },
  { key: "up", no: "Pris opp", en: "Price up" },
  { key: "unmatched", no: "Kobling", en: "Matching" },
  { key: "conflict", no: "Prisavvik", en: "Price mismatch" },
  { key: "blocked", no: "Blokkert", en: "Blocked" },
  { key: "notdone", no: "Ikke ferdige", en: "Not done" },
  { key: "pushed", no: "Sendt", en: "Sent" },
];

// Fallback errors written here (not from the server): translated when shown, so the callbacks stay language-independent.
const FALLBACK_ERRORS_EN: Record<string, string> = {
  "Kunne ikke hente forsendelsen": "Could not load the shipment",
  "Kunne ikke lagre": "Could not save",
  "Kunne ikke slette": "Could not delete",
};

function matches(f: FilterKey, c: CalculatedLine): boolean {
  const l = c.line;
  switch (f) {
    case "all":
      return true;
    case "duty":
      return c.result.flags.missingDuty;
    case "margin":
      return c.result.flags.marginBelowThreshold || c.result.flags.priceBelowCost;
    case "up":
      return l.history?.change.direction === "up";
    case "notdone":
      return !l.done;
    case "unmatched":
      return l.match_status !== "matched";
    case "blocked":
      return c.blocked.length > 0;
    case "conflict":
      return !!l.price_conflict && l.chosen_unit_price === null;
    case "pushed":
      return !!l.pushed_at;
  }
}

export default function ShipmentPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { t, m, lang } = useTr();
  const showError = (e: string) => (lang === "en" && FALLBACK_ERRORS_EN[e]) || m(e);
  const [view, setView] = useState<View | null>(null);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [shipment, setShipment] = useState<ShipmentRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [imported, setImported] = useState<ImportOutcome | null>(null);
  const [picking, setPicking] = useState<LineRow | null>(null);
  const [pushOpen, setPushOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [rematching, setRematching] = useState(false);
  const [rates, setRates] = useState<CustomsRate[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/varemottak/shipments/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Kunne ikke hente forsendelsen");
      setView(data);
      setLines(data.lines);
      setShipment(data.shipment);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // The customs register, so a missing duty can offer the rates a code has been declared at.
  useEffect(() => {
    fetch("/api/varemottak/customs")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => Array.isArray(data) && setRates(data))
      .catch(() => {});
  }, []);

  // ---- saving ----------------------------------------------------------------

  const saveLine = useCallback(async (lineId: string, patch: Record<string, unknown>) => {
    // Optimistic: the row recalculates at once; the server's answer replaces it.
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        const next = { ...l, ...patch } as LineRow;
        if ("duty_per_kg" in patch) {
          next.duty_source_kind = patch.duty_per_kg === null ? null : "estimate";
          next.duty_source = patch.duty_per_kg === null ? null : "Lagt inn (anslag)";
        }
        // one duty basis at a time, as on the server
        if ("duty_per_kg" in patch && patch.duty_per_kg !== null) next.duty_pct = null;
        if ("duty_pct" in patch) {
          if (patch.duty_pct !== null) next.duty_per_kg = null;
          next.duty_source_kind = patch.duty_pct === null ? null : "estimate";
          next.duty_source = patch.duty_pct === null ? null : "Lagt inn (prosent av verdi)";
        }
        if ("pcs_per_carton" in patch) next.pcs_source = patch.pcs_per_carton === null ? null : "typed";
        return next;
      }),
    );
    setPending((n) => n + 1);
    try {
      const res = await fetch(`/api/varemottak/lines/${lineId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Kunne ikke lagre");
      setLines((prev) => prev.map((l) => (l.id === lineId ? data : l)));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      load(); // the screen must not keep a value the server refused
    } finally {
      setPending((n) => n - 1);
    }
  }, [load]);

  const patchShipment = useCallback(async (patch: Record<string, unknown>) => {
    setShipment((s) => {
      if (!s) return s;
      const next = { ...s, ...patch } as ShipmentRow;
      if (patch.rates) {
        next.rates = Object.fromEntries(Object.entries(patch.rates as Record<string, number | null>).filter(([, v]) => v !== null)) as Record<string, number>;
      }
      return next;
    });
    setPending((n) => n + 1);
    try {
      const res = await fetch(`/api/varemottak/shipments/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Kunne ikke lagre");
      setShipment(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      load();
    } finally {
      setPending((n) => n - 1);
    }
  }, [id, load]);

  // ---- derived ---------------------------------------------------------------

  const calc = useMemo(() => (shipment ? calculate(shipment, lines) : null), [shipment, lines]);

  const otherCostsNok = useMemo(() => {
    if (!shipment || !view) return 0;
    return view.invoices.reduce(
      (a, inv) => a + inv.extra_lines.reduce((s, e) => s + e.value * (inv.currency === "NOK" ? 1 : Number(shipment.rates[inv.currency]) || 0), 0),
      0,
    );
  }, [shipment, view]);

  const summary = useMemo(() => (calc ? summarize(calc.rows, otherCostsNok) : null), [calc, otherCostsNok]);

  const questions = useMemo(() => (shipment && calc ? shipmentQuestions(calc.rows, shipment, calc.totals.freightMissingRate, rates) : []), [shipment, calc, rates]);

  const shown = useMemo(() => {
    if (!calc) return [];
    const q = query.trim().toLowerCase();
    return calc.rows.filter((c) => {
      if (!matches(filter, c)) return false;
      if (!q) return true;
      return `${c.line.idx} ${c.line.name} ${c.line.shopify?.title ?? ""}`.toLowerCase().includes(q);
    });
  }, [calc, filter, query]);

  const counts = useMemo(() => {
    const out = {} as Record<FilterKey, number>;
    for (const f of FILTERS) out[f.key] = calc ? calc.rows.filter((c) => matches(f.key, c)).length : 0;
    return out;
  }, [calc]);

  async function bulkDone(done: boolean) {
    const ids = shown.filter((c) => (done ? c.blocked.length === 0 : true) && c.line.done !== done).map((c) => c.line.id);
    if (!ids.length) return;
    setLines((prev) => prev.map((l) => (ids.includes(l.id) ? { ...l, done } : l)));
    setPending((n) => n + 1);
    try {
      const res = await fetch(`/api/varemottak/shipments/${id}/done`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lineIds: ids, done }) });
      if (!res.ok) throw new Error((await res.json()).error);
    } catch (err) {
      setError((err as Error).message);
      load();
    } finally {
      setPending((n) => n - 1);
    }
  }

  async function removeShipment() {
    const sent = lines.some((l) => l.pushed_at);
    const ok = confirm(
      sent
        ? t("Forsendelsen har varer som er sendt til Shopify og kan ikke slettes. Arkivere den?", "The shipment has items that were sent to Shopify and cannot be deleted. Archive it instead?")
        : t("Slette forsendelsen og alle radene i den? Dette kan ikke angres.", "Delete the shipment and all its rows? This cannot be undone."),
    );
    if (!ok) return;
    try {
      if (sent) await patchShipment({ status: "archived" });
      else {
        const res = await fetch(`/api/varemottak/shipments/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error((await res.json()).error ?? "Kunne ikke slette");
      }
      window.location.href = "/varemottak";
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function rematch() {
    setRematching(true);
    try {
      const res = await fetch(`/api/varemottak/shipments/${id}/rematch`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRematching(false);
    }
  }

  if (!view || !shipment || !calc || !summary) {
    return <p className="text-sm text-mute">{error ? showError(error) : t("Henter …", "Loading …")}</p>;
  }

  // Done and either never sent or edited since being sent.
  const doneCount = calc.rows.filter((c) => needsPush(c.line, c.result)).length;
  const pushedCount = lines.filter((l) => l.pushed_at).length;
  const markedDone = lines.filter((l) => l.done).length;
  const donePct = lines.length ? Math.round((markedDone / lines.length) * 100) : 0;

  return (
    // One width for everything on the page (settings, numbers, notes, filters, table): a little narrower than the
    // window. 100vw counts the page's own scrollbar, so stay clear of it, or the whole page scrolls sideways.
    <div className="relative left-1/2 w-[calc(100vw-48px)] -translate-x-1/2 space-y-4 lg:w-[calc(100vw-160px)]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/varemottak" className="text-xs font-semibold text-orange hover:underline">
            {t("← Alle forsendelser", "← All shipments")}
          </Link>
          <h1 className="text-2xl font-extrabold tracking-tight">{shipment.name}</h1>
          <p className="text-sm text-mute">
            {shipment.supplier_name} · {t(`${lines.length} varer`, `${lines.length} items`)} · {t(`${pushedCount} sendt`, `${pushedCount} sent`)}
            {pending > 0 ? <span className="ml-2 text-amber">{t("Lagrer …", "Saving …")}</span> : <span className="ml-2 text-green-700">{t("Lagret", "Saved")}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-2 flex items-center gap-2 text-sm font-semibold" title={t("Rader du har merket som ferdige", "Rows you have marked as done")}>
            <span>{t(`${markedDone} av ${lines.length} ferdige`, `${markedDone} of ${lines.length} done`)}</span>
            <div className="h-2 w-32 rounded bg-line">
              <div className="h-2 rounded bg-[#b8500a]" style={{ width: `${donePct}%` }} />
            </div>
          </div>
          <Badge tone={view.shopifyMode === "live" ? "red" : "green"}>{view.shopifyMode === "live" ? t("Ekte butikk", "Live store") : t("Testbutikk", "Test store")}</Badge>
          <a href={`/api/varemottak/shipments/${id}/export`} className="rounded-lg border border-line bg-cream-2 px-3 py-2 text-sm font-semibold hover:bg-orange/10">
            {t("Eksporter Excel", "Export Excel")}
          </a>
          <button onClick={() => setLogOpen(true)} className="rounded-lg border border-line bg-cream-2 px-3 py-2 text-sm font-semibold hover:bg-orange/10">
            {t("Sendelogg", "Send log")}
          </button>
          <button onClick={removeShipment} className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-mute hover:text-red-700">
            {lines.some((l) => l.pushed_at) ? t("Arkiver", "Archive") : t("Slett", "Delete")}
          </button>
          <button onClick={rematch} disabled={rematching} className="rounded-lg border border-line bg-cream-2 px-3 py-2 text-sm font-semibold hover:bg-orange/10 disabled:opacity-50" title={t("Les Shopify på nytt – nye tagger og oppdaterte produkter", "Re-read Shopify – new tags and updated products")}>
            {rematching ? t("Kobler …", "Matching …") : t("Koble på nytt", "Re-match")}
          </button>
          <button onClick={() => setPushOpen(true)} disabled={doneCount === 0} className="rounded-lg bg-[#b8500a] px-4 py-2 text-sm font-bold text-[#fffaf0] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
            {t(`Send ${doneCount} ferdige til Shopify`, `Send ${doneCount} done to Shopify`)}
          </button>
        </div>
      </div>

      {error && <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{showError(error)}</p>}

      <ShipmentHeader
        shipment={shipment}
        invoices={view.invoices}
        summary={summary}
        otherCostsNok={otherCostsNok}
        freightMissingRate={calc.totals.freightMissingRate}
        warnings={shipmentWarnings(shipment, lines)}
        onPatch={patchShipment}
        onImported={(r) => {
          setImported(r);
          load();
        }}
      />
      {imported && <ImportSummaryCard result={imported} onClose={() => setImported(null)} />}

      <QuestionList
        questions={questions}
        handlers={{
          onLineNumber: (lineId, field, value) => saveLine(lineId, { [field]: value }),
          onPick: (lineId) => setPicking(lines.find((l) => l.id === lineId) ?? null),
          onShipmentRate: (currency, value) => patchShipment({ rates: { ...shipment.rates, [currency]: value } }),
          onShipmentNumber: (field, value) => patchShipment({ [field]: value }),
          onShipmentDate: (field, value) => patchShipment({ [field]: value }),
        }}
      />

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1.5 text-xs font-bold ${filter === f.key ? "border-2 border-[#b8500a] bg-[#fff3e2] text-[#7a3606]" : "border-[#d9cba8] bg-cream-2 hover:bg-orange/10"}`}
            >
              {t(f.no, f.en)} <span className="opacity-70">{counts[f.key]}</span>
            </button>
          ))}
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Søk art.nr eller navn …", "Search item no. or name …")} className="ml-auto w-56 rounded-lg border border-line bg-white px-3 py-1.5 text-sm" />
          <button onClick={() => bulkDone(true)} className="rounded-lg border border-line bg-cream-2 px-3 py-1.5 text-xs font-bold hover:bg-orange/10" title={t("Merker bare rader som kan sendes", "Only marks rows that can be sent")}>
            {t("Merk viste ferdige", "Mark shown as done")}
          </button>
          <button onClick={() => bulkDone(false)} className="rounded-lg border border-line bg-cream-2 px-3 py-1.5 text-xs font-bold hover:bg-orange/10">
            {t("Fjern ferdig", "Clear done")}
          </button>
        </div>

        <ReviewTable rows={shown} emptyText={lines.length ? t("Ingen rader i dette filteret.", "No rows in this filter.") : t("Importer en faktura for å komme i gang.", "Import an invoice to get started.")} onSave={saveLine} onPick={(l) => setPicking(l)} />
      </div>

      {picking && (
        <MatchPicker
          line={picking}
          onClose={() => setPicking(null)}
          onPicked={(updated) => {
            setLines((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
            setPicking(null);
          }}
        />
      )}
      {logOpen && <PushLogDialog shipmentId={id} lines={lines} onClose={() => setLogOpen(false)} />}
      {pushOpen && (
        <PushDialog
          shipmentId={id}
          doneCount={doneCount}
          shopifyMode={view.shopifyMode}
          liveWritesEnabled={view.liveWritesEnabled}
          onClose={() => setPushOpen(false)}
          onPushed={load}
        />
      )}
    </div>
  );
}

