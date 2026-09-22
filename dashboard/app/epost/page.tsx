"use client";

import { useCallback, useEffect, useState } from "react";
import CampaignComposer from "@/components/CampaignComposer";
import ContactList from "@/components/ContactList";
import type { CampaignSummaryView } from "@/lib/types";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("no-NO", {
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
          Kampanjer til kundelisten, med katalogen som vedlegg. Listen bygges ved å importere
          kundeeksporten fra Shopify — kjente e-poster hoppes over, så en avmelding kan aldri bli
          abonnent igjen ved neste import.
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
          <h2 className="text-lg font-extrabold text-ink">Tidligere kampanjer</h2>
          <ul className="mt-3 space-y-2">
            {history.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-cream px-4 py-3 text-sm"
              >
                <div>
                  <p className="font-semibold text-ink">
                    {c.subject}
                    {c.dryRun && <span className="ml-2 text-[11px] text-mute">(testmodus)</span>}
                  </p>
                  <p className="text-xs text-mute">
                    {fmtDate(c.createdAt)} · {c.sent} sendt
                    {c.failed > 0 && ` · ${c.failed} feilet`}
                    {c.skipped > 0 && ` · ${c.skipped} hoppet over`} av {c.total}
                    {c.attachmentName && " · med vedlegg"}
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
                    Fortsett — {c.remaining} gjenstår
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
