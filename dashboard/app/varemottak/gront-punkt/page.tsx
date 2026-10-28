"use client";

/**
 * Grønt Punkt: the packaging report for imported beverages, per two-month term.
 *
 * Counts units from the shipments imported here, by arrival date. The portal is typed
 * into by hand, so the report is laid out in the portal's own order, with a print view
 * and a CSV.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, fmt } from "@/components/varemottak/cells";
import { useTr } from "@/components/varemottak/useTr";

interface Line {
  code: string;
  name: string;
  unit: "kg" | "pcs";
  quantity: number;
  rate: number | null;
  sum: number | null;
  previousPeriod: number;
  sameLastYear: number;
}
interface Product {
  productId: string | null;
  idx: string;
  name: string;
  shopifyTitle: string | null;
  units: number;
  gpCode: string | null;
  gpPackagingKg: number | null;
  suggestion: { code: string | null; reason: string };
}
interface Category {
  code: string;
  name: string;
  unit: "kg" | "pcs";
  archived: boolean;
}
interface Overview {
  report: { term: { code: string; start: string; end: string; deadline: string }; lines: Line[]; total: number; problems: string[] };
  categories: Category[];
  rates: Array<{ code: string; valid_from: string; rate: number }>;
  products: Product[];
  unassigned: number;
}

const termNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-RT${Math.ceil((d.getMonth() + 1) / 2)}`;
};
const termOptions = () => {
  const y = new Date().getFullYear();
  const out: string[] = [];
  for (let year = y; year >= y - 2; year--) for (let n = 6; n >= 1; n--) out.push(`${year}-RT${n}`);
  return out;
};

export default function GrontPunktPage() {
  const { t, m } = useTr();
  const [term, setTerm] = useState(termNow());
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/varemottak/gp?term=${term}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setData(json);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [term]);
  useEffect(() => {
    load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/varemottak/gp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? t("Feilet", "Failed"));
    return json;
  }

  const active = useMemo(() => (data?.categories ?? []).filter((c) => !c.archived), [data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <Link href="/varemottak" className="text-xs font-semibold text-orange hover:underline">
            {t("← Varemottak", "← Goods receipt")}
          </Link>
          <h1 className="text-2xl font-extrabold tracking-tight">Grønt Punkt</h1>
          <p className="text-sm text-mute">{t("Rapport for importert drikke (Vareimportør), per to-måneders periode.", "Report for imported beverages (Vareimportør), per two-month period.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={term} onChange={(e) => setTerm(e.target.value)} className="rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold">
            {termOptions().map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <a href={`/api/varemottak/gp?term=${term}&format=csv`} className="rounded-lg border border-line bg-cream-2 px-3 py-2 text-sm font-semibold hover:bg-orange/10">
            CSV
          </a>
          <button onClick={() => window.print()} className="rounded-lg bg-orange px-3 py-2 text-sm font-bold text-cream hover:opacity-90">
            {t("Skriv ut", "Print")}
          </button>
        </div>
      </div>

      {error && <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{m(error)}</p>}

      {data && (
        <>
          <section className="rounded-2xl border border-line bg-white p-5">
            <h2 className="text-lg font-extrabold">
              {t(`Drikkevarer – terminvis for NORDIC ENGROS AS, periode ${data.report.term.code}`, `Beverages – by term for NORDIC ENGROS AS, period ${data.report.term.code}`)}
            </h2>
            <p className="text-sm text-mute">
              {data.report.term.start} – {data.report.term.end} · {t("frist for innsending", "submission deadline")} {data.report.term.deadline}
            </p>

            {data.report.problems.length > 0 && (
              <ul className="mt-3 space-y-1 print:hidden">
                {data.report.problems.map((p, i) => (
                  <li key={i} className="rounded-lg border border-yellow-400 bg-yellow-50 px-3 py-1.5 text-sm text-yellow-900">
                    {m(p)}
                  </li>
                ))}
              </ul>
            )}

            <table className="mt-4 w-full text-sm">
              <thead className="text-left text-xs text-mute">
                <tr>
                  <th className="py-1">#</th>
                  <th>{t("Emballasjetype / produkt", "Packaging type / product")}</th>
                  <th className="text-right">{t("Forrige periode", "Previous period")}</th>
                  <th className="text-right">{t("Samme periode i fjor", "Same period last year")}</th>
                  <th className="text-right">{t("Denne perioden", "This period")}</th>
                  <th className="text-right">{t("Pris pr. enhet", "Price per unit")}</th>
                  <th className="text-right">{t("Sum", "Total")}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {data.report.lines.map((l) => (
                  <tr key={l.code} className="border-t border-line">
                    <td className="py-1.5 font-mono">{l.code}</td>
                    <td>{l.name}</td>
                    <td className="text-right">{fmt(l.previousPeriod, l.unit === "kg" ? 1 : 0)} {l.unit === "kg" ? "kg" : t("stk", "pcs")}</td>
                    <td className="text-right">{fmt(l.sameLastYear, l.unit === "kg" ? 1 : 0)} {l.unit === "kg" ? "kg" : t("stk", "pcs")}</td>
                    <td className="text-right font-bold">{fmt(l.quantity, l.unit === "kg" ? 2 : 0)} {l.unit === "kg" ? "kg" : t("stk", "pcs")}</td>
                    <td className="text-right">{l.rate === null ? "–" : t(`${fmt(l.rate, 4)} kr pr. ${l.unit === "kg" ? "kg" : "stk"}`, `${fmt(l.rate, 4)} NOK per ${l.unit === "kg" ? "kg" : "pcs"}`)}</td>
                    <td className="text-right">{l.sum === null ? "–" : t(`${fmt(l.sum)} kr`, `${fmt(l.sum)} NOK`)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink font-extrabold">
                  <td colSpan={6} className="py-2 text-right">
                    {t("Totalbeløp (ekskl. mva.)", "Total amount (excl. VAT)")}
                  </td>
                  <td className="text-right">{fmt(data.report.total)} {t("kr", "NOK")}</td>
                </tr>
              </tfoot>
            </table>
          </section>

          <section className="rounded-2xl border border-line bg-cream-2 p-4 print:hidden">
            <h2 className="mb-1 font-extrabold">{t("Drikkevarer og Grønt Punkt-kode", "Beverages and Grønt Punkt code")}</h2>
            <p className="mb-3 text-xs text-mute">
              {t(
                "Settes én gang per produkt. Plastflasker rapporteres i kg, så de trenger emballasjevekt per flaske. Varer uten kode flagges når fakturaen importeres.",
                "Set once per product. Plastic bottles are reported in kg, so they need a packaging weight per bottle. Products without a code are flagged when the invoice is imported.",
              )}
            </p>
            <div className="overflow-auto rounded-xl border border-line bg-white">
              <table className="w-full text-sm">
                <thead className="bg-cream-2 text-left text-xs uppercase tracking-wide text-mute">
                  <tr>
                    <th className="px-3 py-2">{t("Produkt", "Product")}</th>
                    <th className="px-3 py-2 text-right">{t("Antall", "Quantity")}</th>
                    <th className="px-3 py-2">{t("Kode", "Code")}</th>
                    <th className="px-3 py-2">{t("Vekt per flaske (kg)", "Weight per bottle (kg)")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((p) => (
                    <ProductRow key={`${p.productId}-${p.idx}`} p={p} categories={active} onSave={(gpCode, kg) => post({ action: "product", productId: p.productId, gpCode, gpPackagingKg: kg }).then(load).catch((e) => setError(e.message))} />
                  ))}
                  {!data.products.length && (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-mute">
                        {t("Ingen drikkevarer i denne perioden.", "No beverages in this period.")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <CategoriesEditor categories={data.categories} rates={data.rates} onSave={(body) => post({ action: "category", ...body }).then(load).catch((e) => setError(e.message))} onArchive={(code) => post({ action: "archive", code }).then(load).catch((e) => setError(e.message))} />
        </>
      )}
    </div>
  );
}

function ProductRow({ p, categories, onSave }: { p: Product; categories: Category[]; onSave: (code: string | null, kg: number | null) => void }) {
  const { t, m } = useTr();
  const [code, setCode] = useState(p.gpCode ?? "");
  const [kg, setKg] = useState(p.gpPackagingKg === null ? "" : String(p.gpPackagingKg).replace(".", ","));
  const cat = categories.find((c) => c.code === code);
  const save = (nextCode: string, nextKg: string) => {
    if (!p.productId) return;
    const n = nextKg.trim() === "" ? null : Number(nextKg.replace(",", "."));
    onSave(nextCode || null, n !== null && Number.isFinite(n) ? n : null);
  };
  return (
    <tr className={`border-t border-line ${p.gpCode ? "" : "bg-yellow-50"}`}>
      <td className="px-3 py-1.5">
        <div className="font-semibold">{p.shopifyTitle ?? p.name}</div>
        {!p.gpCode && (
          <div className="text-xs text-amber">
            {p.suggestion.code ? (
              <>
                {t("Forslag:", "Suggestion:")} <button className="font-bold underline" onClick={() => { setCode(p.suggestion.code!); save(p.suggestion.code!, kg); }}>{p.suggestion.code}</button> – {m(p.suggestion.reason)}
              </>
            ) : (
              m(p.suggestion.reason)
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">{fmt(p.units, 0)}</td>
      <td className="px-3 py-1.5">
        <select
          value={code}
          disabled={!p.productId}
          onChange={(e) => {
            const next = e.target.value;
            setCode(next);
            // A kg category needs the bottle weight; wait for it instead of sending a request that must fail.
            if (categories.find((c) => c.code === next)?.unit === "kg" && !kg.trim()) return;
            save(next, kg);
          }}
          className="rounded-lg border border-line bg-white px-2 py-1 text-sm"
        >
          <option value="">{t("Velg …", "Select …")}</option>
          {categories.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} {c.name}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-1.5">
        {cat?.unit === "kg" ? (
          <input
            value={kg}
            onChange={(e) => setKg(e.target.value)}
            onBlur={() => save(code, kg)}
            placeholder={t("f.eks. 0,025", "e.g. 0,025")}
            className={`w-28 rounded-lg border bg-white px-2 py-1 text-right text-sm ${kg ? "border-line" : "border-yellow-400 bg-yellow-100"}`}
          />
        ) : (
          <span className="text-mute">–</span>
        )}
      </td>
    </tr>
  );
}

function CategoriesEditor({
  categories,
  rates,
  onSave,
  onArchive,
}: {
  categories: Category[];
  rates: Array<{ code: string; valid_from: string; rate: number }>;
  onSave: (b: { code: string; name: string; unit: "kg" | "pcs"; rate: number; validFrom: string }) => void;
  onArchive: (code: string) => void;
}) {
  const { t } = useTr();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<"kg" | "pcs">("pcs");
  const [rate, setRate] = useState("");
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const current = (c: string) => rates.filter((r) => r.code === c).sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1))[0];

  return (
    <section className="rounded-2xl border border-line bg-cream-2 p-4 print:hidden">
      <h2 className="mb-1 font-extrabold">{t("Kategorier og satser", "Categories and rates")}</h2>
      <p className="mb-3 text-xs text-mute">
        {t(
          "Nye emballasjetyper (andre størrelser eller materialer) legges til her, uten kodeendring. En ny sats gjelder fra datoen, ikke bakover.",
          "New packaging types (other sizes or materials) are added here, without a code change. A new rate applies from its date, not retroactively.",
        )}
      </p>
      <ul className="mb-3 divide-y divide-line rounded-xl border border-line bg-white text-sm">
        {categories.map((c) => (
          <li key={c.code} className={`flex items-center justify-between gap-3 px-3 py-1.5 ${c.archived ? "opacity-50" : ""}`}>
            <span>
              <span className="font-mono">{c.code}</span> {c.name} <Badge tone="gray">{c.unit === "kg" ? "kg" : t("stk", "pcs")}</Badge>
            </span>
            <span className="flex items-center gap-3 tabular-nums">
              {current(c.code)
                ? t(`${fmt(current(c.code).rate, 4)} kr (fra ${current(c.code).valid_from})`, `${fmt(current(c.code).rate, 4)} NOK (from ${current(c.code).valid_from})`)
                : t("ingen sats", "no rate")}
              {!c.archived && (
                <button onClick={() => confirm(t(`Arkivere ${c.code}?`, `Archive ${c.code}?`)) && onArchive(c.code)} className="text-xs text-mute hover:text-red-700">
                  {t("Arkiver", "Archive")}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ code, name, unit, rate: Number(rate.replace(",", ".")), validFrom: from });
          setCode("");
          setName("");
          setRate("");
        }}
        className="grid gap-2 sm:grid-cols-[100px_1fr_100px_110px_150px_auto]"
      >
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("Kode", "Code")} required className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Navn", "Name")} required className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm" />
        <select value={unit} onChange={(e) => setUnit(e.target.value as "kg" | "pcs")} className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm">
          <option value="pcs">{t("stk", "pcs")}</option>
          <option value="kg">kg</option>
        </select>
        <input value={rate} onChange={(e) => setRate(e.target.value)} placeholder={t("Sats kr", "Rate NOK")} required className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm" />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm" />
        <button className="rounded-lg bg-orange px-3 py-1.5 text-sm font-bold text-cream hover:opacity-90">{t("Legg til / endre", "Add / change")}</button>
      </form>
    </section>
  );
}
