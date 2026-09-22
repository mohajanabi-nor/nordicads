"use client";

/**
 * The review queue.
 *
 * Everything the pipeline would not decide on its own: products it could not
 * identify, emails it could not read, and senders no supplier claims. This
 * screen exists so that "not sure" has somewhere to go other than silence —
 * a price quietly missing from the comparison is the failure mode worth the
 * most effort to avoid.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Candidate {
  id: string;
  name: string;
}

interface ReviewItem {
  id: string;
  rawName: string;
  sku: string | null;
  suggestedProductId: string | null;
  suggestedName: string | null;
  matchMethod: string | null;
  confidence: number;
  candidates: Candidate[];
}

interface EmailRow {
  id: string;
  from_address: string;
  subject: string | null;
  received_at: string;
  status: string;
  error_message?: string | null;
}

export default function UavklartePage() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [unknown, setUnknown] = useState<EmailRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState("");
  const [supplierSenders, setSupplierSenders] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/priser/uavklarte");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setItems(data.products ?? []);
      setEmails(data.emails ?? []);
      setUnknown(data.unknownSenders ?? []);
      setError(null);
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/priser/uavklarte/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) setError(data.error);
    else setItems((prev) => prev.filter((i) => i.id !== id));
  }

  async function retry(id: string) {
    await fetch(`/api/priser/emails/${id}/retry`, { method: "POST" });
    await load();
  }

  async function addSupplier() {
    const senders = supplierSenders.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const res = await fetch("/api/priser/suppliers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: supplierName, senders }),
    });
    const data = await res.json();
    if (data.error) setError(data.error);
    else {
      setSupplierName("");
      setSupplierSenders("");
      await load();
    }
  }

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Uavklarte</h1>
          <p className="mt-1 text-sm text-ink/60">
            Alt systemet ikke ville avgjøre selv. Ingenting her er kastet — det venter bare på deg.
          </p>
        </div>
        <Link href="/priser" className="text-sm font-semibold text-ink/70 underline">
          ← Til prisoversikten
        </Link>
      </header>

      {error ? (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
      ) : null}

      {unknown.length ? (
        <section className="space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink/60">
            E-post fra ukjent avsender ({unknown.length})
          </h2>
          <p className="text-sm text-ink/60">
            Disse ble tatt vare på, men ingen leverandør eier avsenderadressen ennå.
          </p>
          <ul className="divide-y divide-line rounded-xl border border-line bg-white">
            {unknown.map((e) => (
              <li key={e.id} className="px-4 py-3 text-sm">
                <span className="font-semibold text-ink">{e.from_address}</span>
                <span className="text-ink/50"> — {e.subject || "(uten emne)"}</span>
              </li>
            ))}
          </ul>

          <div className="rounded-xl border border-line bg-cream-2/50 p-4">
            <h3 className="text-sm font-bold text-ink">Legg til leverandør</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                placeholder="Navn"
                className="w-48 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-orange"
              />
              <input
                value={supplierSenders}
                onChange={(e) => setSupplierSenders(e.target.value)}
                placeholder="@domene.no, person@domene.no"
                className="w-80 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-orange"
              />
              <button
                onClick={addSupplier}
                disabled={!supplierName.trim()}
                className="rounded-lg bg-orange px-4 py-2 text-sm font-bold text-cream disabled:opacity-40"
              >
                Lagre
              </button>
            </div>
            <p className="mt-2 text-xs text-ink/50">
              Bruk @domene.no for å fange alle hos leverandøren — da slipper du å legge inn hver
              selger for seg.
            </p>
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink/60">
          Produkter som må kobles ({items.length})
        </h2>
        {busy && !items.length ? (
          <p className="text-sm text-ink/50">Henter…</p>
        ) : !items.length ? (
          <p className="text-sm text-ink/50">Ingenting venter. </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-xl border border-line bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-ink">{item.rawName}</div>
                    <div className="text-xs text-ink/50">
                      {item.sku ? `varenr ${item.sku} · ` : ""}
                      {item.matchMethod === "cross_supplier"
                        ? "en annen leverandør bruker samme ordlyd — bekreft at det er samme vare"
                        : "ingen match funnet"}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {item.suggestedProductId ? (
                      <button
                        onClick={() => resolve(item.id, { action: "match", productId: item.suggestedProductId })}
                        className="rounded-lg bg-green-700 px-3 py-1.5 text-sm font-bold text-white hover:opacity-90"
                      >
                        Samme som «{item.suggestedName}»
                      </button>
                    ) : null}
                    <select
                      defaultValue=""
                      onChange={(e) => e.target.value && resolve(item.id, { action: "match", productId: e.target.value })}
                      className="rounded-lg border border-line px-2 py-1.5 text-sm"
                    >
                      <option value="">Koble til eksisterende…</option>
                      {item.candidates.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => resolve(item.id, { action: "new", canonicalName: item.rawName })}
                      className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-ink hover:bg-orange/10"
                    >
                      Ny vare
                    </button>
                    <button
                      onClick={() => resolve(item.id, { action: "ignore" })}
                      className="rounded-lg px-3 py-1.5 text-sm text-ink/50 hover:bg-orange/10"
                    >
                      Ignorer
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {emails.length ? (
        <section className="space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink/60">
            E-poster som trenger et blikk ({emails.length})
          </h2>
          <ul className="divide-y divide-line rounded-xl border border-line bg-white">
            {emails.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <div>
                  <span className="font-semibold text-ink">{e.from_address}</span>
                  <span className="text-ink/50"> — {e.subject || "(uten emne)"}</span>
                  <div className="text-xs text-ink/50">
                    {e.status === "extraction_failed" ? `kunne ikke leses: ${e.error_message ?? "ukjent feil"}` : "lest, men noe må bekreftes"}
                  </div>
                </div>
                <button
                  onClick={() => retry(e.id)}
                  className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm font-semibold hover:bg-orange/10"
                >
                  Prøv igjen
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
