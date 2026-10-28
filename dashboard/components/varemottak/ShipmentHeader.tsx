"use client";

/**
 * The top of a shipment: its settings (exchange rates, freight, markup), the import
 * form, what invoice control found, and the shipment's totals.
 */
import { FIELD_LABELS, NO_COLUMN, REQUIRED_FIELDS, type Field } from "@/lib/varemottak/suppliers/fields";
import { useState } from "react";
import { SUPPLIER_PROFILES, profileFor } from "@/lib/varemottak/suppliers/registry";
import type { ShipmentSummary } from "@/lib/varemottak/calc";
import type { InvoiceRow, ShipmentRow } from "@/lib/varemottak/lines";
import { Badge, NumCell, fmt, fmtPct } from "./cells";
import { useTr } from "./useTr";

const FREIGHT_CURRENCIES = ["NOK", "EUR", "PLN", "USD", "SEK", "DKK"];

export interface ImportOutcome {
  invoiceNo: string;
  rawLines: number;
  products: number;
  matched: number;
  doubtful: number;
  unmatched: number;
  control: { checks: Array<{ code: string; severity: string; text: string }> };
  summary: {
    up: number;
    down: number;
    new: number;
    raisedWithoutPriceChange: number;
    largestIncreases: Array<{ idx: string; name: string; changePct: number }>;
    belowMargin: Array<{ idx: string; name: string; margin: number }>;
  };
  warnings: string[];
}

const SEVERITY_STYLE: Record<string, string> = {
  ok: "border-green-300 bg-green-50 text-green-900",
  info: "border-line bg-white text-ink/80",
  warn: "border-yellow-400 bg-yellow-50 text-yellow-900",
  block: "border-red-300 bg-red-50 text-red-900",
};

