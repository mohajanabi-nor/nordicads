"use client";

/**
 * "Questions for you": what the app could not decide, one card per cause, with the products it concerns and a fix
 * on each product where the app can offer one. Used on the review screen (built from the calculated rows) and in
 * the import cards (built from what an import skipped).
 */
import { useState } from "react";
import { SUPPLIER_PROFILES } from "@/lib/varemottak/suppliers/registry";
import type { Bi, Choice, ItemFix, QItem, Question, RateAsk } from "@/lib/varemottak/questions";
import { useTr } from "./useTr";

export interface FixHandlers {
  /** Save a number on a row (duty, pieces per carton, weight, …). */
  onLineNumber?: (lineId: string, field: string, value: number) => Promise<void> | void;
  /** Open the product picker for a row. */
  onPick?: (lineId: string) => void;
  onShipmentRate?: (currency: string, value: number) => Promise<void> | void;
  onShipmentNumber?: (field: string, value: number) => Promise<void> | void;
  onShipmentDate?: (field: string, value: string) => Promise<void> | void;
  /** Save an answer to a customs-file question; `supplier`/`values` say what was chosen. */
  onRateAsk?: (ask: RateAsk, answer: { supplier?: string; values: number[] }) => Promise<void>;
}

const fmt = (v: number) => (Math.round(v * 10000) / 10000).toString().replace(".", ",");
const toNumber = (s: string) => Number(s.trim().replace(",", "."));

