"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import DropCard from "@/components/DropCard";
import type { DropSummary } from "@/lib/types";

function DropsLibrary() {
  const params = useSearchParams();
  const openDir = params.get("open");
  const [drops, setDrops] = useState<DropSummary[] | null>(null);

  useEffect(() => {
    fetch("/api/drops")
      .then((r) => r.json())
      .then((d) => setDrops(d.drops ?? []))
      .catch(() => setDrops([]));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-ink">Drops</h1>
        <p className="mt-1 text-sm text-mute">
          Alle genererte drops — spill av reels, åpne og last ned filer.
        </p>
      </div>

      {drops === null ? (
        <p className="text-sm text-mute">Laster…</p>
      ) : drops.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line bg-cream-2 p-8 text-center text-sm text-mute">
          Ingen drops ennå.
        </p>
      ) : (
        <div className="space-y-3">
          {drops.map((d) => (
            <DropCard key={d.dir} drop={d} defaultOpen={d.dir === openDir} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function DropsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-mute">Laster…</p>}>
      <DropsLibrary />
    </Suspense>
  );
}
