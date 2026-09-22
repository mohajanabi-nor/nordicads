"use client";

/**
 * Which supplier is cheapest, per product.
 *
 * The grid shows every supplier's current price side by side, with the lowest
 * marked. Rows whose prices are NOT comparable — different currency, different
 * VAT basis, different pack size — say so instead of ranking them, because a
 * confidently wrong "cheapest" is worse than an honest "look at these two".
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface SupplierPrice {
  supplierId: string;
  supplierName: string;
  price: number;
  currency: string;
  vatBasis: string;
  vatBasisAssumed: boolean;
  unit: string | null;
  packSize: string | null;
  pricePerBaseUnit: number | null;
  validFrom: string | null;
  observedAt: string;
  isLowest: boolean;
}

interface ProductComparison {
  productId: string;
  productName: string;
  baseUnit: string | null;
  suppliers: SupplierPrice[];
  notComparable: string | null;
  savingVsHighest: number | null;
}

const kr = (n: number, currency: string) =>
  `${n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

export default function PriserPage() {
  const [products, setProducts] = useState<ProductComparison[]>([]);
  const [unresolved, setUnresolved] = useState(0);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/priser?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setProducts(data.products ?? []);
      setUnresolved(data.unresolved ?? 0);
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }, [query]);

  useEffect(() => {
    const t = setTimeout(load, query ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Priser</h1>
          <p className="mt-1 text-sm text-ink/60">
            Laveste pris per vare, hentet fra prislistene leverandørene sender på e-post.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {unresolved > 0 ? (
            <Link
              href="/priser/uavklarte"
              className="rounded-lg border border-orange/40 bg-orange/10 px-3 py-2 text-sm font-semibold text-ink hover:bg-orange/20"
            >
              {unresolved} uavklart{unresolved === 1 ? "" : "e"} →
            </Link>
          ) : null}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Søk etter vare…"
            className="w-56 rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-orange"
          />
        </div>
      </header>

      {error ? (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
      ) : null}

      {busy && !products.length ? (
        <p className="text-sm text-ink/50">Henter…</p>
      ) : !products.length ? (
        <div className="rounded-xl border border-line bg-cream-2/50 p-6 text-sm text-ink/70">
          <p className="font-semibold text-ink">Ingen priser ennå.</p>
          <p className="mt-1">
            Prislister som kommer inn på e-post fra registrerte leverandører dukker opp her
            automatisk. Legg inn leverandørene og avsenderdomenene deres under{" "}
            <Link href="/priser/uavklarte" className="underline">uavklarte</Link>.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-cream-2/70 text-left text-xs uppercase tracking-wide text-ink/60">
              <tr>
                <th className="px-4 py-3 font-semibold">Vare</th>
                <th className="px-4 py-3 font-semibold">Leverandører</th>
                <th className="px-4 py-3 text-right font-semibold">Å spare</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.productId} className="border-t border-line align-top">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-ink">{p.productName}</div>
                    {p.baseUnit ? <div className="text-xs text-ink/50">per {p.baseUnit}</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {p.suppliers.map((s) => (
                        <span
                          key={s.supplierId}
                          title={[
                            s.vatBasis === "eks_mva" ? "eks. mva" : s.vatBasis === "inkl_mva" ? "inkl. mva" : "mva ukjent",
                            s.vatBasisAssumed ? "(antatt)" : "",
                            s.packSize ? `pakning: ${s.packSize}` : "",
                            s.validFrom ? `gjelder fra ${s.validFrom}` : "",
                          ].filter(Boolean).join(" · ")}
                          className={
                            "rounded-lg border px-2.5 py-1 " +
                            (s.isLowest
                              ? "border-green-600/40 bg-green-50 font-bold text-green-900"
                              : "border-line bg-white text-ink/80")
                          }
                        >
                          {s.supplierName}: {kr(s.pricePerBaseUnit ?? s.price, s.currency)}
                          {s.vatBasisAssumed ? <span className="ml-1 text-ink/40">*</span> : null}
                        </span>
                      ))}
                    </div>
                    {p.notComparable ? (
                      <p className="mt-2 text-xs font-medium text-amber-800">⚠ {p.notComparable}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-ink">
                    {p.savingVsHighest ? kr(p.savingVsHighest, p.suppliers[0]?.currency ?? "NOK") : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-ink/40">
        * mva-grunnlaget sto ikke i dokumentet og er antatt eks. mva.
      </p>
    </div>
  );
}
