"use client";

import { useState } from "react";
import type { DropSummary } from "@/lib/types";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("no-NO", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Pretty reel name: strip slug prefix + extension. */
function reelLabel(file: string): string {
  return file
    .replace(/\.mp4$/i, "")
    .replace(/^[a-z0-9]+-\d{4}_/i, "")
    .replace(/^reel_/, "")
    .replace(/[-_]/g, " ")
    .trim();
}

function assetUrl(dir: string, file: string) {
  return `/api/drops/${encodeURIComponent(dir)}/${encodeURIComponent(file)}`;
}

export default function DropCard({
  drop,
  defaultOpen = false,
}: {
  drop: DropSummary;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [active, setActive] = useState<string | null>(drop.reels[0] ?? null);

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-cream-2 shadow-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <div>
          <h3 className="font-extrabold text-ink">{drop.dir}</h3>
          <p className="mt-0.5 text-xs text-mute">
            {fmtDate(drop.createdAt)} · {drop.pdf ? "1 PDF" : "ingen PDF"} ·{" "}
            {drop.reels.length} reels
          </p>
        </div>
        <span className="text-mute">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="border-t border-line px-5 py-5">
          <div className="grid gap-5 md:grid-cols-[300px_1fr]">
            {/* player */}
            <div>
              {active ? (
                <video
                  key={active}
                  src={assetUrl(drop.dir, active)}
                  controls
                  playsInline
                  className="aspect-[9/16] w-full rounded-xl bg-black object-contain"
                />
              ) : (
                <div className="grid aspect-[9/16] w-full place-items-center rounded-xl bg-ink/5 text-sm text-mute">
                  Ingen reel
                </div>
              )}
            </div>

            {/* assets */}
            <div className="space-y-4">
              {drop.pdf && (
                <div className="flex items-center justify-between rounded-xl border border-line bg-cream px-4 py-3">
                  <span className="text-sm font-semibold text-ink">📄 {drop.pdf}</span>
                  <span className="flex gap-3 text-sm">
                    <a href={assetUrl(drop.dir, drop.pdf)} target="_blank" rel="noreferrer" className="font-semibold text-orange underline">
                      Åpne
                    </a>
                    <a href={assetUrl(drop.dir, drop.pdf)} download className="font-semibold text-ink/70 underline">
                      Last ned
                    </a>
                  </span>
                </div>
              )}

              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wide text-mute">
                  Reels ({drop.reels.length})
                </p>
                <ul className="grid gap-1.5 sm:grid-cols-2">
                  {drop.reels.map((file) => (
                    <li key={file}>
                      <button
                        onClick={() => setActive(file)}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                          active === file
                            ? "bg-orange/15 font-semibold text-ink"
                            : "hover:bg-orange/10 text-ink/80"
                        }`}
                      >
                        <span className="truncate capitalize">
                          {file.includes("montage") ? "▶ Montage" : reelLabel(file)}
                        </span>
                        <a
                          href={assetUrl(drop.dir, file)}
                          download
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 text-xs text-mute underline"
                        >
                          ↓
                        </a>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