export default function ShipmentHeader({
  shipment,
  invoices,
  summary,
  otherCostsNok,
  freightMissingRate,
  warnings,
  onPatch,
  onImported,
}: {
  shipment: ShipmentRow;
  invoices: InvoiceRow[];
  summary: ShipmentSummary;
  otherCostsNok: number;
  freightMissingRate: boolean;
  warnings: string[];
  onPatch: (patch: Record<string, unknown>) => void;
  onImported: (r: ImportOutcome) => void;
}) {
  const { t, m } = useTr();
  const currencies = Array.from(new Set([...invoices.map((i) => i.currency), shipment.freight_currency])).filter((c) => c !== "NOK");
  // The import form opens by itself on an empty shipment, and from "Add invoice" in the notes box.
  const [importOpen, setImportOpen] = useState(invoices.length === 0);
  const warnCount = warnings.length + invoices.reduce((n, i) => n + i.warnings.length + i.control.filter((c) => c.severity === "warn" || c.severity === "block").length, 0);

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-cream-2 px-4 py-3">
        <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-mute">{t("Innstillinger", "Settings")}</h2>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3 text-sm">
          <Field label={t("Ankomstdato", "Arrival date")} className="w-[150px]">
            <input
              type="date"
              defaultValue={shipment.arrival_date ?? ""}
              onBlur={(e) => e.target.value !== (shipment.arrival_date ?? "") && onPatch({ arrival_date: e.target.value || null })}
              className="w-full rounded-lg border border-line bg-white px-2 py-1"
            />
          </Field>

          {currencies.map((c) => (
            <Field key={c} label={t(`Kurs ${c} → NOK`, `Rate ${c} → NOK`)} className="w-[110px]">
              <NumCell
                value={shipment.rates[c] ?? null}
                digits={4}
                placeholder={t("f.eks. 2,498", "e.g. 2,498")}
                className={`border-line bg-white ${shipment.rates[c] ? "" : "!border-yellow-400 !bg-yellow-100"}`}
                onCommit={(n) => onPatch({ rates: { ...shipment.rates, [c]: n } })}
              />
            </Field>
          ))}

          <Field label={t("Frakt totalt", "Total freight")} className="w-[190px]">
            <div className="flex gap-1">
              <NumCell
                value={shipment.freight_amount === null ? null : Number(shipment.freight_amount)}
                className={`border-line bg-white ${freightMissingRate || (invoices.length > 0 && !Number(shipment.freight_amount)) ? "!border-yellow-400 !bg-yellow-100" : ""}`}
                onCommit={(n) => onPatch({ freight_amount: n })}
              />
              <select
                value={shipment.freight_currency}
                onChange={(e) => onPatch({ freight_currency: e.target.value })}
                className="rounded-lg border border-line bg-white px-1 text-sm"
              >
                {Array.from(new Set([...FREIGHT_CURRENCIES, ...currencies])).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          </Field>

          <Field label={t("Prisberegning", "Price calculation")} className="w-[250px]">
            <select
              value={shipment.markup_mode}
              onChange={(e) => onPatch({ markup_mode: e.target.value })}
              className="w-full rounded-lg border border-line bg-white px-2 py-1"
            >
              <option value="markup">{t("Påslag (kost × (1 + %))", "Markup (cost × (1 + %))")}</option>
              <option value="margin">{t("Margin (kost ÷ (1 − %))", "Margin (cost ÷ (1 − %))")}</option>
            </select>
          </Field>
          <Field label={shipment.markup_mode === "markup" ? t("Påslag %", "Markup %") : t("Margin %", "Margin %")} className="w-[90px]">
            <NumCell
              value={Math.round(Number(shipment.markup_value) * 1000) / 10}
              digits={1}
              className="border-line bg-white"
              onCommit={(n) => n !== null && onPatch({ markup_value: n / 100 })}
            />
          </Field>
          <Field label={t("Marginvarsel under %", "Margin warning below %")} className="w-[170px]">
            <NumCell
              value={Math.round(Number(shipment.margin_threshold) * 1000) / 10}
              digits={1}
              className="border-line bg-white"
              onCommit={(n) => n !== null && onPatch({ margin_threshold: n / 100 })}
            />
          </Field>
          <Field label={t("Emballasje drikke kr/stk", "Drink packaging NOK/pc")} className="w-[190px]">
            <NumCell value={Number(shipment.drink_packaging_nok)} className="border-line bg-white" onCommit={(n) => n !== null && onPatch({ drink_packaging_nok: n })} />
          </Field>
        </div>
      </section>
      <div className="grid gap-4 lg:grid-cols-[560px_minmax(0,1fr)]">
        <section className="rounded-2xl border border-line bg-cream-2 p-4">
          <h2 className="mb-3 text-sm font-extrabold uppercase tracking-wide text-mute">{t("Forsendelsen i tall", "Shipment in numbers")}</h2>
          <table className="w-full text-sm">
            <thead className="text-xs text-mute">
              <tr>
                <th></th>
                <th className="text-right">{t("Inkl. mva", "Incl. VAT")}</th>
                <th className="text-right">{t("Ekskl. mva", "Excl. VAT")}</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              <tr>
                <td>{t("Salgsverdi", "Sales value")}</td>
                <td className="text-right">{fmt(summary.salesInclVat, 0)}</td>
                <td className="text-right">{fmt(summary.salesExclVat, 0)}</td>
              </tr>
              <tr>
                <td>{t("Kost", "Cost")}</td>
                <td className="text-right">{fmt(summary.costInclVat, 0)}</td>
                <td className="text-right">{fmt(summary.costExclVat, 0)}</td>
              </tr>
              <tr className="border-t border-line font-bold">
                <td>{t("Fortjeneste", "Profit")}</td>
                <td className="text-right">{fmt(summary.profitInclVat, 0)}</td>
                <td className="text-right">{fmt(summary.profitExclVat, 0)}</td>
              </tr>
              <tr>
                <td>{t("Margin", "Margin")}</td>
                <td className="text-right">{fmtPct(summary.marginInclVat)}</td>
                <td className="text-right">{fmtPct(summary.marginExclVat)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-mute">
            {otherCostsNok > 0 && (
              <>
                {t("Inkluderer egne kostnader (toll-ekspedering, paller …): ", "Includes own costs (customs clearance, pallets …): ")}
                {fmt(otherCostsNok, 0)} kr.{" "}
              </>
            )}
            {summary.unpricedRows > 0 && (
              <span className="font-semibold text-amber">
                {t(`${summary.unpricedRows} varer er ikke med – mangler toll eller kurs.`, `${summary.unpricedRows} items are not included – missing duty or exchange rate.`)}
              </span>
            )}
          </p>
        </section>

        <section className="rounded-2xl border border-line bg-cream-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-extrabold uppercase tracking-wide text-mute">{t("Merknader", "Notes")}</h2>
            {warnCount > 0 && <Badge tone="yellow">{t(`${warnCount} advarsler`, `${warnCount} warnings`)}</Badge>}
            <Badge tone="gray">{t(`${invoices.length} fakturaer`, `${invoices.length} invoices`)}</Badge>
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              disabled={importOpen}
              className="ml-auto rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold hover:bg-orange/10 disabled:opacity-50"
            >
              {t("+ Legg til faktura", "+ Add invoice")}
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {warnings.map((w) => (
              <p key={w} className="rounded-lg border border-yellow-400 bg-yellow-50 px-3 py-1.5 text-sm text-yellow-900">
                ⚠ {m(w)}
              </p>
            ))}
            {invoices.length === 0 && warnings.length === 0 && <p className="text-xs text-mute">{t("Ingen merknader ennå. Importer en faktura for å komme i gang.", "No notes yet. Import an invoice to get started.")}</p>}
            {invoices.map((inv) => (
              <div key={inv.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-extrabold">
                    {t("Faktura", "Invoice")} {inv.invoice_no}
                  </h3>
                  <Badge tone="gray">{inv.currency}</Badge>
                  {inv.net_total !== null && (
                    <span className="text-xs text-mute">
                      {t("netto", "net")} {fmt(Number(inv.net_total))}
                    </span>
                  )}
                </div>
                <div className="mt-1 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                  {inv.control.map((c, i) => (
                    <p key={i} className={`rounded-lg border px-3 py-1.5 text-xs ${SEVERITY_STYLE[c.severity] ?? SEVERITY_STYLE.info}`}>
                      {m(c.text)}
                    </p>
                  ))}
                  {inv.warnings.map((w, i) => (
                    <p key={`w${i}`} className={`rounded-lg border px-3 py-1.5 text-xs ${SEVERITY_STYLE.warn}`}>
                      {m(w)}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <ImportForm
        open={importOpen}
        setOpen={setImportOpen}
        shipmentId={shipment.id}
        supplierName={shipment.supplier_name}
        hasInvoices={invoices.length > 0}
        onChangeSupplier={(label) => onPatch({ supplier_name: label })}
        onImported={onImported}
      />
    </div>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block flex-none ${className}`}>
      <span className="mb-0.5 block whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-[#6b6354]">{label}</span>
      {children}
    </label>
  );
}

const OTHER_LABEL = SUPPLIER_PROFILES.find((p) => p.id === "other")!.label;

function ImportForm({
  open,
  setOpen,
  shipmentId,
  supplierName,
  hasInvoices,
  onChangeSupplier,
  onImported,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  shipmentId: string;
  supplierName: string;
  hasInvoices: boolean;
  onChangeSupplier: (label: string) => void;
  onImported: (r: ImportOutcome) => void;
}) {
  const { t, m } = useTr();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [specFile, setSpecFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  /** Columns the operator picked by hand in this form; sent with the import and then remembered for the supplier. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [showColumns, setShowColumns] = useState(false);
  const profile = profileFor(supplierName);

  async function inspect(file: File, mapping: Record<string, string>) {
    const body = new FormData();
    body.set("spec", file);
    body.set("mapping", JSON.stringify(mapping));
    try {
      const res = await fetch(`/api/varemottak/shipments/${shipmentId}/import/inspect`, { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("Kunne ikke lese filen", "Could not read the file"));
      setInspection(data);
      setShowColumns((was) => was || data.missingRequired.length > 0);
      setError(null);
    } catch (err) {
      setInspection(null);
      setError((err as Error).message);
    }
  }

  function onSpecChange(file: File | null) {
    setSpecFile(file);
    setPicked({});
    setInspection(null);
    setShowColumns(false);
    // Stanro's file has a fixed layout; every other supplier's columns are checked before importing.
    if (file && profile.reader !== "stanro") void inspect(file, {});
  }

  function pickColumn(field: string, header: string) {
    const next = { ...picked, [field]: header };
    setPicked(next);
    if (specFile) void inspect(specFile, next);
  }
  const known = SUPPLIER_PROFILES.some((p) => p.id !== "other" && p.label === supplierName);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/varemottak/shipments/${shipmentId}/import`, { method: "POST", body: new FormData(e.currentTarget) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("Importen feilet", "The import failed"));
      onImported(data);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-line bg-cream-2 p-4">
      {/* 1. The supplier comes first: it decides how the files are read. */}
      <div className="grid gap-3 sm:grid-cols-[260px_1fr] sm:items-start">
        <label className="block text-sm">
          <span className="font-semibold">{t("1. Leverandør", "1. Supplier")}</span>
          <select
            value={known ? supplierName : "__other"}
            disabled={hasInvoices}
            onChange={(e) => onChangeSupplier(e.target.value === "__other" ? OTHER_LABEL : e.target.value)}
            className="mt-1 block w-full rounded-lg border border-line bg-white px-2 py-1.5 disabled:opacity-60"
            title={hasInvoices ? t("Leverandøren kan ikke endres etter at en faktura er importert", "The supplier cannot be changed after an invoice has been imported") : undefined}
          >
            {SUPPLIER_PROFILES.filter((p) => p.id !== "other").map((p) => (
              <option key={p.id} value={p.label}>
                {p.label}
              </option>
            ))}
            <option value="__other">{t("Annen leverandør", "Other supplier")} …</option>
          </select>
        </label>
        <div className="rounded-lg border border-line bg-white px-3 py-2 text-xs text-ink/80">
          <p className="font-bold">{t(`Slik leses filene fra ${profile.label}`, `How files from ${profile.label} are read`)}</p>
          <p className="mt-0.5">
            <b>{t("Spesifikasjon:", "Specification:")}</b> {m(profile.accepts.spec)}
          </p>
          <p>
            <b>PDF:</b> {profile.accepts.pdf != null ? m(profile.accepts.pdf) : t("ikke brukt – denne leverandøren sender ingen PDF", "not used – this supplier does not send a PDF")}
          </p>
          <p>
            <b>{t("Valuta:", "Currency:")}</b> {profile.currency ?? t("oppgis under", "enter below")}
          </p>
          {profile.note && <p className="mt-0.5 text-amber">{m(profile.note)}</p>}
        </div>
      </div>

      {/* 2. Then only the upload fields that supplier uses. */}
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto_auto] sm:items-end">
        <label className="block text-sm">
          <span className="font-semibold">
            {t("2. Spesifikasjon (CSV / Excel)", "2. Specification (CSV / Excel)")}
            {profile.reader === "stanro" ? "" : profile.id === "other" ? t(" – eller bare PDF", " – or PDF only") : ""}
          </span>
          <input
            name="spec"
            type="file"
            accept=".csv,.xlsx,.xls,.txt"
            required={profile.reader === "stanro" || (profile.id !== "other" && profile.accepts.pdf === null)}
            onChange={(e) => onSpecChange(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm"
          />
        </label>
        {profile.accepts.pdf !== null ? (
          <label className="block text-sm">
            <span className="font-semibold">
              {t("Faktura (PDF)", "Invoice (PDF)")}
              {profile.id === "other" ? t(" – leses med AI hvis du ikke har spesifikasjon", " – read with AI if you have no specification") : ""}
            </span>
            <input name="pdf" type="file" accept=".pdf" className="mt-1 block w-full text-sm" />
          </label>
        ) : (
          <span className="text-xs text-mute">{t("Ingen PDF for denne leverandøren", "No PDF for this supplier")}</span>
        )}
        {profile.reader !== "stanro" ? (
          <label className="block text-sm">
            <span className="font-semibold">
              {t("Fakturanr.", "Invoice no.")} <span className="font-normal text-mute">{t("(hvis ikke i filen)", "(if not in the file)")}</span>
            </span>
            <input name="invoiceNo" placeholder={t("f.eks. 2026/0412", "e.g. 2026/0412")} className="mt-1 block w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm" />
          </label>
        ) : (
          <span />
        )}
        {profile.currency ? (
          <span className="text-xs text-mute">{t("Valuta:", "Currency:")} {profile.currency}</span>
        ) : (
          <label className="block text-sm">
            <span className="font-semibold">{t("Valuta", "Currency")}</span>
            <select name="currency" defaultValue="EUR" className="mt-1 block rounded-lg border border-line bg-white px-2 py-1.5">
              {["EUR", "PLN", "USD", "SEK", "DKK", "NOK"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        )}
        <div className="flex gap-2">
          <button disabled={busy} className="rounded-lg bg-orange px-4 py-2 text-sm font-bold text-cream hover:opacity-90 disabled:opacity-50">
            {busy ? t("Importerer …", "Importing …") : t("Importer", "Import")}
          </button>
          {hasInvoices && (
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-line px-3 py-2 text-sm">
              {t("Avbryt", "Cancel")}
            </button>
          )}
        </div>
      </div>
      {inspection && (
        <ColumnMapping inspection={inspection} picked={picked} open={showColumns} onToggle={() => setShowColumns((v) => !v)} onPick={pickColumn} />
      )}
      <input type="hidden" name="mapping" value={JSON.stringify(picked)} />
      {error && <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{m(error)}</p>}
    </form>
  );
}

interface Inspection {
  headers: string[];
  found: Record<string, string>;
  missingRequired: string[];
  sample: string[][];
  rows: number;
}

/** Which column of the file is which. Opens by itself when a required column was not recognised. */
function ColumnMapping({
  inspection,
  picked,
  open,
  onToggle,
  onPick,
}: {
  inspection: Inspection;
  picked: Record<string, string>;
  open: boolean;
  onToggle: () => void;
  onPick: (field: string, header: string) => void;
}) {
  const { t, m } = useTr();
  const missing = inspection.missingRequired;
  const headers = Array.from(new Set(inspection.headers.filter(Boolean)));
  return (
    <div className="rounded-lg border border-line bg-white p-3 text-sm" data-testid="column-mapping">
      <div className="flex flex-wrap items-center gap-2">
        <b>{t("Kolonner i filen", "Columns in the file")}</b>
        <span className="text-xs text-mute">{t(`${inspection.rows} rader`, `${inspection.rows} rows`)}</span>
        {missing.length > 0 ? (
          <Badge tone="red">{t("Mangler:", "Missing:")} {missing.map((f) => m(FIELD_LABELS[f as Field])).join(", ")}</Badge>
        ) : (
          <Badge tone="green">{t("Alle nødvendige kolonner funnet", "All required columns found")}</Badge>
        )}
        <button type="button" onClick={onToggle} className="ml-auto text-xs font-semibold text-orange underline">
          {open ? t("Skjul", "Hide") : t("Endre kolonner", "Change columns")}
        </button>
      </div>
      {open && (
        <>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {(Object.keys(FIELD_LABELS) as Field[]).map((f) => (
              <label key={f} className="block text-xs">
                <span className="font-semibold">
                  {m(FIELD_LABELS[f])}
                  {REQUIRED_FIELDS.includes(f) ? " *" : ""}
                </span>
                <select
                  value={picked[f] ?? inspection.found[f] ?? NO_COLUMN}
                  onChange={(e) => onPick(f, e.target.value)}
                  className={`mt-0.5 block w-full rounded border bg-white px-1.5 py-1 ${REQUIRED_FIELDS.includes(f) && !(picked[f] ?? inspection.found[f]) ? "border-red-400" : "border-line"}`}
                >
                  <option value={NO_COLUMN}>{t("(ingen kolonne)", "(no column)")}</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {inspection.sample.length > 0 && (
            <div className="mt-2 overflow-x-auto">
              <table className="text-[11px]">
                <thead>
                  <tr>
                    {inspection.headers.map((h, i) => (
                      <th key={i} className="whitespace-nowrap border-b border-line px-2 py-1 text-left font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {inspection.sample.map((r, i) => (
                    <tr key={i}>
                      {inspection.headers.map((_, j) => (
                        <td key={j} className="whitespace-nowrap border-b border-line/50 px-2 py-0.5">
                          {r[j] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-1 text-xs text-mute">
            {t(
              "Valget huskes for denne leverandøren, så neste fil leses uten at du må gjøre dette igjen.",
              "Your choice is remembered for this supplier, so the next file is read without you having to do this again.",
            )}
          </p>
        </>
      )}
    </div>
  );
}

/** Shown once after an import: what to look at before pricing. */
export function ImportSummaryCard({ result, onClose }: { result: ImportOutcome; onClose: () => void }) {
  const { t, lang } = useTr();
  return (
    <section className="rounded-2xl border-2 border-orange/40 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-extrabold">{t(`Import av ${result.invoiceNo}`, `Import of ${result.invoiceNo}`)}</h3>
        <button onClick={onClose} className="text-mute hover:text-ink" aria-label={t("Lukk", "Close")}>
          ✕
        </button>
      </div>
      <p className="mt-1 text-sm">
        {lang === "en" ? (
          <>
            {result.rawLines} lines → {result.products} items. <b>{result.matched}</b> matched, <b className="text-amber">{result.doubtful}</b> uncertain, <b className="text-red-700">{result.unmatched}</b> unmatched.
          </>
        ) : (
          <>
            {result.rawLines} linjer → {result.products} varer. <b>{result.matched}</b> koblet, <b className="text-amber">{result.doubtful}</b> usikre, <b className="text-red-700">{result.unmatched}</b> uten kobling.
          </>
        )}
      </p>
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <h4 className="text-xs font-bold uppercase text-mute">{t("Innkjøpspris", "Purchase price")}</h4>
          <p>
            <span className="font-bold text-red-700">{result.summary.up} {t("opp", "up")}</span> · <span className="font-bold text-green-700">{result.summary.down} {t("ned", "down")}</span> · {result.summary.new} {t("nye", "new")}
          </p>
          {result.summary.raisedWithoutPriceChange > 0 && (
            <p className="text-xs text-amber">
              {t(
                `${result.summary.raisedWithoutPriceChange} hevet pris uten at vår pris er endret`,
                `${result.summary.raisedWithoutPriceChange} with a raised price but no change to our price`,
              )}
            </p>
          )}
        </div>
        <div>
          <h4 className="text-xs font-bold uppercase text-mute">{t("Største økninger", "Largest increases")}</h4>
          {result.summary.largestIncreases.length ? (
            <ul className="text-xs">
              {result.summary.largestIncreases.map((r) => (
                <li key={r.idx} className="truncate">
                  +{(r.changePct * 100).toFixed(0)} % · {r.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-mute">{t("Ingen.", "None.")}</p>
          )}
        </div>
        <div>
          <h4 className="text-xs font-bold uppercase text-mute">{t("Under marginvarsel", "Below margin warning")}</h4>
          {result.summary.belowMargin.length ? (
            <ul className="text-xs">
              {result.summary.belowMargin.slice(0, 5).map((r) => (
                <li key={r.idx} className="truncate">
                  {(r.margin * 100).toFixed(1)} % · {r.name}
                </li>
              ))}
              {result.summary.belowMargin.length > 5 && (
                <li className="text-mute">{t(`… og ${result.summary.belowMargin.length - 5} til`, `… and ${result.summary.belowMargin.length - 5} more`)}</li>
              )}
            </ul>
          ) : (
            <p className="text-xs text-mute">{t("Ingen (toll mangler kanskje ennå).", "None (duty may still be missing).")}</p>
          )}
        </div>
      </div>
    </section>
  );
}
