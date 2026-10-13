"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { PickerProduct, ProductsResponse, RunEvent, StepEvent } from "@/lib/types";
import { useLang } from "@/lib/i18n";
import { freshSignal } from "@/lib/picker-order";

const WINDOWS = [
  { days: 1, no: "I dag", en: "Today" },
  { days: 2, no: "Siste 2 dager", en: "Last 2 days" },
  { days: 3, no: "3 dager", en: "3 days" },
  { days: 7, no: "7 dager", en: "7 days" },
  { days: 14, no: "14 dager", en: "14 days" },
  { days: 30, no: "30 dager", en: "30 days" },
  { days: 90, no: "90 dager", en: "90 days" },
];

const SELECT_STEPS = [
  { key: "fetch", no: "Henter produkter", en: "Fetching products" },
  { key: "classify", no: "Klassifiserer", en: "Classifying" },
  { key: "images", no: "Cacher bilder", en: "Caching images" },
  { key: "pdf", no: "Bygger PDF", en: "Building PDF" },
  { key: "reels", no: "Rendrer reels", en: "Rendering reels" },
];

type RunPhase = "idle" | "running" | "done" | "error";

function fmtDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "short" });
  } catch {
    return "—";
  }
}

export default function PickerPage() {
  const { t, locale } = useLang();
  const [windowDays, setWindowDays] = useState(14);
  const [minRestock, setMinRestock] = useState(5);
  const [offersOnly, setOffersOnly] = useState(false);
  // "Lagt inn på lager": everything whose stock changed inside the window, with
  // no new/restock gate. Combines WITH the day buttons (unlike the offer view,
  // which ignores the window), so «Lagt inn på lager» + «Siste 2 dager» is
  // literally "what did we take in the last two days".
  const [stockedOnly, setStockedOnly] = useState(false);
  const [products, setProducts] = useState<PickerProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** "a refetch is running in the background" — not an error, and not a reason
   *  to clear the grid the operator is working in. */
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const refreshPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const [search, setSearch] = useState("");
  const [hideOos, setHideOos] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [campaignTitle, setCampaignTitle] = useState("");
  // Extra slider reel per category (pages through ALL picks, not just 3). The
  // normal 3-vare reel is rendered either way — this only adds a file.
  const [slider, setSlider] = useState(true);
  // Origin chip (flag pill) on the reels. "none" = no chip, which is the
  // default: it used to appear on its own whenever a reel happened to be
  // single-origin, which is not always what the ad should say. "auto" restores
  // that behaviour; an ISO code prints that country on every reel of the run.
  const [origin, setOrigin] = useState("none");

  // ---- render run (SSE) state ----
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [steps, setSteps] = useState<Record<string, StepEvent["status"]>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<{ drop: string | null; assets: number } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  /** The job the runner is doing for us. A render outlives the connection that
   *  started it, so losing the stream is not losing the work — but only if we
   *  kept the id. */
  const jobRef = useRef<string | null>(null);
  const seenSeqRef = useRef(-1);
  /** `phase` as a ref: the async stream loop closes over its first render, so
   *  reading the state variable there would always see the old value. */
  const phaseRef = useRef<RunPhase>("idle");
  const logRef = useRef<HTMLDivElement>(null);

  /** Reload once the dispatched fetch has finished, so the operator does not
   *  have to guess when to press the button again. Bounded: a job that never
   *  reports back stops being waited on rather than polling for ever. */
  const watchRefresh = useCallback(
    (jobId: string, days: number, minInc: number, opts?: { offers?: boolean; stocked?: boolean }) => {
      if (refreshPoll.current) clearInterval(refreshPoll.current);
      const started = Date.now();
      refreshPoll.current = setInterval(async () => {
        if (Date.now() - started > 5 * 60_000) {
          if (refreshPoll.current) clearInterval(refreshPoll.current);
          setRefreshNote(t("Oppdateringen tok for lang tid — prøv ↻ igjen.", "The refresh took too long — try ↻ again."));
          return;
        }
        try {
          const r = await fetch(`/api/generate/status?jobId=${encodeURIComponent(jobId)}&since=99999`);
          const d = await r.json();
          if (!d.finished) return;
          if (refreshPoll.current) clearInterval(refreshPoll.current);
          setRefreshNote(null);
          load(days, minInc, opts);
        } catch {
          /* transient — the next tick tries again */
        }
      }, 5000);
    },
    // `load` is defined below and is stable; referencing it here would be a
    // cycle, so the reload is called through the ref-free closure instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => () => { if (refreshPoll.current) clearInterval(refreshPoll.current); }, []);

  const load = useCallback(async (days: number, minInc: number, opts?: { offers?: boolean; stocked?: boolean; refresh?: boolean }) => {
    setLoading(true);
    setLoadError(null);
    try {
      // Offer view ignores the freshness window entirely (a price change doesn't
      // make a product "new" or "restocked"), so campaign products stay visible.
      // Stock view keeps the window but drops the new/restock gate: everything
      // whose stock was touched in the window, so a delivery of products that
      // are neither brand-new nor in the baseline still shows up.
      const qs = opts?.offers
        ? `offers=1&limit=500`
        : opts?.stocked
          ? `stocked=1&since=${days}&limit=500`
          : `since=${days}&minRestock=${minInc}&limit=500`;
      const res = await fetch(`/api/products?${qs}${opts?.refresh ? "&refresh=1" : ""}`);
      const data: ProductsResponse & {
        error?: string;
        refreshing?: boolean;
        note?: string;
        jobId?: string;
      } = await res.json();
      if (data.error) throw new Error(data.error);

      // A hosted refresh cannot fetch inside the request — it dispatches a job
      // and answers with an empty list. Rendering that emptied the whole grid
      // and said nothing, so pressing ↻ looked like it had destroyed the
      // screen. Keep what is on it, say what is happening, and swap the list
      // in when the fetch has actually landed.
      if (data.refreshing) {
        setRefreshNote(data.note ?? t("Henter produkter i bakgrunnen…", "Fetching products in the background…"));
        // Deliberately WITHOUT `refresh` — the reload must be an ordinary
        // read. Passing opts straight through kept refresh=1 set, so the
        // reload asked for another refresh, got another "refreshing" answer,
        // and the banner never cleared: a loop that polls for ever and never
        // shows the new list. (TypeScript does not catch it: excess-property
        // checks only apply to object literals, and this was a variable.)
        if (data.jobId) {
          watchRefresh(data.jobId, days, minInc, { offers: opts?.offers, stocked: opts?.stocked });
        }
        return;
      }
      setRefreshNote(null);
      setProducts(data.products ?? []);
    } catch (err) {
      setLoadError(String((err as Error).message));
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, [watchRefresh]);

  useEffect(() => {
    load(windowDays, minRestock, { offers: offersOnly, stocked: stockedOnly });
  }, [windowDays, minRestock, offersOnly, stockedOnly, load]);

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

  /** Countries present in the current selection (or, before you pick anything,
   *  in the loaded list) — the only origins worth offering, since the flag has
   *  to be true for the products actually in the reel. */
  const originChoices = useMemo(() => {
    const pool = selected.size > 0 ? products.filter((p) => selected.has(p.id)) : products;
    const byCode = new Map<string, { code: string; name: string; count: number }>();
    for (const p of pool) {
      if (!p.country_code) continue;
      const cur = byCode.get(p.country_code);
      if (cur) cur.count += 1;
      else
        byCode.set(p.country_code, {
          code: p.country_code,
          name: p.country_name_no || p.country_code,
          count: 1,
        });
    }
    return Array.from(byCode.values()).sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );
  }, [products, selected]);

  // How many the "Skjul utsolgt" checkbox is swallowing. In the Tilbud view this
  // is usually most of them (offers linger on sold-out stock), which reads as
  // "nothing is showing" — so we surface the number with a one-click escape.
  const hiddenOos = useMemo(
    () => (hideOos ? products.filter((p) => !p.in_stock).length : 0),
    [products, hideOos],
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

  /** "1 PDF + 4 mp4" -> 5. The live stream reports this in its done event; once
   *  the stream is gone the log line is the only place it exists. */
  const assetsRef = useRef(0);

  const pushLog = (line: string) => {
    // Read the count HERE, not inside the updater below: React may defer that
    // callback, and the reconnect path reads the ref on the very next line —
    // which is how a finished drop reported "0 filer".
    const m = /1 PDF \+ (\d+) mp4/.exec(line);
    if (m) assetsRef.current = parseInt(m[1], 10) + 1;
    setLogs((prev) => {
      const next = [...prev, line].slice(-200);
      queueMicrotask(() => logRef.current?.scrollTo({ top: 1e9 }));
      return next;
    });
  };

  function enterPhase(next: RunPhase) {
    phaseRef.current = next;
    setPhase(next);
  }

  /**
   * Follow the job after the stream goes.
   *
   * A manual render takes minutes and the streaming function is capped well
   * below that, so the connection is cut on any sizeable selection. Until now
   * the read loop simply ended and the page sat at "running" for ever: the
   * reels finished on the runner, the drop was uploaded, and the operator was
   * still watching a spinner with no way to tell that from a crash.
   */
  async function followJob() {
    const jobId = jobRef.current;
    if (!jobId) {
      setRunError("Mistet forbindelsen før jobben rakk å starte. Prøv igjen.");
      enterPhase("error");
      return;
    }
    const deadline = Date.now() + 50 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await fetch(
          `/api/generate/status?flow=select&jobId=${encodeURIComponent(jobId)}&since=${seenSeqRef.current}`,
        );
        const data = await res.json();
        if (data.error) continue;

        for (const entry of data.logs ?? []) {
          pushLog(entry.line);
          seenSeqRef.current = Math.max(seenSeqRef.current, entry.seq);
        }
        // The checklist has to come from here too, or it freezes on whichever
        // step was live when the stream died and stays there all render.
        if (Array.isArray(data.steps)) {
          setSteps((prev) => {
            const next = { ...prev };
            for (const st of data.steps) next[st.key] = st.status;
            return next;
          });
        }

        if (data.finished) {
          if (data.status === "done") {
            setSteps((prev) => {
              const next = { ...prev };
              for (const k of Object.keys(next)) if (next[k] === "active") next[k] = "done";
              return next;
            });
            setResult({ drop: data.drop ?? null, assets: assetsRef.current });
            enterPhase("done");
          } else {
            setRunError(data.error ?? `jobben endte som ${data.status}`);
            enterPhase("error");
          }
          return;
        }
      } catch {
        /* the job outlives a flaky connection — try again on the next tick */
      }
    }
    setRunError("Fikk ikke kontakt med jobben. Se GitHub Actions for status.");
    enterPhase("error");
  }

  function handleEvent(block: string) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    let payload: RunEvent = {};
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "job") jobRef.current = payload.jobId ?? null;
    else if (event === "log") pushLog(payload.line ?? "");
    else if (event === "step" && payload.key && payload.status) {
      const { key, status } = payload;
      setSteps((prev) => ({ ...prev, [key]: status }));
    } else if (event === "done") {
      setResult({ drop: payload.drop ?? null, assets: payload.assets ?? 0 });
      enterPhase("done");
    } else if (event === "error") {
      setRunError(payload.message ?? "ukjent feil");
      enterPhase("error");
    }
  }

  async function startRender(mode: "full" | "tilbud" = "full") {
    if (selected.size === 0) return;
    if (mode === "tilbud" && selectedOffers === 0) return;
    enterPhase("running");
    setSteps({});
    setLogs([]);
    setResult(null);
    setRunError(null);
    jobRef.current = null;
    seenSeqRef.current = -1;
    assetsRef.current = 0;
    try {
      const res = await fetch("/api/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: Array.from(selected),
          mode,
          title: campaignTitle.trim(),
          slider,
          origin,
        }),
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

      // The stream ended without saying how it went — the usual case on any
      // render long enough to outlive the function. The runner does not care
      // that this connection died, so ask how the job is getting on instead of
      // leaving a spinner turning over work that may already be finished.
      if (phaseRef.current === "running") await followJob();
    } catch (err) {
      if (phaseRef.current === "running" && jobRef.current) {
        pushLog("[dashboard] mistet forbindelsen — følger jobben videre…");
        await followJob();
        return;
      }
      setRunError(String((err as Error).message));
      enterPhase("error");
    }
  }

  const running = phase === "running";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">{t("Velg produkter", "Pick products")}</h1>
          <p className="mt-1 text-sm text-mute">
            {t(
              "Nyeste oppdaterte produkter øverst. Kryss av dem du vil ha annonser + katalog for, og trykk «Lag annonser». Ingen baseline lagres.",
              "Most recently updated products first. Tick the ones you want ads + a catalogue for, and press “Create ads”. No baseline is saved.",
            )}
          </p>
        </div>
        <Link href="/" className="text-sm font-semibold text-orange underline">
          {t("← Tilbake", "← Back")}
        </Link>
      </div>

      {/* controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-cream-2 p-4">
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => {
                // The window applies to the stock view too, so only the offer
                // view (which has no window) is cleared here.
                setOffersOnly(false);
                setWindowDays(w.days);
              }}
              disabled={loading}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                !offersOnly && windowDays === w.days
                  ? "bg-orange text-cream"
                  : "bg-cream text-ink/70 hover:bg-line/40"
              }`}
            >
              {t(w.no, w.en)}
            </button>
          ))}
          {/* Stock view: everything whose lager changed inside the window — the
              only view that catches a delivery of products that are neither new
              nor known to the restock baseline. */}
          <button
            onClick={() => {
              setOffersOnly(false);
              setStockedOnly((v) => !v);
            }}
            disabled={loading}
            title={t("Alle varer der lageret er endret i valgt tidsvindu — uavhengig av nyhet/restock-baseline", "All products whose stock changed in the selected window — regardless of the new/restock baseline")}
            className={`ml-1 rounded-lg px-3 py-1.5 text-sm font-bold transition ${
              stockedOnly ? "bg-sky-600 text-white" : "bg-sky-50 text-sky-700 hover:bg-sky-100"
            }`}
          >
            {t("Lagt inn på lager", "Stocked in")}
          </button>
          {/* Offer view: ignores the freshness window, so products you just
              price-changed in Shopify show up even though they aren't new. */}
          <button
            onClick={() => {
              setStockedOnly(false);
              setOffersOnly(true);
            }}
            disabled={loading}
            title={t("Alle varer med førpris (tilbud) — uavhengig av tidsvindu", "All products with a compare-at price (offers) — regardless of window")}
            className={`ml-1 rounded-lg px-3 py-1.5 text-sm font-bold transition ${
              offersOnly ? "bg-red-600 text-white" : "bg-red-50 text-red-700 hover:bg-red-100"
            }`}
          >
            {t("Tilbud", "Offers")}
          </button>
          <button
            onClick={() => load(windowDays, minRestock, { offers: offersOnly, stocked: stockedOnly, refresh: true })}
            disabled={loading}
            title={t("Hent på nytt fra Shopify (etter at du har endret priser)", "Fetch again from Shopify (after you have changed prices)")}
            className="ml-1 rounded-lg bg-cream px-3 py-1.5 text-sm font-semibold text-ink/70 transition hover:bg-line/40 disabled:opacity-40"
          >
            {t("↻ Oppdater", "↻ Refresh")}
          </button>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("Søk tittel eller leverandør…", "Search title or vendor…")}
          className="min-w-[200px] flex-1 rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-orange"
        />
        <label className="flex items-center gap-2 text-sm text-ink/80">
          <input type="checkbox" checked={hideOos} onChange={(e) => setHideOos(e.target.checked)} className="accent-orange" />
          {t("Skjul utsolgt", "Hide sold out")}
          {hiddenOos > 0 && (
            <span className="rounded-full bg-orange/20 px-2 py-0.5 text-xs font-bold text-orange">
              {hiddenOos} {t("skjult", "hidden")}
            </span>
          )}
        </label>
        <label className="flex items-center gap-2 text-sm text-ink/80" title={t("Minste antall enheter lagt inn på lager for å telle som restock (utelukker rent solgte varer)", "Minimum units added to stock to count as a restock (excludes products that only sold)")}>
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
        {offersOnly ? (
          <>
            {t("Viser", "Showing")}{" "}
            <span className="font-semibold text-ink">{t("alle varer med førpris (tilbud)", "all products with a compare-at price (offers)")}</span>{" "}
            {t(
              "— uavhengig av tidsvindu, nyest endret først. Endret du priser i Shopify nå? Trykk",
              "— regardless of window, most recently changed first. Just changed prices in Shopify? Press",
            )}{" "}
            <span className="font-semibold text-ink">{t("↻ Oppdater", "↻ Refresh")}</span>.
          </>
        ) : stockedOnly ? (
          <>
            {t("Viser", "Showing")}{" "}
            <span className="font-semibold text-ink">{t("alle varer der lageret er endret", "all products whose stock has changed")}</span>{" "}
            {t(
              "i vinduet, nyeste lagerendring først — uavhengig av om varen er ny eller finnes i restock-baselinen. Her ligger varemottaket ditt, også varer som ble opprettet for uker siden.",
              "in the window, most recent stock change first — whether or not the product is new or in the restock baseline. This is where your goods receipt lives, including products created weeks ago.",
            )}{" "}
            <span className="font-semibold text-ink">{t("NB:", "Note:")}</span>{" "}
            {t(
              "et salg endrer også lageret, så sjekk antallet før du velger. Nettopp lagt inn? Trykk",
              "a sale also changes stock, so check the quantity before you pick. Just added stock? Press",
            )}{" "}
            <span className="font-semibold text-ink">{t("↻ Oppdater", "↻ Refresh")}</span>.
          </>
        ) : (
          <>
            {t("Viser kun", "Showing only")}{" "}
            <span className="font-semibold text-ink">{t("nye", "new")}</span> {t("varer og varer", "products and products")}{" "}
            <span className="font-semibold text-ink">
              {t(`lagt inn på lager (+${minRestock} eller mer)`, `stocked in (+${minRestock} or more)`)}
            </span>{" "}
            {t(
              "i vinduet — rent solgte varer skjules. Prisendringer vises ikke her; bruk",
              "in the window — products that only sold are hidden. Price changes are not shown here; use",
            )}{" "}
            <span className="font-semibold text-ink">{t("Tilbud", "Offers")}</span>.
          </>
        )}
      </p>

      {/* campaign headline for the intro (montage) reel */}
      <div className="rounded-2xl border border-line bg-cream-2 p-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink">
            {t("Kampanjetittel", "Campaign title")}{" "}
            <span className="font-normal text-mute">{t("(valgfri — vises på intro-reelen)", "(optional — shown on the intro reel)")}</span>
          </span>
          <input
            value={campaignTitle}
            onChange={(e) => setCampaignTitle(e.target.value)}
            maxLength={60}
            placeholder={t("F.eks. «Vi introduserer mange varer fra Balkan»", "E.g. “We are introducing many products from the Balkans”")}
            className="w-full rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-orange"
          />
          <span className="text-[11px] text-mute">
            {t(
              "La stå tom for standardteksten «Nye varer denne uken». Vises med store bokstaver.",
              "Leave empty for the default text “Nye varer denne uken” (new products this week). Shown in capitals.",
            )}
          </span>
        </label>

        {/* Slider-reel: the 3-vare reel is always made; this adds an extra reel
            that pages through every pick in the category (all 12 isene, not 3). */}
        <label className="mt-4 flex cursor-pointer items-start gap-2 border-t border-line pt-4">
          <input
            type="checkbox"
            checked={slider}
            onChange={(e) => setSlider(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-orange"
          />
          <span className="text-sm text-ink">
            <span className="font-semibold">{t("Lag også slider-reel", "Also create a slider reel")}</span>{" "}
            {t("(viser ALLE valgte varer, 3 om gangen)", "(shows ALL selected products, 3 at a time)")}
            <span className="mt-0.5 block text-[11px] text-mute">
              {t(
                "Vanlig 3-vare reel lages uansett. Slideren kommer i tillegg, én per kategori med mer enn 3 varer — maks 24 varer per slider (~21 sek).",
                "The regular 3-product reel is always made. The slider comes in addition, one per category with more than 3 products — max 24 products per slider (~21 sec).",
              )}
            </span>
          </span>
        </label>

        {/* Origin chip — OFF unless you ask for it. The flag must be true for
            every product in the reel, so the country list is built from your
            selection, not from a fixed list. */}
        <label className="mt-4 flex flex-col gap-1.5 border-t border-line pt-4">
          <span className="text-sm font-semibold text-ink">
            {t("Opprinnelsesland på reels", "Country of origin on reels")}{" "}
            <span className="font-normal text-mute">{t("(valgfritt — av som standard)", "(optional — off by default)")}</span>
          </span>
          <select
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            className="w-full max-w-sm rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-orange"
          >
            <option value="none">{t("Ingen — ikke vis land", "None — do not show country")}</option>
            <option value="auto">
              {t("Automatisk — kun når alle varene i reelen har samme land", "Automatic — only when all products in the reel share the same country")}
            </option>
            {originChoices.map((c) => (
              <option key={c.code} value={c.code}>
                {t(
                  `Alltid «FRA ${c.name}» (${c.count} ${c.count === 1 ? "vare" : "varer"})`,
                  `Always “FRA ${c.name}” (${c.count} ${c.count === 1 ? "product" : "products"})`,
                )}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-mute">
            {t(
              "Velger du et land, får ALLE reelene i denne kjøringen det flagget — også varer fra et annet land. Listen viser landene i utvalget ditt.",
              "If you pick a country, ALL reels in this run get that flag — including products from another country. The list shows the countries in your selection.",
            )}
          </span>
        </label>
      </div>

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
            {t("Velg alle", "Select all")}{visible.length > 0 ? ` (${visible.length})` : ""}
          </label>
          <span className="text-sm text-mute">·</span>
          <span className="text-sm font-semibold text-ink">{selected.size} {t("valgt", "selected")}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Why the offer button is dead, said out loud.
              It is disabled unless a SELECTED product carries a førpris, and in
              the normal windows almost nothing does — 0 of 255 in the 30-day
              view on the day this was written. So from this screen the button
              is permanently grey, and the only explanation was a title
              attribute, which browsers do not reliably show on a disabled
              control. From the operator's side the button was simply broken.
              Now it says what is missing and where the offers actually live. */}
          {selected.size > 0 && selectedOffers === 0 && (
            <span className="text-xs text-mute">
              {t("Ingen av de valgte varene har førpris —", "None of the selected products has a compare-at price —")}{" "}
              <button
                type="button"
                onClick={() => { setStockedOnly(false); setOffersOnly(true); }}
                className="font-semibold text-red-700 underline underline-offset-2"
              >
                {t("bytt til Tilbud", "switch to Offers")}
              </button>{" "}
              {t("for å lage en tilbudsannonse.", "to create an offer ad.")}
            </span>
          )}
          <button onClick={clearSelection} disabled={selected.size === 0} className="rounded-lg bg-cream px-3 py-1.5 text-sm font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40">
            {t("Nullstill", "Clear")}
          </button>
          <button
            onClick={() => startRender("tilbud")}
            disabled={selectedOffers === 0 || running}
            title={selectedOffers === 0 ? t("Velg minst ett produkt med tilbud (førpris)", "Pick at least one product with an offer (compare-at price)") : t(`${selectedOffers} tilbud valgt`, `${selectedOffers} offers selected`)}
            className="rounded-xl border border-red-600 bg-red-50 px-4 py-2 text-sm font-bold text-red-700 shadow-sm transition hover:bg-red-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? t("Lager…", "Creating…") : `${t("Lag tilbud annonse", "Create offer ad")}${selectedOffers > 0 ? ` (${selectedOffers})` : ""}`}
          </button>
          <button
            onClick={() => startRender("full")}
            disabled={selected.size === 0 || running}
            className="rounded-xl bg-orange px-5 py-2 text-sm font-bold text-cream shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? t("Lager…", "Creating…") : `${t("Lag annonser + katalog", "Create ads + catalogue")} (${selected.size})`}
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
                  {t(s.no, s.en)}
                </li>
              );
            })}
          </ol>
          {phase === "done" && result && (
            <div className="mt-4 rounded-xl border border-orange/30 bg-orange/10 p-3 text-sm">
              <p className="font-bold text-ink">{t("Ferdig", "Done")} — {result.assets} {t("filer", "files")}</p>
              {result.drop && (
                <Link href={`/drops?open=${result.drop}`} className="mt-1 inline-block font-semibold text-orange underline">
                  {t("Åpne", "Open")} {result.drop} →
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

      {/* A background refetch is running. Shown ABOVE the grid, never instead of
          it: the list on screen is still perfectly usable while Shopify is
          re-read, and replacing it with a status message is what made pressing
          ↻ feel like it had wiped the page. */}
      {refreshNote && (
        <p className="mb-4 rounded-xl border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          ↻ {refreshNote}
        </p>
      )}

      {/* product grid */}
      {loading ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-cream-2 p-10 text-center">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-orange border-t-transparent" />
          <p className="text-sm font-semibold text-ink">{t("Henter produkter fra Shopify…", "Fetching products from Shopify…")}</p>
          <p className="text-xs text-mute">
            {t(
              "Kun første lasting tar ~20–30 sek. Etterpå er alle tidsvinduene lynraske (mellomlagret i 5 min).",
              "Only the first load takes ~20–30 sec. After that all the time windows are lightning fast (cached for 5 min).",
            )}
          </p>
        </div>
      ) : loadError ? (
        <p className="rounded-2xl border border-red-300 bg-red-50 p-6 text-center text-sm text-red-700">
          Kunne ikke hente produkter: {loadError}
        </p>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-cream-2 p-8 text-center text-sm text-mute">
          {hiddenOos > 0 ? (
            <>
              <p className="font-semibold text-ink">
                {t(
                  `${hiddenOos} ${offersOnly ? "tilbud" : "varer"} er skjult fordi de er utsolgt.`,
                  `${hiddenOos} ${offersOnly ? "offers are" : "products are"} hidden because they are sold out.`,
                )}
              </p>
              <button
                onClick={() => setHideOos(false)}
                className="mt-3 rounded-lg bg-orange px-4 py-2 text-sm font-bold text-cream"
              >
                {t("Vis utsolgte også", "Show sold out too")}
              </button>
            </>
          ) : offersOnly ? (
            <p>{t("Ingen varer med førpris. Sett «Compare-at price» i Shopify, og trykk ↻ Oppdater.", "No products with a compare-at price. Set “Compare-at price” in Shopify, then press ↻ Refresh.")}</p>
          ) : stockedOnly ? (
            <p>{t("Ingen lagerendringer i dette vinduet. Prøv et lengre vindu, eller trykk ↻ Oppdater hvis du nettopp la inn varer.", "No stock changes in this window. Try a longer window, or press ↻ Refresh if you just added products.")}</p>
          ) : (
            <p>{t("Ingen produkter i dette vinduet.", "No products in this window.")}</p>
          )}
        </div>
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
                    <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">{t("TILBUD", "OFFER")}</span>
                  )}
                  {sig && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        sig.kind === "nyhet" ? "bg-emerald-600 text-white" : "bg-sky-600 text-white"
                      }`}
                    >
                      {sig.kind === "nyhet" ? t("NYHET", "NEW") : t(sig.text, sig.text.replace(/ inn$/, " in"))}
                    </span>
                  )}
                </span>
                <div className="aspect-square w-full bg-cream">
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image_url} alt={p.title} loading="lazy" className="h-full w-full object-contain p-2" />
                  ) : (
                    <div className="grid h-full place-items-center text-xs text-mute/50">{t("ingen bilde", "no image")}</div>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1 p-3">
                  <p className="line-clamp-2 text-sm font-semibold text-ink">{p.title}</p>
                  {p.vendor && <p className="text-xs text-mute">{p.vendor}</p>}
                  <div className="mt-auto flex items-center justify-between pt-1 text-xs">
                    <span className="font-bold text-ink">{p.price_label}</span>
                    <span className={p.in_stock ? "text-mute" : "font-semibold text-red-600"}>
                      {p.in_stock ? `${p.inventory_quantity} ${t("stk", "pcs")}` : t("utsolgt", "sold out")}
                    </span>
                  </div>
                  <p className="text-[10px] text-mute/70">
                    {/* In the stock view the lager date IS the sort key, so show
                        it on every card — «lagt til» would be the wrong date. */}
                    {stockedOnly || sig?.kind === "restock"
                      ? `${t("lager oppd.", "stock upd.")} ${fmtDate(p.inventory_updated_at, locale)}`
                      : `${t("lagt til", "added")} ${fmtDate(p.created_at, locale)}`}
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
