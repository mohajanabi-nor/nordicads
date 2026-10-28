"use client";

/**
 * Upload the forwarder's customs declaration (PDF). The app reads it, checks that it adds up, puts the declared duty and
 * packaging fees on the matching rows, records the rates, and shows how cost and margin moved.
 */
import { useState } from "react";
import type { DeclarationOutcome } from "@/lib/varemottak/declaration-service";
import { Badge, fmt, fmtPct } from "./cells";
import { useTr } from "./useTr";

export default function DeclarationPdfCard({ onDone }: { onDone?: () => void }) {
  const { t, m } = useTr();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<DeclarationOutcome | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      const res = await fetch("/api/varemottak/declaration", { method: "POST", body: new FormData(e.currentTarget) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("Importen feilet", "The import failed"));
      setOut(data);
      if (data.ok) onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const report = out && out.ok ? out.report : null;

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-cream-2 p-4" data-testid="declaration-pdf">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <h2 className="font-extrabold">{t("Les inn tolldeklarasjon (PDF)", "Read in a customs declaration (PDF)")}</h2>
          <p className="max-w-3xl text-xs text-mute">
            {t(
              "Appen leser deklarasjonen fra speditøren, kontrollerer at den går opp, og legger deklarert toll og emballasjeavgift på varene i forsendelsen den hører til (koblet på varenummer). Satsene lagres i registeret, og du får se hva som ble endret i kost og margin. Går ikke kontrollen opp, lagres ingenting.",
              "The app reads the forwarder's declaration, checks that it adds up, and puts the declared duty and packaging fees on the items of the shipment it belongs to (matched on article number). The rates are saved in the register and you see what changed in cost and margin. If the check does not add up, nothing is saved.",
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="font-semibold">{t("Deklarasjon (PDF)", "Declaration (PDF)")}</span>
            <input name="file" type="file" accept=".pdf,application/pdf" required className="mt-1 block text-sm" />
          </label>
          <button disabled={busy} className="rounded-lg bg-orange px-4 py-2 text-sm font-bold text-cream hover:opacity-90 disabled:opacity-50">
            {busy ? t("Leser …", "Reading …") : t("Les inn", "Read in")}
          </button>
        </div>
      </form>

      {error && <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{m(error)}</p>}

      {out && !out.ok && (
        <div className="rounded-lg border-2 border-red-300 bg-red-50 p-3 text-sm text-red-900" data-testid="declaration-failed">
          <b>{t("Kontrollen gikk ikke opp – ingenting er lagret.", "The check did not add up – nothing was saved.")}</b>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {out.checks.map((c) => (
              <li key={c.code} className={c.ok ? "text-green-800" : "font-semibold"}>
                {c.ok ? "✓" : "✗"} {m(c.text)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report && out && out.ok && (
        <div className="space-y-3 rounded-lg border border-line bg-white p-3 text-sm" data-testid="declaration-result">
          <p>
            <b>{t(`Deklarasjon ${report.number}`, `Declaration ${report.number}`)}</b>{" "}
            <Badge tone={report.status === "final" ? "green" : "yellow"}>{report.status === "final" ? t("endelig", "final") : t("utkast", "draft")}</Badge>
            {report.date ? ` · ${report.date}` : ""} ·{" "}
            {t(`${report.matchedItems} av ${report.itemCount} poster koblet til varer`, `${report.matchedItems} of ${report.itemCount} items tied to products`)} ·{" "}
            {t(`${report.ratesAdded.cn8} CN8-satser og ${report.ratesAdded.product} varesatser lagret`, `${report.ratesAdded.cn8} CN8 rates and ${report.ratesAdded.product} product rates saved`)}
            {report.replacedDraft ? ` · ${t("erstattet utkastet", "replaced the draft")}` : ""}
          </p>
          <ul className="list-disc pl-5 text-xs text-ink/80">
            {out.checks.map((c) => (
              <li key={c.code}>{m(c.text)}</li>
            ))}
          </ul>

          {report.rateDifferences.map((d, i) => (
            <p key={i} className="rounded-lg border border-yellow-400 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
              {t(
                `${d.shipmentName}: kursen ${d.currency} er ${fmt(d.shipmentRate, 3)}, men deklarasjonen bruker ${fmt(d.declarationRate, 3)}. Ikke endret – endre kursen i innstillingene hvis deklarasjonens kurs skal gjelde.`,
                `${d.shipmentName}: the ${d.currency} rate is ${fmt(d.shipmentRate, 3)} but the declaration uses ${fmt(d.declarationRate, 3)}. Not changed – change the rate in the settings if the declaration's rate should apply.`,
              )}
            </p>
          ))}

          {report.decisions.length > 0 && (
            <details className="rounded-lg border border-yellow-400 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
              <summary className="cursor-pointer font-bold">
                {t(`${report.decisions.length} pølser har 0 i toll i deklarasjonen – sjekk`, `${report.decisions.length} sausages have 0 duty on the declaration – check`)}
              </summary>
              <p className="mt-1">
                {t(
                  "Satsen er lagt på slik den er deklarert (tollkvote), men samme pølse har hatt 84,31 kr/kg på andre deklarasjoner. Se på hver, og skriv inn 84,31 på raden hvis du vil regne med den høyere tollen.",
                  "The rate was applied as declared (tariff quota), but the same sausage has had 84.31 kr/kg on other declarations. Look at each one, and type 84.31 on the row if you want to count the higher duty.",
                )}
              </p>
              <ul className="mt-1 max-h-32 list-disc overflow-auto pl-5">
                {report.decisions.map((d) => (
                  <li key={d.lineId}>
                    {d.idx} · {d.name}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {report.unmatchedItems.length > 0 && (
            <details className="rounded-lg border border-line bg-cream-2 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-bold">
                {t(`${report.unmatchedItems.length} poster fantes ikke på noen åpen forsendelse`, `${report.unmatchedItems.length} items were not on any open shipment`)}
              </summary>
              <p className="mt-1 text-mute">
                {t("CN8-satsene deres er lagret i registeret og brukes neste gang.", "Their CN8 rates are saved in the register and are used next time.")}
              </p>
              <ul className="mt-1 max-h-32 list-disc overflow-auto pl-5">
                {report.unmatchedItems.map((u) => (
                  <li key={u.varepost}>
                    {u.articleNo || "–"} · {u.name} ({u.cn8})
                  </li>
                ))}
              </ul>
            </details>
          )}

          {report.changes.length > 0 && (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white text-left text-mute">
                  <tr>
                    <th className="py-1">{t("Vare", "Item")}</th>
                    <th className="text-right">{t("Toll kr/kg", "Duty NOK/kg")}</th>
                    <th className="text-right">{t("Emb./stk", "Pack./pc")}</th>
                    <th className="text-right">{t("Kost inkl. mva", "Cost incl. VAT")}</th>
                    <th className="text-right">{t("Margin", "Margin")}</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {report.changes.map((c) => (
                    <tr key={c.lineId} className="border-t border-line">
                      <td className="py-1">
                        <div className="font-semibold">{c.name}</div>
                        <div className="text-mute">
                          {c.shipmentName} · {c.idx} {c.pushed && <Badge tone="yellow">{t("sendt – send på nytt", "sent – resend")}</Badge>}{" "}
                          {c.alert && <Badge tone="red">{t(`prisvarsel: ${c.alert}`, `price alert: ${c.alert.replace("kost", "cost").replace("leverandør", "supplier")}`)}</Badge>}
                        </div>
                      </td>
                      <td className="text-right">
                        {c.dutyBefore === null ? "–" : fmt(c.dutyBefore)} → <b>{fmt(c.dutyAfter)}</b>
                      </td>
                      <td className="text-right">
                        {fmt(c.packagingBefore)} → <b>{fmt(c.packagingAfter)}</b>
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
        </div>
      )}
    </section>
  );
}
