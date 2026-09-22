"use client";

import { useCallback, useEffect, useState } from "react";
import type { LogEntryView, LogsResponse } from "@/lib/types";

const PAGE_SIZE = 50;

const LEVELS = [
  { key: "alle", label: "Alle" },
  { key: "error", label: "Kun feil" },
  { key: "warn", label: "Advarsler" },
  { key: "info", label: "Info" },
];

const SOURCES = [
  { key: "alle", label: "Alt" },
  { key: "sync", label: "Synk" },
  { key: "campaign", label: "Kampanjer" },
  { key: "contacts", label: "Kontakter" },
  { key: "scheduler", label: "Planlegger" },
  { key: "config", label: "Oppsett" },
];

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("no-NO", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function levelStyle(level: string): string {
  if (level === "error") return "border-red-300 bg-red-50 text-red-700";
  if (level === "warn") return "border-amber/40 bg-amber/10 text-ink";
  return "border-line bg-cream text-ink/80";
}

export default function LoggPage() {
  const [entries, setEntries] = useState<LogEntryView[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [level, setLevel] = useState("alle");
  const [source, setSource] = useState("alle");
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        level,
        source,
        q,
        // Opening the tab is what clears the nav badge.
        markSeen: "1",
      });
      const res = await fetch(`/api/logs?${qs}`);
      const data: LogsResponse & { error?: string } = await res.json();
      if (data.error) throw new Error(data.error);
      setEntries(data.entries ?? []);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [page, level, source, q]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-ink">Logg</h1>
        <p className="mt-1 text-sm text-mute">
          Alt verktøyet gjør på egen hånd — automatiske synker, avmeldinger og utsendinger — havner
          her. Er noe galt, står det her først.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-cream-2 p-4">
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Søk i loggen…"
          className="w-64 rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-orange"
        />
        <div className="flex flex-wrap items-center gap-1">
          {LEVELS.map((l) => (
            <button
              key={l.key}
              onClick={() => {
                setLevel(l.key);
                setPage(1);
              }}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                level === l.key ? "bg-orange text-cream" : "bg-cream text-ink/70 hover:bg-line/40"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
        <select
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-line bg-cream px-2 py-2 text-sm text-ink outline-none focus:border-orange"
        >
          {SOURCES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          onClick={load}
          className="rounded-lg bg-cream px-3 py-1.5 text-sm font-semibold text-ink/80 hover:bg-line/40"
        >
          ↻ Oppdater
        </button>
        <span className="text-sm text-mute">{total.toLocaleString("no-NO")} hendelser</span>
      </div>

      {loading && entries.length === 0 ? (
        <p className="text-sm text-mute">Laster…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line bg-cream-2 p-8 text-center text-sm text-mute">
          Ingenting i loggen ennå.
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e, i) => {
            const open = expanded.has(i);
            const hasData = e.data && Object.keys(e.data).length > 0;
            return (
              <li key={`${e.at}-${i}`} className={`rounded-xl border p-3 text-sm ${levelStyle(e.level)}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">{e.message}</span>
                  <span className="shrink-0 text-xs opacity-70">{fmt(e.at)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] opacity-70">
                  <span className="rounded-full bg-ink/10 px-2 py-0.5 font-bold uppercase">
                    {e.level}
                  </span>
                  <span>{e.source}</span>
                  <span className="font-mono">{e.event}</span>
                  {hasData && (
                    <button
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          return next;
                        })
                      }
                      className="underline"
                    >
                      {open ? "skjul detaljer" : "vis detaljer"}
                    </button>
                  )}
                </div>
                {open && hasData && (
                  <pre className="mt-2 overflow-auto rounded-lg bg-ink/95 p-2 font-mono text-[11px] text-cream/90">
                    {JSON.stringify(e.data, null, 2)}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-cream-2 px-4 py-3 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="rounded-lg bg-cream px-3 py-1.5 font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
          >
            ← Forrige
          </button>
          <span className="font-semibold text-ink">
            Side {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            className="rounded-lg bg-cream px-3 py-1.5 font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
          >
            Neste →
          </button>
        </div>
      )}
    </div>
  );
}
