"use client";

/**
 * Pick the right Shopify product for a row the import could not match with certainty.
 *
 * Two ways to the answer, on one screen:
 *   1. "Systemet foreslår" — the products the system thinks it may be, best first, each with the
 *      reasons (same EAN, same size, same brand …). One click confirms it.
 *   2. "Finn selv" — a search for the product the operator already knows is the right one. The
 *      proposals can be wrong or incomplete, so this is always available: it takes words, an article
 *      number or an EAN.
 *
 * The choice is remembered per supplier + article number, so it is made once.
 */
import { useEffect, useState } from "react";
import type { LineRow } from "@/lib/varemottak/lines";
import { Badge, Thumb } from "./cells";
import { useTr } from "./useTr";

interface Candidate {
  id: string;
  title: string;
  vendor: string;
  status: string;
  imageUrl: string | null;
  tags: string[];
  barcodes?: string[];
  variantPrice?: number | null;
  score?: number;
  reasons?: string[];
  usedBy?: string | null;
}

export default function MatchPicker({
  line,
  onClose,
  onPicked,
}: {
  line: LineRow;
  onClose: () => void;
  onPicked: (updated: LineRow) => void;
}) {
  const { t, m } = useTr();
  const [proposals, setProposals] = useState<Candidate[] | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the system thinks it may be — loaded when the picker opens.
  useEffect(() => {
    let alive = true;
    fetch(`/api/varemottak/lines/${line.id}/suggestions`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (alive) setProposals(data);
      })
      .catch((err) => {
        if (alive) {
          setProposals([]);
          setError(err.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [line.id]);

  // The operator's own search.
  useEffect(() => {
    if (q.trim().length < 3) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/varemottak/products?q=${encodeURIComponent(q.trim())}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setResults(data);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [q]);

  async function pick(productId: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/varemottak/lines/${line.id}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onPicked(data);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const row = (p: Candidate, primary: boolean) => (
    <button
      key={`${primary ? "p" : "s"}${p.id}`}
      disabled={busy}
      onClick={() => pick(p.id)}
      className="flex w-full items-center gap-3 border-t border-line px-4 py-2 text-left hover:bg-orange/10 disabled:opacity-50"
    >
      <Thumb url={p.imageUrl} size={52} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold" title={p.title}>
          {p.title}
        </span>
        <span className="block truncate text-xs text-mute">
          {p.vendor} · {p.tags.slice(0, 5).join(", ")}
          {p.barcodes?.length ? ` · EAN ${p.barcodes[0]}` : ""}
        </span>
        {p.reasons && p.reasons.length > 0 && (
          <span className="mt-0.5 flex flex-wrap gap-1">
            {p.reasons.map((r) => (
              <span key={r} className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-ink/70">
                {m(r)}
              </span>
            ))}
          </span>
        )}
        {p.usedBy && <span className="mt-0.5 block text-[11px] font-semibold text-red-700">{t(`Brukes allerede av varenummer ${p.usedBy} i denne forsendelsen`, `Already used by item number ${p.usedBy} in this shipment`)}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <Badge tone={p.status === "ACTIVE" ? "green" : "yellow"}>{p.status === "ACTIVE" ? t("Aktiv", "Active") : t("Utkast", "Draft")}</Badge>
        {primary && <Badge tone="orange">{t("Velg", "Select")}</Badge>}
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-cream-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-line p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-extrabold">{t("Velg riktig produkt", "Select the right product")}</h2>
              <p className="text-sm">
                <span className="font-mono">{line.idx}</span> · {line.name}
              </p>
              <p className="mt-0.5 text-xs text-mute">
                {Number(line.qty)} {line.unit === "kilo" ? "kg" : t("stk", "pcs")}
                {line.ean ? ` · EAN ${line.ean}` : ""}
              </p>
              {line.match_reason && <p className="mt-1 text-xs text-amber">{m(line.match_reason)}</p>}
            </div>
            <button onClick={onClose} className="rounded px-2 py-1 text-mute hover:bg-black/5" aria-label={t("Lukk", "Close")}>
              ✕
            </button>
          </div>
        </div>

        <div className="overflow-auto">
          {error && <p className="px-4 py-2 text-sm text-red-700">{m(error)}</p>}

          <section className="bg-white">
            <h3 className="px-4 pt-3 text-xs font-bold uppercase tracking-wide text-mute">{t("Systemet foreslår", "Suggested by the system")}</h3>
            {proposals === null && <p className="px-4 py-3 text-sm text-mute">{t("Leter etter produkter som kan passe …", "Looking for products that may match …")}</p>}
            {proposals && proposals.length === 0 && (
              <p className="px-4 py-3 text-sm text-mute">{t("Systemet fant ingen sannsynlige produkter. Bruk søket under hvis du vet hvilket produkt det er.", "The system found no likely products. Use the search below if you know which product it is.")}</p>
            )}
            {proposals?.map((p) => row(p, true))}
          </section>

          <section className="border-t-2 border-orange/30 bg-cream-2 pb-2">
            <h3 className="px-4 pt-3 text-xs font-bold uppercase tracking-wide text-mute">{t("Finn selv", "Find it yourself")}</h3>
            <p className="px-4 text-xs text-mute">{t("Forslagene kan mangle det riktige produktet. Søk på navn, varenummer eller EAN.", "The suggestions may not include the right product. Search by name, item number or EAN.")}</p>
            <div className="px-4 py-2">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("f.eks. «lays salt 130», et varenummer eller en EAN", "e.g. “lays salt 130”, an item number or an EAN")}
                className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
              />
            </div>
            {searching && <p className="px-4 pb-2 text-sm text-mute">{t("Søker …", "Searching …")}</p>}
            {results.map((p) => row(p, false))}
            {!searching && q.trim().length >= 3 && results.length === 0 && !error && <p className="px-4 pb-2 text-sm text-mute">{t("Ingen treff.", "No matches.")}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
