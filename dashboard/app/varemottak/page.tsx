"use client";

/**
 * Varemottak — pricing a supplier shipment. This is the list of shipments; the work
 * happens on each shipment's own page.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import BulkImportCard from "@/components/varemottak/BulkImportCard";
import { SUPPLIER_PROFILES } from "@/lib/varemottak/suppliers/registry";
import { useTr } from "@/components/varemottak/useTr";

interface ShipmentSummary {
  id: string;
  name: string;
  supplier_name: string;
  arrival_date: string | null;
  status: "draft" | "review" | "pushed" | "archived";
  created_at: string;
  lineCount: number;
  doneCount: number;
  pushedCount: number;
}

// "Other supplier" is the free-text entry; every other profile is a supplier the app knows how to read.
const KNOWN = SUPPLIER_PROFILES.filter((s) => s.id !== "other");
const STATUS: Record<ShipmentSummary["status"], { no: string; en: string }> = {
  draft: { no: "Utkast", en: "Draft" },
  review: { no: "Under arbeid", en: "In progress" },
  pushed: { no: "Sendt", en: "Sent" },
  archived: { no: "Arkivert", en: "Archived" },
};

export default function VaremottakPage() {
  const { t, m } = useTr();
  const tRef = useRef(t);
  tRef.current = t;
  const [shipments, setShipments] = useState<ShipmentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [name, setName] = useState("");
  const [supplier, setSupplier] = useState(KNOWN[0].label);
  const [otherSupplier, setOtherSupplier] = useState("");
  const [arrival, setArrival] = useState("");
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/varemottak/shipments");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? tRef.current("Kunne ikke hente forsendelser", "Could not load shipments"));
      setShipments(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/varemottak/shipments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, supplierName: supplier === "__other" ? otherSupplier : supplier, arrivalDate: arrival || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("Kunne ikke opprette forsendelsen", "Could not create the shipment"));
      window.location.href = `/varemottak/${data.id}`;
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{t("Varemottak", "Goods receipt")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-mute">
            {t(
              "Importer leverandørens faktura, beregn kost og pris, og send prisene til Shopify. Lager og tagger rører vi ikke.",
              "Import the supplier's invoice, calculate cost and price, and send the prices to Shopify. We don't touch stock or tags.",
            )}
          </p>
        </div>
        <div className="flex gap-2 text-sm font-semibold">
          <Link href="/varemottak/toll" className="rounded-lg border border-line bg-cream-2 px-3 py-2 hover:bg-orange/10">
            {t("Tollregister", "Customs register")}
          </Link>
          <Link href="/varemottak/gront-punkt" className="rounded-lg border border-line bg-cream-2 px-3 py-2 hover:bg-orange/10">
            Grønt Punkt
          </Link>
        </div>
      </div>

      <details className="rounded-2xl">
        <summary className="cursor-pointer text-sm font-semibold text-orange">{t("Importer innkjøpshistorikk fra fil", "Import purchase history from file")}</summary>
        <div className="mt-2">
          <BulkImportCard
            title={t("Innkjøpshistorikk", "Purchase history")}
            help={t(
              "Tidligere innkjøp, én rad per vare: varenummer, pris per enhet og dato (åååå-mm-dd eller dd.mm.åååå). Leverandør, valuta og fakturanummer kan stå i filen eller velges her. Neste forsendelse sammenlignes med disse prisene.",
              "Past purchases, one row per product: article number, price per unit and date (yyyy-mm-dd or dd.mm.yyyy). Supplier, currency and invoice number can be in the file or chosen here. The next shipment is compared with these prices.",
            )}
            endpoint="/api/varemottak/history/import"
            withCurrency
          />
        </div>
      </details>

      <form onSubmit={create} className="grid gap-3 rounded-2xl border border-line bg-cream-2 p-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <label className="block text-sm">
          <span className="font-semibold">{t("Ny forsendelse", "New shipment")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("f.eks. Stanro 000033", "e.g. Stanro 000033")}
            className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2"
            required
          />
        </label>
        <label className="block text-sm">
          <span className="font-semibold">{t("Leverandør", "Supplier")}</span>
          <select value={supplier} onChange={(e) => setSupplier(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2">
            {KNOWN.map((s) => (
              <option key={s.id} value={s.label}>
                {s.label}
              </option>
            ))}
            <option value="__other">{t("Annen leverandør", "Other supplier")} …</option>
          </select>
          {supplier === "__other" && (
            <input value={otherSupplier} onChange={(e) => setOtherSupplier(e.target.value)} placeholder={t("Navn", "Name")} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2" required />
          )}
        </label>
        <label className="block text-sm">
          <span className="font-semibold">{t("Ankomstdato", "Arrival date")}</span>
          <input type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2" />
        </label>
        <button disabled={creating} className="rounded-lg bg-orange px-4 py-2 text-sm font-bold text-cream hover:opacity-90 disabled:opacity-50">
          {creating ? t("Oppretter …", "Creating …") : t("Opprett", "Create")}
        </button>
      </form>

      {error && <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{m(error)}</p>}

      <label className="flex items-center gap-2 text-xs text-mute">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t("Vis arkiverte", "Show archived")}
      </label>
      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        <table className="w-full text-sm">
          <thead className="bg-cream-2 text-left text-xs uppercase tracking-wide text-mute">
            <tr>
              <th className="px-4 py-2">{t("Forsendelse", "Shipment")}</th>
              <th className="px-4 py-2">{t("Leverandør", "Supplier")}</th>
              <th className="px-4 py-2">{t("Ankomst", "Arrival")}</th>
              <th className="px-4 py-2 text-right">{t("Varer", "Items")}</th>
              <th className="px-4 py-2 text-right">{t("Ferdige", "Done")}</th>
              <th className="px-4 py-2 text-right">{t("Sendt", "Sent")}</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {shipments.filter((s) => showArchived || s.status !== "archived").map((s) => (
              <tr key={s.id} className="border-t border-line hover:bg-cream/50">
                <td className="px-4 py-2 font-semibold">
                  <Link href={`/varemottak/${s.id}`} className="text-orange hover:underline">
                    {s.name}
                  </Link>
                </td>
                <td className="px-4 py-2">{s.supplier_name}</td>
                <td className="px-4 py-2">{s.arrival_date ?? "–"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{s.lineCount}</td>
                <td className="px-4 py-2 text-right tabular-nums">{s.doneCount}</td>
                <td className="px-4 py-2 text-right tabular-nums">{s.pushedCount}</td>
                <td className="px-4 py-2">{t(STATUS[s.status].no, STATUS[s.status].en)}</td>
              </tr>
            ))}
            {!shipments.length && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-mute">
                  {busy ? t("Henter …", "Loading …") : t("Ingen forsendelser ennå.", "No shipments yet.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
