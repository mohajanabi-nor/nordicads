"use client";

import type { BaselineStatus } from "@/lib/types";

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

export default function BaselineCard({
  status,
  loading,
}: {
  status: BaselineStatus | null;
  loading: boolean;
}) {
  const missing = status ? status.baseline.is_first_run || !status.baseline.last_run : false;

  return (
    <section className="rounded-2xl border border-line bg-cream-2 p-6 shadow-sm">
      <h2 className="text-lg font-extrabold text-ink">Baseline-status</h2>

      {loading && <p className="mt-3 text-sm text-mute">Laster…</p>}

      {status && (
        <div className="mt-3 space-y-3 text-sm">
          {missing ? (
            <div className="rounded-xl border border-amber/40 bg-amber/10 p-3 text-ink">
              <p className="font-bold">Ingen baseline</p>
              <p className="mt-0.5 text-ink/80">
                Restock oppdages ikke før du har kjørt en full generering.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-orange/25 bg-orange/5 p-3">
              <p className="font-bold text-ink">
                Baseline lagret · run {status.baseline.last_run!.id}
              </p>
              <p className="mt-0.5 text-ink/70">
                {fmtDate(status.baseline.last_run!.ts)} ·{" "}
                {status.baseline.last_run!.item_count.toLocaleString("no-NO")} varer
              </p>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <dt className="text-mute">Butikk</dt>
              <dd className="font-semibold text-ink">{status.store_domain}</dd>
            </div>
            <div>
              <dt className="text-mute">Nyhet / restock vindu</dt>
              <dd className="font-semibold text-ink">
                {status.config.new_window_days}d / {status.config.restock_window_days}d
              </dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