function Button({ children, onClick, disabled, primary }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-2.5 py-1 text-xs font-bold disabled:opacity-40 ${primary ? "border-[#b8500a] bg-[#b8500a] text-[#fffaf0] hover:opacity-90" : "border-line bg-white hover:bg-orange/10"}`}
    >
      {children}
    </button>
  );
}

function NumberInput({ placeholder, unit, onSave, busy, positive }: { placeholder?: string; unit: string; onSave: (n: number) => void; busy: boolean; positive?: boolean }) {
  const { t } = useTr();
  const [text, setText] = useState("");
  const value = toNumber(text);
  const ok = text.trim() !== "" && Number.isFinite(value) && (positive ? value > 0 : value >= 0);
  return (
    <span className="inline-flex items-center gap-1">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && ok && onSave(value)}
        inputMode="decimal"
        placeholder={placeholder ?? "0,00"}
        className="w-20 rounded border border-[#cdbf9d] bg-white px-1.5 py-1 text-right text-xs"
        aria-label={unit}
      />
      <span className="text-xs text-mute">{unit}</span>
      <Button primary onClick={() => ok && onSave(value)} disabled={!ok || busy}>
        {t("Lagre", "Save")}
      </Button>
    </span>
  );
}

function Choices({ choices, onChoose, busy }: { choices: Choice[]; onChoose: (v: number) => void; busy: boolean }) {
  return (
    <>
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          disabled={busy}
          onClick={() => onChoose(c.value)}
          title={c.hint}
          className="rounded-lg border border-[#b8500a] bg-[#fff3e2] px-2.5 py-1 text-xs font-bold text-[#7a3606] hover:bg-[#ffe6c4] disabled:opacity-40"
        >
          {c.label}
          {c.hint ? <span className="ml-1 font-normal opacity-70">({c.hint})</span> : null}
        </button>
      ))}
    </>
  );
}

function SupplierAnswer({ ask, run, busy }: { ask: RateAsk; run: (a: { supplier?: string; values: number[] }) => void; busy: boolean }) {
  const { t } = useTr();
  const profiles = SUPPLIER_PROFILES.filter((p) => p.id !== "other").map((p) => p.label);
  const first = ask.guesses[0] ?? "";
  const [supplier, setSupplier] = useState(first);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <select value={supplier} onChange={(e) => setSupplier(e.target.value)} className="rounded border border-[#cdbf9d] bg-white px-1.5 py-1 text-xs" aria-label={t("Leverandør", "Supplier")}>
        <option value="">{t("Velg leverandør …", "Choose supplier …")}</option>
        {ask.guesses.length > 0 && (
          <optgroup label={t("Foreslått (finnes allerede i appen)", "Suggested (already in the app)")}>
            {ask.guesses.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </optgroup>
        )}
        <optgroup label={t("Alle leverandører", "All suppliers")}>
          {profiles.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </optgroup>
      </select>
      <Button primary onClick={() => run({ supplier, values: ask.options })} disabled={!supplier || busy}>
        {t(`Lagre satsen ${fmt(ask.options[0] ?? 0)} kr/kg`, `Save the ${fmt(ask.options[0] ?? 0)} kr/kg rate`)}
      </Button>
    </span>
  );
}

function Fix({ item, handlers, onDone }: { item: QItem; handlers: FixHandlers; onDone: () => void }) {
  const { t } = useTr();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fix = item.fix as ItemFix;
  const run = async (f: () => Promise<void> | void) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
      // Questions about the shipment answer themselves: the row recalculates and drops out of the list. Only an
      // answer to a question about a file has nothing on screen to change, so it is marked as saved here.
      if (fix.kind === "rate-ask") onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const bi = (b: Bi) => t(b.no, b.en);

  switch (fix.kind) {
    case "pick":
      return <Button primary onClick={() => item.lineId && handlers.onPick?.(item.lineId)}>{t("Velg produkt …", "Choose product …")}</Button>;
    case "number": {
      const lineId = item.lineId as string;
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {fix.choices && <Choices choices={fix.choices} busy={busy} onChoose={(v) => run(() => handlers.onLineNumber?.(lineId, fix.field, v))} />}
          {fix.suggest && (
            <button type="button" disabled={busy} onClick={() => run(() => handlers.onLineNumber?.(lineId, fix.field, fix.suggest!.value))} title={bi(fix.suggest.why)} className="rounded-lg border border-[#b8500a] bg-[#fff3e2] px-2.5 py-1 text-xs font-bold text-[#7a3606] hover:bg-[#ffe6c4] disabled:opacity-40">
              {t("Bruk", "Use")} {fmt(fix.suggest.value)} <span className="font-normal opacity-70">({bi(fix.suggest.why)})</span>
            </button>
          )}
          <NumberInput unit={bi(fix.unit)} positive={fix.field !== "duty_per_kg" && fix.field !== "chosen_unit_price"} busy={busy} onSave={(n) => run(() => handlers.onLineNumber?.(lineId, fix.field, n))} />
          {err && <span className="text-xs text-red-700">{err}</span>}
        </span>
      );
    }
    case "shipment-rate":
      return <NumberInput unit="NOK" positive busy={busy} onSave={(n) => run(() => handlers.onShipmentRate?.(fix.currency, n))} />;
    case "shipment-number":
      return <NumberInput unit={bi(fix.unit)} busy={busy} onSave={(n) => run(() => handlers.onShipmentNumber?.(fix.field, n))} />;
    case "shipment-date":
      return <input type="date" onChange={(e) => e.target.value && run(() => handlers.onShipmentDate?.(fix.field, e.target.value))} className="rounded border border-[#cdbf9d] bg-white px-1.5 py-1 text-xs" aria-label={t("Ankomstdato", "Arrival date")} />;
    case "rate-ask": {
      const ask = fix.ask;
      const answer = (a: { supplier?: string; values: number[] }) => run(() => handlers.onRateAsk!(ask, a));
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {ask.kind === "supplier" && <SupplierAnswer ask={ask} run={answer} busy={busy} />}
          {ask.kind === "duty" && <NumberInput unit="kr/kg" busy={busy} onSave={(n) => answer({ supplier: ask.supplier ?? undefined, values: [n] })} />}
          {ask.kind === "two-rates" && (
            <>
              <Button primary disabled={busy} onClick={() => answer({ values: ask.options })}>
                {t(`Registrer begge (${ask.options.map(fmt).join(" og ")})`, `Register both (${ask.options.map(fmt).join(" and ")})`)}
              </Button>
              {ask.options.map((o) => (
                <Button key={o} disabled={busy} onClick={() => answer({ values: [o] })}>
                  {t(`Bare ${fmt(o)}`, `Only ${fmt(o)}`)}
                </Button>
              ))}
            </>
          )}
          {err && <span className="text-xs text-red-700">{err}</span>}
        </span>
      );
    }
  }
}

export default function QuestionList({ questions, handlers, title }: { questions: Question[]; handlers: FixHandlers; title?: string }) {
  const { t, m } = useTr();
  const text = (v: Bi | string) => (typeof v === "string" ? m(v) : t(v.no, v.en));
  const [done, setDone] = useState<Set<string>>(new Set());
  if (!questions.length) return null;
  const mark = (key: string) => setDone((d) => new Set(d).add(key));
  const open = questions.reduce((a, q) => a + q.items.filter((i) => !done.has(i.key)).length, 0);

  return (
    <section className="space-y-2 rounded-2xl border-2 border-[#d9a441] bg-[#fff8e6] p-4" data-testid="questions">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-extrabold">{title ?? t("Spørsmål til deg", "Questions for you")}</h2>
        <p className="text-xs text-mute">{t(`${open} ting appen ikke kan avgjøre selv`, `${open} things the app cannot decide on its own`)}</p>
      </div>
      {questions.map((q) => {
        const left = q.items.filter((i) => !done.has(i.key));
        return (
          <details key={q.id} open={q.severity === "blocking" && questions.length <= 4} className="rounded-xl border border-line bg-white" data-testid={`question-${q.id}`}>
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm font-bold">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase ${q.severity === "blocking" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"}`}>
                {q.severity === "blocking" ? t("Stopper", "Blocks") : t("Sjekk", "Check")}
              </span>
              <span>{t(q.title.no, q.title.en)}</span>
              {left.length < q.items.length && <span className="text-xs font-normal text-green-700">{t(`${q.items.length - left.length} løst`, `${q.items.length - left.length} fixed`)}</span>}
            </summary>
            <div className="space-y-2 border-t border-line px-3 py-2">
              <p className="text-sm text-ink/80">{t(q.why.no, q.why.en)}</p>
              {q.howTo && (
                <p className="rounded-lg bg-cream-2 px-2 py-1 text-xs">
                  <b>{t("Slik løser du det:", "How to fix it:")}</b> {t(q.howTo.no, q.howTo.en)}
                </p>
              )}
              <ul className="max-h-80 divide-y divide-line overflow-auto">
                {q.items.map((item) => (
                  <li key={item.key} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <div className="min-w-0 max-w-[60ch]">
                      <div className="truncate text-sm font-semibold" title={typeof item.label === "string" ? item.label : item.label.no}>
                        {done.has(item.key) ? "✓ " : ""}
                        {typeof item.label === "string" ? item.label : text(item.label)}
                      </div>
                      {item.sub && <div className="text-xs text-mute">{text(item.sub)}</div>}
                    </div>
                    {done.has(item.key) ? (
                      <span className="text-xs font-bold text-green-700">{t("Lagret", "Saved")}</span>
                    ) : item.fix ? (
                      <Fix item={item} handlers={handlers} onDone={() => mark(item.key)} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        );
      })}
    </section>
  );
}
