"use client";

import { useCallback, useEffect, useState } from "react";
import CampaignComposer from "@/components/CampaignComposer";
import ContactList from "@/components/ContactList";
import { useLang } from "@/lib/i18n";
import type { CampaignSummaryView } from "@/lib/types";

function fmtDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function EpostPage() {
  const { t, locale } = useLang();
  const [selected, setSelected] = useState<string[]>([]);
  const [dryRun, setDryRun] = useState(false);
  const [history, setHistory] = useState<CampaignSummaryView[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/campaign");
      const data = await res.json();
      setDryRun(Boolean(data.dryRun));
      setHistory(data.campaigns ?? []);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory, reloadKey]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-ink">E-post</h1>
        <p className="mt-1 text-sm text-mute">
          {t(
            "Kampanjer til kundelisten, med katalogen som vedlegg. Listen bygges ved å importere kundeeksporten fra Shopify — kjente e-poster hoppes over, så en avmelding kan aldri bli abonnent igjen ved neste import.",
            "Campaigns to the customer list, with the catalogue attached. The list is built by importing the customer export from Shopify — known emails are skipped, so an unsubscribe can never become a subscriber again on the next import.",
          )}
        </p>
      </div>

      <CampaignComposer
        recipients={selected}
        dryRun={dryRun}
        onSent={() => setReloadKey((k) => k + 1)}
      />

      <ContactList onSelectionChange={setSelected} />

      {history.length > 0 && (
        <section className="rounded-2xl border border-line bg-cream-2 p-6 shadow-sm">
          <h2 className="text-lg font-extrabold text-ink">{t("Tidligere kampanjer", "Previous campaigns")}</h2>
          <ul className="mt-3 space-y-2">
            {history.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-cream px-4 py-3 text-sm"
              >
                <div>
                  <p className="font-semibold text-ink">
                    {c.subject}
                    {c.dryRun && <span className="ml-2 text-[11px] text-mute">{t("(testmodus)", "(test mode)")}</span>}
                  </p>
                  <p className="text-xs text-mute">
                    {fmtDate(c.createdAt, locale)} · {c.sent} {t("sendt", "sent")}
                    {c.failed > 0 && ` · ${c.failed} ${t("feilet", "failed")}`}
                    {c.skipped > 0 && ` · ${c.skipped} ${t("hoppet over", "skipped")}`} {t("av", "of")} {c.total}
                    {c.attachmentName && ` · ${t("med vedlegg", "with attachment")}`}
                  </p>
                </div>
                {c.remaining > 0 && (
                  <button
                    onClick={async () => {
                      await fetch(`/api/campaign/${c.id}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "resume" }),
                      });
                      setReloadKey((k) => k + 1);
                    }}
                    className="rounded-lg border border-orange bg-cream-2 px-3 py-1.5 text-sm font-bold text-orange transition hover:bg-orange hover:text-cream"
                  >
                    {t("Fortsett", "Resume")} — {c.remaining} {t("gjenstår", "remaining")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
