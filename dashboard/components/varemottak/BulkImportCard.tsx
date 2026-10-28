"use client";

/**
 * Upload card for the one-off loads: the customs rates and the purchase-price history.
 * Shows what was added and every row that was skipped, with the reason, so nothing disappears silently.
 */
import { useState } from "react";
import { SUPPLIER_PROFILES } from "@/lib/varemottak/suppliers/registry";
import { rateQuestions, type RateAsk } from "@/lib/varemottak/questions";
import QuestionList from "./QuestionList";
import { useTr } from "./useTr";

interface Skipped {
  row: number;
  reason: string;
  ask?: RateAsk;
}
type Result = Record<string, unknown> & { rows: number; skipped: Skipped[] };

const LABELS: Record<string, { no: string; en: string }> = {
  rows: { no: "Rader i filen", en: "Rows in file" },
  added: { no: "Lagt til", en: "Added" },
  replaced: { no: "Erstattet", en: "Replaced" },
  duplicates: { no: "Fantes fra før", en: "Already existed" },
  filledOpenLines: { no: "Tomme tollsatser fylt ut i åpne forsendelser", en: "Empty duty rates filled in on open shipments" },
  undated: { no: "Uten dato", en: "Without a date" },
  applied: { no: "Produkter med lagret salgsenhet", en: "Products with a saved selling unit" },
  filledKgLines: { no: "Kg-rader i åpne forsendelser som fikk salgsenhet", en: "Kg rows on open shipments that got a selling unit" },
};

/** Save the answer to a question about one row of a customs file: one rate per chosen value. */
async function answerRate(ask: RateAsk, answer: { supplier?: string; values: number[] }) {
  for (const dutyPerKg of answer.values) {
    const res = await fetch("/api/varemottak/customs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rate", scope: ask.scope, cn8: ask.cn8, supplier: answer.supplier ?? ask.supplier, idx: ask.idx, dutyPerKg, kind: ask.rateKind, sourceRef: ask.sourceRef || undefined, date: ask.date }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Kunne ikke lagre");
  }
}

export default function BulkImportCard({
  title,
  help,
  endpoint,
  withCurrency,
  hideSupplier,
  onDone,
}: {
  title: string;
  help: string;
  endpoint: string;
  withCurrency?: boolean;
  /** For files that are not tied to a supplier (the kg products). */
  hideSupplier?: boolean;
  onDone?: () => void;
}) {
  const { t, m } = useTr();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const suppliers = SUPPLIER_PROFILES.filter((p) => p.id !== "other");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(endpoint, { method: "POST", body: new FormData(e.currentTarget) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("Importen feilet", "The import failed"));
      setResult(data);
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const questions = result ? rateQuestions(result.skipped) : [];
  const plain = result ? result.skipped.filter((s) => !s.ask) : [];

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-line bg-cream-2 p-4" data-testid="bulk-import">
      <div>
        <h2 className="font-extrabold">{title}</h2>
        <p className="text-xs text-mute">{help}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_220px_auto_auto] sm:items-end">
        <label className="block text-sm">
          <span className="font-semibold">{t("Fil (CSV / Excel)", "File (CSV / Excel)")}</span>
          <input name="file" type="file" accept=".csv,.xlsx,.xls,.txt" required className="mt-1 block w-full text-sm" />
        </label>
        {hideSupplier ? (
          <span />
        ) : (
          <label className="block text-sm">
            <span className="font-semibold">{t("Leverandør", "Supplier")}</span>
            <select name="supplier" defaultValue="" className="mt-1 block w-full rounded-lg border border-line bg-white px-2 py-1.5">
              <option value="">{t("(fra kolonnen i filen)", "(from the column in the file)")}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.label}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {withCurrency ? (
          <label className="block text-sm">
            <span className="font-semibold">{t("Valuta", "Currency")}</span>
            <select name="currency" defaultValue="" className="mt-1 block rounded-lg border border-line bg-white px-2 py-1.5">
              <option value="">{t("(fra filen)", "(from the file)")}</option>
              {["PLN", "EUR", "USD", "SEK", "DKK", "NOK"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        ) : (
          <span />
        )}
        <button disabled={busy} className="rounded-lg bg-orange px-4 py-2 text-sm font-bold text-cream hover:opacity-90 disabled:opacity-50">
          {busy ? t("Importerer …", "Importing …") : t("Importer", "Import")}
        </button>
      </div>
      {error && <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{m(error)}</p>}
      {result && questions.length > 0 && (
        <QuestionList
          title={t("Spørsmål til deg om denne filen", "Questions for you about this file")}
          questions={questions}
          handlers={{
            onRateAsk: async (ask, answer) => {
              await answerRate(ask, answer);
              onDone?.();
            },
          }}
        />
      )}
      {result && (
        <div className="rounded-lg border border-line bg-white p-3 text-sm" data-testid="bulk-result">
          <p>
            {Object.keys(LABELS)
              .filter((k) => typeof result[k] === "number")
              .map((k) => `${t(LABELS[k].no, LABELS[k].en)}: ${result[k]}`)
              .join(" · ")}
            {result.skipped.length > 0 && <b className="text-amber"> · {t("Hoppet over", "Skipped")}: {result.skipped.length}</b>}
          </p>
          {plain.length > 0 && (
            <ul className="mt-1 max-h-40 list-disc overflow-auto pl-5 text-xs text-ink/80">
              {plain.slice(0, 100).map((s, i) => (
                <li key={i}>
                  {t("Rad", "Row")} {s.row}: {m(s.reason)}
                </li>
              ))}
              {plain.length > 100 && <li>{t(`… og ${plain.length - 100} til`, `… and ${plain.length - 100} more`)}</li>}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
