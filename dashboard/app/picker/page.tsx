"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { PickerProduct, ProductsResponse, StepEvent } from "@/lib/types";

const WINDOWS = [
  { days: 3, label: "3 dager" },
  { days: 7, label: "7 dager" },
  { days: 14, label: "14 dager" },
  { days: 30, label: "30 dager" },
  { days: 90, label: "90 dager" },
];

const SELECT_STEPS = [
  { key: "fetch", label: "Henter produkter" },
  { key: "classify", label: "Klassifiserer" },
  { key: "images", label: "Cacher bilder" },
  { key: "pdf", label: "Bygger PDF" },
  { key: "reels", label: "Rendrer reels" },
];

type RunPhase = "idle" | "running" | "done" | "error";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("no-NO", { day: "2-digit", month: "short" });
  } catch {
    return "—";
  }
}

function withinDays(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= Date.now() - days * 24 * 60 * 60 * 1000;
}

/** Why is this product in the window? new arrival, or restocked +N. Mirrors the
 *  server's isFresh(): NEW wins, else a confirmed restock. */
function freshSignal(
  p: PickerProduct,
  days: number,
  minRestock: number,
): { kind: "nyhet" | "restock"; text: string } | null {
  if (withinDays(p.created_at, days)) return { kind: "nyhet", text: "NYHET" };
  if (
    p.restock_increase != null &&
    p.restock_increase >= minRestock &&
    withinDays(p.inventory_updated_at, days)
  ) {
    return { kind: "restock", text: `+${p.restock_increase} inn` };
  }
  return null;
}

