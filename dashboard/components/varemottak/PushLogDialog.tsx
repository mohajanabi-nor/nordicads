"use client";

/**
 * What was sent to Shopify, when, and by whom — with the values it replaced, so a
 * mistaken push can be undone by hand.
 */
import { useEffect, useState } from "react";
import type { LineRow } from "@/lib/varemottak/lines";
import { Badge } from "./cells";
import { useTr } from "./useTr";

interface Entry {
  id: number;
  at: string;
  line_id: string | null;
  product_id: string | null;
  by_user: string | null;
  mode: "fake" | "live" | "dry-run";
  request: { productType: string; casePrice: string; unitCost: string; activate: boolean } | null;
  previous: { productType: string; variantPrice: number | null; unitCost: number | null; status: string } | null;
  result: { ok: boolean; userErrors: Array<{ message: string }> } | null;
}

const when = (iso: string) => new Date(iso).toLocaleString("nb-NO", { dateStyle: "short", timeStyle: "short" });
/** Prices as 28 or 28,5, case prices and costs with øre — numbers and numeric strings alike. */
const num = (n: number | string | null | undefined) => {
  if (n === null || n === undefined || n === "") return "–";
  const v = Number(String(n).replace(",", "."));
  if (!Number.isFinite(v)) return String(n);
  return v.toLocaleString("nb-NO", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
};

export default function PushLogDialog({ shipmentId, lines, onClose }: { shipmentId: string; lines: LineRow[]; onClose: () => void }) {
  const { t, m } = useTr();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/varemottak/shipments/${shipmentId}/push`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setEntries(data);
      })
      .catch((err) => setError(err.message));
  }, [shipmentId]);

  const lineOf = new Map(lines.map((l) => [l.id, l]));

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-line bg-cream-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line p-4">
          <div>
            <h2 className="text-lg font-extrabold">{t("Sendelogg", "Send log")}</h2>
            <p className="text-xs text-mute">
              {t("Hva som ble sendt, når, av hvilken konto – og hva det erstattet.", "What was sent, when, by which account – and what it replaced.")}
            </p>
          </div>
          <button onClick={onClose} className="rounded px-2 py-1 text-mute hover:bg-black/5" aria-label={t("Lukk", "Close")}>
            ✕
          </button>
        </div>
        <div className="max-h-[72vh] overflow-auto">
          {error && <p className="p-4 text-sm text-red-700">{m(error)}</p>}
          {!entries && !error && <p className="p-4 text-sm text-mute">{t("Henter …", "Loading …")}</p>}
          {entries && !entries.length && <p className="p-6 text-center text-sm text-mute">{t("Ingenting er sendt ennå.", "Nothing has been sent yet.")}</p>}
          {entries && entries.length > 0 && (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-cream-2 text-left uppercase tracking-wide text-mute">
                <tr>
                  <th className="px-3 py-2">{t("Tid", "Time")}</th>
                  <th className="px-3 py-2">{t("Konto", "Account")}</th>
                  <th className="px-3 py-2">{t("Vare", "Item")}</th>
                  <th className="px-3 py-2 text-right">{t("Stk-pris", "Unit price")}</th>
                  <th className="px-3 py-2 text-right">{t("Kartongpris", "Carton price")}</th>
                  <th className="px-3 py-2 text-right">{t("Kost", "Cost")}</th>
                  <th className="px-3 py-2">{t("Resultat", "Result")}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {entries.map((e) => {
                  const l = e.line_id ? lineOf.get(e.line_id) : undefined;
                  return (
                    <tr key={e.id} className="border-t border-line align-top">
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {when(e.at)} <Badge tone={e.mode === "live" ? "red" : "green"}>{e.mode === "live" ? t("ekte", "live") : t("test", "test")}</Badge>
                      </td>
                      <td className="px-3 py-1.5">{e.by_user ?? t("ukjent", "unknown")}</td>
                      <td className="max-w-[260px] px-3 py-1.5">
                        <div className="truncate font-semibold" title={l?.shopify?.title}>
                          {l?.shopify?.title ?? e.product_id}
                        </div>
                        <div className="font-mono text-mute">{l?.idx}</div>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {num(e.previous?.productType)} → <b>{num(e.request?.productType)}</b>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {num(e.previous?.variantPrice)} → <b>{num(e.request?.casePrice)}</b>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {num(e.previous?.unitCost)} → <b>{num(e.request?.unitCost)}</b>
                      </td>
                      <td className="px-3 py-1.5">
                        {e.result?.ok ? (
                          <Badge tone="green">OK{e.request?.activate ? t(" · aktivert", " · activated") : ""}</Badge>
                        ) : (
                          <Badge tone="red">{e.result?.userErrors?.[0]?.message ? m(e.result.userErrors[0].message) : t("feilet", "failed")}</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
