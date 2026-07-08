"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import GeneratePanel from "@/components/GeneratePanel";
import BaselineCard from "@/components/BaselineCard";
import DropCard from "@/components/DropCard";
import type { BaselineStatus, DropSummary } from "@/lib/types";

export default function Home() {
  const [status, setStatus] = useState<BaselineStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [drops, setDrops] = useState<DropSummary[]>([]);

  const refresh = useCallback(async () => {
    setStatusLoading(true);
    try {
      const [s, d] = await Promise.all([
        fetch("/api/status").then((r) => r.json()),
        fetch("/api/drops").then((r) => r.json()),
      ]);
      if (!s.error) setStatus(s);
      setDrops(d.drops ?? []);
    } catch {
      /* surfaced via empty state */
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Dashboard</h1>
          <p className="mt-1 text-sm text-mute">
            Trigg en drop, følg framdrift og åpne ferdige filer.
          </p>
        </div>
        <Link
          href="/picker"
          className="rounded-xl border border-orange bg-cream-2 px-4 py-2.5 text-sm font-bold text-orange shadow-sm transition hover:bg-orange hover:text-cream"
        >
          Velg produkter selv →
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <GeneratePanel onComplete={refresh} />
        <BaselineCard status={status} loading={statusLoading} />
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-ink">Siste drops</h2>
          <Link href="/drops" className="text-sm font-semibold text-orange underline">
            Se alle →
          </Link>
        </div>
        {drops.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line bg-cream-2 p-8 text-center text-sm text-mute">
            Ingen drops ennå. Trykk «Generer drop» for å lage den første.
          </p>
        ) : (
          <div className="space-y-3">
            {drops.slice(0, 5).map((d) => (
              <DropCard key={d.dir} drop={d} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