export default function PickerPage() {
  const [windowDays, setWindowDays] = useState(14);
  const [minRestock, setMinRestock] = useState(5);
  const [products, setProducts] = useState<PickerProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hideOos, setHideOos] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ---- render run (SSE) state ----
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [steps, setSteps] = useState<Record<string, StepEvent["status"]>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<{ drop: string | null; assets: number } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (days: number, minInc: number) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/products?since=${days}&minRestock=${minInc}&limit=500`);
      const data: ProductsResponse & { error?: string } = await res.json();
      if (data.error) throw new Error(data.error);
      setProducts(data.products ?? []);
    } catch (err) {
      setLoadError(String((err as Error).message));
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(windowDays, minRestock);
  }, [windowDays, minRestock, load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (hideOos && !p.in_stock) return false;
      if (q && !`${p.title} ${p.vendor}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [products, search, hideOos, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedOffers = useMemo(
    () => products.filter((p) => selected.has(p.id) && p.is_offer).length,
    [products, selected],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allVisibleSelected =
    visible.length > 0 && visible.every((p) => selected.has(p.id));

  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const p of visible) next.delete(p.id);
      else for (const p of visible) next.add(p.id);
      return next;
    });

  const clearSelection = () => setSelected(new Set());

  const pushLog = (line: string) =>
    setLogs((prev) => {
      const next = [...prev, line].slice(-200);
      queueMicrotask(() => logRef.current?.scrollTo({ top: 1e9 }));
      return next;
    });

  function handleEvent(block: string) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    let payload: any = {};
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "log") pushLog(payload.line);
    else if (event === "step") setSteps((prev) => ({ ...prev, [payload.key]: payload.status }));
    else if (event === "done") {
      setResult({ drop: payload.drop, assets: payload.assets });
      setPhase("done");
    } else if (event === "error") {
      setRunError(payload.message);
      setPhase("error");
    }
  }

  async function startRender(mode: "full" | "tilbud" = "full") {
    if (selected.size === 0) return;
    if (mode === "tilbud" && selectedOffers === 0) return;
    setPhase("running");
    setSteps({});
    setLogs([]);
    setResult(null);
    setRunError(null);
    try {
      const res = await fetch("/api/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected), mode }),
      });
      if (!res.body) throw new Error("Ingen strøm fra server");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const b = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          handleEvent(b);
        }
      }
    } catch (err) {
      setRunError(String((err as Error).message));
      setPhase("error");
    }
  }

  const running = phase === "running";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Velg produkter</h1>
          <p className="mt-1 text-sm text-mute">
            Nyeste oppdaterte produkter øverst. Kryss av dem du vil ha annonser +
            katalog for, og trykk «Lag annonser». Ingen baseline lagres.
          </p>
        </div>
        <Link href="/" className="text-sm font-semibold text-orange underline">
          ← Tilbake
        </Link>
      </div>

      {/* controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-cream-2 p-4">
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setWindowDays(w.days)}
              disabled={loading}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                windowDays === w.days
                  ? "bg-orange text-cream"
                  : "bg-cream text-ink/70 hover:bg-line/40"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Søk tittel eller leverandør…"
          className="min-w-[200px] flex-1 rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-orange"
        />
        <label className="flex items-center gap-2 text-sm text-ink/80">
          <input type="checkbox" checked={hideOos} onChange={(e) => setHideOos(e.target.checked)} className="accent-orange" />
          Skjul utsolgt
        </label>
        <label className="flex items-center gap-2 text-sm text-ink/80" title="Minste antall enheter lagt inn på lager for å telle som restock (utelukker rent solgte varer)">
          Restock ≥
          <input
            type="number"
            min={1}
            value={minRestock}
            onChange={(e) => setMinRestock(Math.max(1, parseInt(e.target.value, 10) || 1))}
            disabled={loading}
            className="w-14 rounded-lg border border-line bg-cream px-2 py-1 text-sm text-ink outline-none focus:border-orange"
          />
        </label>
      </div>

      <p className="-mt-2 px-1 text-xs text-mute">
        Viser kun <span className="font-semibold text-ink">nye</span> varer og varer{" "}
        <span className="font-semibold text-ink">lagt inn på lager (+{minRestock} eller mer)</span> i
        vinduet — rent solgte varer skjules.
      </p>

      {/* selection bar */}
      <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-orange/30 bg-orange/10 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-ink">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleAllVisible}
              disabled={visible.length === 0}
              className="h-4 w-4 accent-orange"
            />
            Velg alle{visible.length > 0 ? ` (${visible.length})` : ""}
          </label>
          <span className="text-sm text-mute">·</span>
          <span className="text-sm font-semibold text-ink">{selected.size} valgt</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={clearSelection} disabled={selected.size === 0} className="rounded-lg bg-cream px-3 py-1.5 text-sm font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40">
            Nullstill
          </button>
          <button
            onClick={() => startRender("tilbud")}
            disabled={selectedOffers === 0 || running}
            title={selectedOffers === 0 ? "Velg minst ett produkt med tilbud (førpris)" : `${selectedOffers} tilbud valgt`}
            className="rounded-xl border border-red-600 bg-red-50 px-4 py-2 text-sm font-bold text-red-700 shadow-sm transition hover:bg-red-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "Lager…" : `Lag tilbud annonse${selectedOffers > 0 ? ` (${selectedOffers})` : ""}`}
          </button>
          <button
            onClick={() => startRender("full")}
            disabled={selected.size === 0 || running}
            className="rounded-xl bg-orange px-5 py-2 text-sm font-bold text-cream shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? "Lager…" : `Lag annonser + katalog (${selected.size})`}
          </button>
        </div>
      </div>

      {/* run progress */}
      {phase !== "idle" && (
        <section className="rounded-2xl border border-line bg-cream-2 p-5">
          <ol className="flex flex-wrap gap-4">
            {SELECT_STEPS.map((s) => {
              const st = steps[s.key];
              const icon = st === "done" ? "✓" : st === "active" ? "…" : "•";
              const cls = st === "done" ? "text-ink" : st === "active" ? "text-orange font-semibold" : "text-mute/60";
              return (
                <li key={s.key} className={`flex items-center gap-2 text-sm ${cls}`}>
                  <span className={`grid h-6 w-6 place-items-center rounded-full border ${st === "done" ? "border-orange bg-orange text-cream" : st === "active" ? "border-orange text-orange" : "border-line text-mute/50"}`}>
                    {icon}
                  </span>
                  {s.label}
                </li>
              );
            })}
          </ol>
          {phase === "done" && result && (
            <div className="mt-4 rounded-xl border border-orange/30 bg-orange/10 p-3 text-sm">
              <p className="font-bold text-ink">Ferdig — {result.assets} filer</p>
              {result.drop && (
                <Link href={`/drops?open=${result.drop}`} className="mt-1 inline-block font-semibold text-orange underline">
                  Åpne {result.drop} →
                </Link>
              )}
            </div>
          )}
          {phase === "error" && (
            <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">Feil: {runError}</div>
          )}
          {logs.length > 0 && (
            <div ref={logRef} className="mt-4 max-h-40 overflow-auto rounded-xl bg-ink/95 p-3 font-mono text-xs leading-relaxed text-cream/90">
              {logs.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap">{l}</div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* product grid */}
      {loading ? (
        <p className="rounded-2xl border border-dashed border-line bg-cream-2 p-8 text-center text-sm text-mute">
          Henter produkter fra Shopify…
        </p>
      ) : loadError ? (
        <p className="rounded-2xl border border-red-300 bg-red-50 p-6 text-center text-sm text-red-700">
          Kunne ikke hente produkter: {loadError}
        </p>
      ) : visible.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line bg-cream-2 p-8 text-center text-sm text-mute">
          Ingen produkter i dette vinduet.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((p) => {
            const on = selected.has(p.id);
            const sig = freshSignal(p, windowDays, minRestock);
            return (
              <button
                key={p.id}
                onClick={() => toggle(p.id)}
                className={`group relative flex flex-col overflow-hidden rounded-2xl border text-left transition ${
                  on ? "border-orange ring-2 ring-orange/40" : "border-line hover:border-orange/50"
                } bg-cream-2`}
              >
                <span className={`absolute left-2 top-2 z-10 grid h-6 w-6 place-items-center rounded-full border text-xs font-bold ${on ? "border-orange bg-orange text-cream" : "border-line bg-cream/90 text-transparent"}`}>
                  ✓
                </span>
                <span className="absolute right-2 top-2 z-10 flex flex-col items-end gap-1">
                  {p.is_offer && (
                    <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">TILBUD</span>
                  )}
                  {sig && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        sig.kind === "nyhet" ? "bg-emerald-600 text-white" : "bg-sky-600 text-white"
                      }`}
                    >
                      {sig.text}
                    </span>
                  )}
                </span>
                <div className="aspect-square w-full bg-cream">
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image_url} alt={p.title} loading="lazy" className="h-full w-full object-contain p-2" />
                  ) : (
                    <div className="grid h-full place-items-center text-xs text-mute/50">ingen bilde</div>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1 p-3">
                  <p className="line-clamp-2 text-sm font-semibold text-ink">{p.title}</p>
                  {p.vendor && <p className="text-xs text-mute">{p.vendor}</p>}
                  <div className="mt-auto flex items-center justify-between pt-1 text-xs">
                    <span className="font-bold text-ink">{p.price_label}</span>
                    <span className={p.in_stock ? "text-mute" : "font-semibold text-red-600"}>
                      {p.in_stock ? `${p.inventory_quantity} stk` : "utsolgt"}
                    </span>
                  </div>
                  <p className="text-[10px] text-mute/70">
                    {sig?.kind === "restock"
                      ? `lager oppd. ${fmtDate(p.inventory_updated_at)}`
                      : `lagt til ${fmtDate(p.created_at)}`}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
