"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { RunEvent, StepEvent } from "@/lib/types";

/** Canonical pipeline order for the checklist (server emits a subset live). */
const DISPLAY_STEPS: { key: string; label: string }[] = [
  { key: "fetch", label: "Henter produkter" },
  { key: "classify", label: "Klassifiserer" },
  { key: "images", label: "Cacher bilder" },
  { key: "pdf", label: "Bygger PDF" },
  { key: "baseline", label: "Baseline lagret" },
  { key: "reels", label: "Rendrer reels" },
];

type Phase = "idle" | "running" | "done" | "error";

export default function GeneratePanel({ onComplete }: { onComplete?: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [mock, setMock] = useState(false);
  const [commit, setCommit] = useState(true);
  const [slider, setSlider] = useState(true);
  // Origin chip: off by default. The weekly drop spans the whole catalogue, so
  // there is no sensible fixed country here — only "never" or "when the reel is
  // genuinely single-origin". A specific country is a manual-ad choice (picker).
  const [origin, setOrigin] = useState("none");
  const [steps, setSteps] = useState<Record<string, StepEvent["status"]>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<{ drop: string | null; assets: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** The job the server is running for us, kept so a dropped connection can be
   *  picked back up — the render itself carries on regardless of this browser. */
  const jobRef = useRef<string | null>(null);
  const seenSeqRef = useRef(-1);
  /** `phase` as a ref: the async stream loop closes over its first render, so
   *  reading the state variable there would always see "idle". */
  const phaseRef = useRef<Phase>("idle");

  function enterPhase(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  const pushLog = (line: string) =>
    setLogs((prev) => {
      const next = [...prev, line].slice(-200);
      queueMicrotask(() => logRef.current?.scrollTo({ top: 1e9 }));
      return next;
    });

  async function start() {
    enterPhase("running");
    setSteps({});
    setLogs([]);
    setResult(null);
    setError(null);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mock, commit, slider, origin }),
        signal: ac.signal,
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
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          handleEvent(block);
        }
      }

      // The stream ended without saying how it went. The render runs on a
      // runner and does not care that this connection died, so ask how it is
      // getting on rather than leaving a spinner turning over finished work.
      if (phaseRef.current === "running") await followJob();
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (phaseRef.current === "running" && jobRef.current) {
        pushLog("[dashboard] mistet forbindelsen — følger jobben videre…");
        await followJob();
        return;
      }
      setError(String((err as Error).message));
      enterPhase("error");
    }
  }

  /**
   * Follow a job after losing the stream.
   *
   * A render outlives the connection watching it, so losing the stream is not
   * losing the work — without this the operator sees a spinner for a drop that
   * finished minutes ago, which is indistinguishable from a hang.
   */
  async function followJob() {
    const jobId = jobRef.current;
    if (!jobId) {
      setError("Mistet forbindelsen før jobben rakk å starte. Prøv igjen.");
      enterPhase("error");
      return;
    }

    const deadline = Date.now() + 50 * 60_000;
    while (Date.now() < deadline) {
      if (abortRef.current?.signal.aborted) return;
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await fetch(
          `/api/generate/status?jobId=${encodeURIComponent(jobId)}&since=${seenSeqRef.current}`,
        );
        const data = await res.json();
        if (data.error) continue;

        for (const entry of data.logs ?? []) {
          pushLog(entry.line);
          seenSeqRef.current = Math.max(seenSeqRef.current, entry.seq);
        }

        if (data.finished) {
          if (data.status === "done") {
            setResult({ drop: data.drop ?? null, assets: 0 });
            enterPhase("done");
            onComplete?.();
          } else {
            setError(data.error ?? `jobben endte som ${data.status}`);
            enterPhase("error");
          }
          return;
        }
      } catch {
        /* keep trying — the job outlives a flaky connection */
      }
    }
    setError("Fikk ikke kontakt med jobben. Se GitHub Actions for status.");
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
    if (event === "job") {
      jobRef.current = (payload as { jobId?: string }).jobId ?? null;
    } else if (event === "log") {
      pushLog(payload.line ?? "");
    } else if (event === "step" && payload.key && payload.status) {
      const { key, status } = payload;
      setSteps((prev) => ({ ...prev, [key]: status }));
    } else if (event === "done") {
      setResult({ drop: payload.drop ?? null, assets: payload.assets ?? 0 });
      enterPhase("done");
      onComplete?.();
    } else if (event === "error") {
      setError(payload.message ?? "ukjent feil");
      enterPhase("error");
    }
  }

  const running = phase === "running";

  return (
    <section className="rounded-2xl border border-line bg-cream-2 p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-extrabold text-ink">Generer drop</h2>
          <p className="mt-1 text-sm text-mute">
            Kjører hele pipelinen i worker-en: henter produkter, klassifiserer,
            bygger katalog-PDF og rendrer reels.
          </p>
        </div>
        <button
          onClick={start}
          disabled={running}
          className="rounded-xl bg-orange px-5 py-2.5 text-sm font-bold text-cream shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? "Genererer…" : "Generer drop"}
        </button>
      </div>

      {/* options */}
      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={mock} disabled={running} onChange={(e) => setMock(e.target.checked)} className="accent-orange" />
          <span className="text-ink/80">Mock-data (offline, ingen baseline)</span>
        </label>
        <label className={`flex items-center gap-2 ${mock ? "opacity-40" : ""}`}>
          <input type="checkbox" checked={commit} disabled={running || mock} onChange={(e) => setCommit(e.target.checked)} className="accent-orange" />
          <span className="text-ink/80">Lagre baseline (commit snapshot)</span>
        </label>
        {/* Extra slider reel per category — the normal 3-vare reels are rendered
            either way, this only adds one file per category with >3 varer. */}
        <label className="flex items-center gap-2" title="Én ekstra reel per kategori som blar gjennom ALLE varene, 3 om gangen (maks 24)">
          <input type="checkbox" checked={slider} disabled={running} onChange={(e) => setSlider(e.target.checked)} className="accent-orange" />
          <span className="text-ink/80">Slider-reel i tillegg (alle varer)</span>
        </label>
        <label className="flex items-center gap-2" title="Flagg-merket «FRA POLEN» på reelene. Av som standard; «automatisk» viser det kun når alle varene i reelen har samme land.">
          <span className="text-ink/80">Opprinnelsesland</span>
          <select
            value={origin}
            disabled={running}
            onChange={(e) => setOrigin(e.target.value)}
            className="rounded-lg border border-line bg-cream px-2 py-1 text-sm text-ink outline-none focus:border-orange"
          >
            <option value="none">av</option>
            <option value="auto">automatisk</option>
          </select>
        </label>
      </div>

      {/* progress checklist */}
      {phase !== "idle" && (
        <ol className="mt-6 space-y-2">
          {DISPLAY_STEPS.map((s) => {
            const st = steps[s.key];
            const icon = st === "done" ? "✓" : st === "active" ? "…" : "•";
            const cls =
              st === "done"
                ? "text-ink"
                : st === "active"
                  ? "text-orange font-semibold"
                  : "text-mute/60";
            return (
              <li key={s.key} className={`flex items-center gap-3 text-sm ${cls}`}>
                <span className={`grid h-6 w-6 place-items-center rounded-full border ${st === "done" ? "border-orange bg-orange text-cream" : st === "active" ? "border-orange text-orange" : "border-line text-mute/50"}`}>
                  {icon}
                </span>
                {s.label}
              </li>
            );
          })}
        </ol>
      )}

      {/* result / error */}
      {phase === "done" && result && (
        <div className="mt-5 rounded-xl border border-orange/30 bg-orange/10 p-4 text-sm">
          <p className="font-bold text-ink">Ferdig — {result.assets} filer</p>
          {result.drop && (
            <Link href={`/drops?open=${result.drop}`} className="mt-1 inline-block font-semibold text-orange underline">
              Åpne {result.drop} →
            </Link>
          )}
        </div>
      )}
      {phase === "error" && (
        <div className="mt-5 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          Feil: {error}
        </div>
      )}

      {/* live log */}
      {logs.length > 0 && (
        <div
          ref={logRef}
          className="mt-5 max-h-44 overflow-auto rounded-xl bg-ink/95 p-3 font-mono text-xs leading-relaxed text-cream/90"
        >
          {logs.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap">{l}</div>
          ))}
        </div>
      )}
    </section>
  );
}
