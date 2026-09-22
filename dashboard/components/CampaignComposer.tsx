"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readSseStream } from "@/lib/sse";
import type { DropSummary, RunEvent } from "@/lib/types";

type Phase = "idle" | "sending" | "done" | "error";

export default function CampaignComposer({
  recipients,
  dryRun,
  onSent,
}: {
  /** Selected, currently-subscribed addresses from the contact list. */
  recipients: string[];
  dryRun: boolean;
  onSent?: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [headline, setHeadline] = useState("");
  const [body, setBody] = useState("");
  const [preheader, setPreheader] = useState("");
  const [ctaUrl, setCtaUrl] = useState("https://www.nordicengros.com/collections/siste-ankomst");
  const [ctaLabel, setCtaLabel] = useState("Se nyhetene i nettbutikken");

  const [drops, setDrops] = useState<DropSummary[]>([]);
  const [dropDir, setDropDir] = useState("");
  const [attach, setAttach] = useState(false);

  const [previewHtml, setPreviewHtml] = useState("");
  // Preview zoom. The email is 600px wide and usually far taller than the panel,
  // so it is rendered at its true size and scaled down to fit — scaling the
  // iframe rather than narrowing it, because narrowing would trigger the email's
  // own responsive rules and show a layout no real recipient would see.
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(900);
  const [viewportHeight, setViewportHeight] = useState(900);
  /** A fixed scale, or "fit" to shrink until the whole email is on screen.
   *  Defaults to "fit": the point of the panel is seeing the whole thing at a
   *  glance, and any fixed percentage tall enough to read brings scrollbars back. */
  const [zoom, setZoom] = useState<"fit" | number>("fit");

  const [testTo, setTestTo] = useState("");
  const [testState, setTestState] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  /** The send button unlocks only after a successful test of THIS exact content. */
  const [testedKey, setTestedKey] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [counts, setCounts] = useState({ sent: 0, failed: 0, skipped: 0, total: 0 });
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  /** Identity of the current message — changing any of it re-locks the send. */
  const contentKey = JSON.stringify({ subject, headline, body, ctaUrl, ctaLabel, attach, dropDir });

  useEffect(() => {
    fetch("/api/drops")
      .then((r) => r.json())
      .then((d) => {
        const list: DropSummary[] = (d.drops ?? []).filter((x: DropSummary) => x.pdf);
        setDrops(list);
        if (list.length && !dropDir) setDropDir(list[0].dir);
      })
      .catch(() => setDrops([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPreview = useCallback(async () => {
    try {
      const res = await fetch("/api/campaign/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headline: headline || subject,
          body,
          ctaUrl,
          ctaLabel,
          preheader,
          attachmentName: attach && dropDir ? `katalog-${dropDir}.pdf` : null,
        }),
      });
      const data = await res.json();
      if (!data.error) setPreviewHtml(data.html ?? "");
    } catch {
      /* preview is cosmetic — never surface a failure here */
    }
  }, [headline, subject, body, ctaUrl, ctaLabel, preheader, attach, dropDir]);

  useEffect(() => {
    const t = setTimeout(refreshPreview, 350); // debounce while typing
    return () => clearTimeout(t);
  }, [refreshPreview]);

  // ---- preview zoom measurement ----
  /** The email's real rendered width: the 600px body plus the 12px gutters its
   *  outer wrapper adds (`padding:24px 12px` in email-template.ts). Sizing the
   *  iframe to 600 left 24px overflowing, which is what made the preview scroll
   *  sideways — the scrollbar was inside the iframe, not around it. */
  const PREVIEW_WIDTH = 624;

  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el) return;
    setBoxWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => setBoxWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [previewHtml]);

  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** Read the rendered email's height so the whole thing can be fitted, rather
   *  than scaling against a hard-coded guess that would clip long campaigns. */
  const measurePreview = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (!doc?.body) return;
      // Take the larger of the two: body alone under-reports when the outer
      // table's margins collapse, and an under-measured height would leave the
      // iframe scrolling internally — exactly the scrollbar we want gone.
      const height = Math.max(doc.body.scrollHeight, doc.documentElement?.scrollHeight ?? 0);
      if (height > 0) setContentHeight(Math.max(400, height));
    } catch {
      // Cross-origin — keep the previous estimate rather than collapsing the box.
    }
  }, []);

  // srcDoc swaps do not always fire onLoad, so re-measure when the html changes.
  useEffect(() => {
    if (!previewHtml) return;
    const t = setTimeout(measurePreview, 120);
    return () => clearTimeout(t);
  }, [previewHtml, measurePreview]);

  // Available height for the panel, mirroring the CSS box below.
  const previewBoxHeight = Math.max(520, viewportHeight - 240);
  /** "fit" shrinks until the whole email is on screen; a number is that exact
   *  scale. Either way it is capped to the panel width, so a chosen zoom can
   *  never push the email off the side — it just scrolls vertically if tall. */
  const fitScale =
    boxWidth > 0
      ? Math.min(1, boxWidth / PREVIEW_WIDTH, previewBoxHeight / contentHeight)
      : 1;
  const widthCap = boxWidth > 0 ? boxWidth / PREVIEW_WIDTH : 1;
  const scale = zoom === "fit" ? fitScale : Math.min(zoom, widthCap);
  const scaledWidth = PREVIEW_WIDTH * scale;
  const scaledHeight = contentHeight * scale;
  /** In "fit" the email is by definition shorter than the panel, so the box is
   *  sized to the email exactly and shows no scrollbar at all. A fixed zoom can
   *  overflow — then, and only then, the box scrolls. */
  const previewOverflows = scaledHeight > previewBoxHeight + 1;
  const previewBoxStyle = {
    height: Math.min(scaledHeight, previewBoxHeight),
    overflow: previewOverflows ? "auto" : "hidden",
  } as const;

  const ZOOM_LEVELS: { value: "fit" | number; label: string }[] = [
    { value: "fit", label: "Tilpass" },
    { value: 0.5, label: "50 %" },
    { value: 0.65, label: "65 %" },
    { value: 0.8, label: "80 %" },
    { value: 1, label: "100 %" },
  ];

  const pushLog = (line: string) =>
    setLogs((prev) => {
      const next = [...prev, line].slice(-200);
      queueMicrotask(() => logRef.current?.scrollTo({ top: 1e9 }));
      return next;
    });

  async function sendTest() {
    setTesting(true);
    setTestState(null);
    try {
      const res = await fetch("/api/campaign/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: testTo,
          subject,
          headline: headline || subject,
          body,
          ctaUrl,
          ctaLabel,
          preheader,
          dropDir: attach ? dropDir : null,
          attach,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setTestState({ ok: false, msg: data.error ?? "ukjent feil" });
        return;
      }
      setTestedKey(contentKey);
      setTestState({
        ok: true,
        msg: data.dryRun
          ? "Testmodus — ingenting ble faktisk sendt. Sjekk innholdet i forhåndsvisningen."
          : `Sendt til ${testTo}${data.attached ? ` med vedlegg (${data.attachmentKb} kB)` : ""}. Åpne innboksen og se over før du sender til alle.`,
      });
    } catch (err) {
      setTestState({ ok: false, msg: String((err as Error).message) });
    } finally {
      setTesting(false);
    }
  }

  async function send() {
    if (recipients.length === 0) return;
    const label = dryRun ? "TESTMODUS — ingenting sendes." : `Dette sender e-post til ${recipients.length} kunder.`;
    if (!confirm(`${label}\n\nEmne: ${subject}\nVedlegg: ${attach && dropDir ? `katalog-${dropDir}.pdf` : "ingen"}\n\nFortsette?`)) return;

    setPhase("sending");
    setLogs([]);
    setError(null);
    setCounts({ sent: 0, failed: 0, skipped: 0, total: recipients.length });

    try {
      const res = await fetch("/api/campaign/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipients,
          subject,
          headline: headline || subject,
          body,
          ctaUrl,
          ctaLabel,
          preheader,
          dropDir: attach ? dropDir : null,
          attach,
        }),
      });
      const started = await res.json();
      if (!res.ok || started.error) throw new Error(started.error ?? "kunne ikke starte");

      pushLog(`Kampanje ${started.campaignId} startet — ${started.total} mottakere.`);

      // Watching is separate from sending: this stream can drop, or the tab can
      // close, and the campaign carries on regardless.
      const stream = await fetch(`/api/campaign/${started.campaignId}/stream`);
      await readSseStream(stream, (event: string, p: RunEvent) => {
        if (event === "log" && p.line) pushLog(p.line);
        else if (event === "progress") {
          setCounts({
            sent: p.sent ?? 0,
            failed: p.failed ?? 0,
            skipped: p.skipped ?? 0,
            total: p.total ?? recipients.length,
          });
        } else if (event === "done") {
          setCounts({
            sent: p.sent ?? 0,
            failed: p.failed ?? 0,
            skipped: p.skipped ?? 0,
            total: p.total ?? recipients.length,
          });
          setPhase("done");
          onSent?.();
        } else if (event === "error") {
          setError(p.message ?? "ukjent feil");
          setPhase("error");
        }
      });
    } catch (err) {
      setError(String((err as Error).message));
      setPhase("error");
    }
  }

  const sending = phase === "sending";
  const tested = testedKey === contentKey;
  const canSend = recipients.length > 0 && subject.trim() !== "" && tested && !sending;
  const pct = counts.total ? Math.round(((counts.sent + counts.failed + counts.skipped) / counts.total) * 100) : 0;

  const input =
    "w-full rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-orange";

  return (
    // Editor left, live preview right. `items-start` lets the preview column keep
    // its own height, so the sticky panel actually sticks instead of being
    // stretched to match the much taller form.
    <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
      {dryRun && (
        <div className="rounded-2xl border border-amber/40 bg-amber/10 p-4 text-sm text-ink lg:col-span-2">
          <p className="font-bold">Testmodus er på</p>
          <p className="mt-0.5 text-ink/80">
            Ingen e-post sendes til noen. Alt annet kjører som normalt, så du kan øve deg på hele flyten. Skru av med 
            <code className="font-mono text-xs">EMAIL_DRY_RUN=0</code> i{" "}
            <code className="font-mono text-xs">dashboard/.env.local</code> når domenet er verifisert.
          </p>
        </div>
      )}

      <section className="rounded-2xl border border-line bg-cream-2 p-6 shadow-sm">
        <h2 className="text-lg font-extrabold text-ink">Ny kampanje</h2>
        <p className="mt-1 text-sm text-mute">
          {recipients.length === 0
            ? "Velg mottakere i kontaktlisten under."
            : `${recipients.length} mottakere valgt.`}
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-mute">Emne</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={120}
              placeholder="Nye varer inne denne uken"
              className={input}
              disabled={sending}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-mute">
              Forhåndstekst
            </span>
            <input
              value={preheader}
              onChange={(e) => setPreheader(e.target.value)}
              maxLength={120}
              placeholder="Vises ved siden av emnet i innboksen"
              className={input}
              disabled={sending}
            />
          </label>
        </div>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-mute">
            Overskrift i e-posten
          </span>
          <input
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            maxLength={120}
            placeholder="Samme som emnet hvis tom"
            className={input}
            disabled={sending}
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-mute">Melding</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            placeholder={"Hei!\n\nDenne uken har vi fått inn …\n\nMed vennlig hilsen\nNordic Engros"}
            className={`${input} font-normal leading-relaxed`}
            disabled={sending}
          />
          <span className="mt-1 block text-[11px] text-mute">
            Tom linje mellom avsnitt. Ingen formatering — hold det enkelt, det er best for
            leveringen.
          </span>
        </label>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-mute">
              Knapp — lenke
            </span>
            <input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} className={input} disabled={sending} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-mute">
              Knapp — tekst
            </span>
            <input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} className={input} disabled={sending} />
          </label>
        </div>

        {/* ---- attachment ---- */}
        <div className="mt-4 rounded-xl border border-line bg-cream p-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={attach}
              onChange={(e) => setAttach(e.target.checked)}
              className="accent-orange"
              disabled={sending || drops.length === 0}
            />
            <span className="font-semibold text-ink">Legg ved katalogen som PDF</span>
          </label>
          <p className="mt-1 text-[11px] text-mute">
            Uten hake sendes bare lenken, som er best for leveringen — et stort vedlegg til hele
            listen er i seg selv et spamsignal. Med hake får kunden filen rett i innboksen.
          </p>
          {attach && (
            <select
              value={dropDir}
              onChange={(e) => setDropDir(e.target.value)}
              className="mt-2 rounded-lg border border-line bg-cream-2 px-2 py-1 text-sm text-ink outline-none focus:border-orange"
              disabled={sending}
            >
              {drops.map((d) => (
                <option key={d.dir} value={d.dir}>
                  {d.dir}
                </option>
              ))}
            </select>
          )}
          {drops.length === 0 && (
            <p className="mt-2 text-[11px] text-mute">Ingen drops med PDF ennå.</p>
          )}
        </div>

        {/* ---- test send ---- */}
        <div className="mt-4 rounded-xl border border-orange/25 bg-orange/5 p-4">
          <p className="text-sm font-bold text-ink">1. Send en test til deg selv</p>
          <p className="mt-0.5 text-[11px] text-mute">
            Påkrevd. Knappen «Send kampanje» låses opp først når en test av akkurat dette innholdet
            har gått gjennom.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="din@epost.no"
              className="w-56 rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-orange"
              disabled={sending}
            />
            <button
              onClick={sendTest}
              disabled={testing || !testTo.trim() || !subject.trim() || sending}
              className="rounded-lg bg-cream px-3 py-2 text-sm font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
            >
              {testing ? "Sender…" : "Send test"}
            </button>
            {tested && <span className="text-sm font-semibold text-ink">✓ testet</span>}
          </div>
          {testState && (
            <p className={`mt-2 text-sm ${testState.ok ? "text-ink/80" : "text-red-700"}`}>
              {testState.msg}
            </p>
          )}
        </div>

        {/* ---- send ---- */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={send}
            disabled={!canSend}
            title={
              recipients.length === 0
                ? "Velg minst én mottaker i kontaktlisten"
                : !subject.trim()
                  ? "Emnefeltet må fylles ut"
                  : !tested
                    ? "Send en test til deg selv først"
                    : `Send til ${recipients.length} mottakere`
            }
            className="rounded-xl bg-orange px-5 py-2.5 text-sm font-bold text-cream shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Sender…" : `2. Send kampanje (${recipients.length})`}
          </button>
          {!tested && subject.trim() && recipients.length > 0 && (
            <span className="text-sm text-mute">Send en test først for å låse opp.</span>
          )}
        </div>

        {/* ---- progress ---- */}
        {phase !== "idle" && (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-semibold text-ink">
                {counts.sent} sendt
                {counts.failed > 0 && ` · ${counts.failed} feilet`}
                {counts.skipped > 0 && ` · ${counts.skipped} hoppet over`} av {counts.total}
              </span>
              <span className="text-mute">{pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-orange transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>

            {phase === "done" && (
              <div className="mt-4 rounded-xl border border-orange/30 bg-orange/10 p-4 text-sm">
                <p className="font-bold text-ink">
                  Ferdig — {counts.sent} sendt
                  {counts.failed > 0 && `, ${counts.failed} feilet`}
                  {dryRun && " (testmodus, ingenting gikk ut)"}
                </p>
              </div>
            )}
            {phase === "error" && (
              <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700">
                Feil: {error}
              </div>
            )}

            <div
              ref={logRef}
              className="mt-4 max-h-40 overflow-auto rounded-xl bg-ink/95 p-3 font-mono text-xs leading-relaxed text-cream/90"
            >
              {logs.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  {l}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ---- live preview ---- */}
      <section className="rounded-2xl border border-line bg-cream-2 p-6 shadow-sm lg:sticky lg:top-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold text-ink">Forhåndsvisning</h2>
            <p className="mt-1 text-sm text-mute">
              Slik ser e-posten ut hos mottakeren. Oppdateres mens du skriver.
            </p>
          </div>
          {previewHtml && (
            <label className="flex shrink-0 items-center gap-2 text-sm">
              <span className="text-mute">Zoom</span>
              <select
                value={zoom === "fit" ? "fit" : String(zoom)}
                onChange={(e) =>
                  setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value))
                }
                title="«Tilpass» krymper til hele e-posten er synlig. En fast prosent viser den i den størrelsen — panelet ruller hvis den er høyere."
                className="rounded-lg border border-line bg-cream px-2 py-1 text-sm font-semibold text-ink outline-none focus:border-orange"
              >
                {ZOOM_LEVELS.map((z) => (
                  <option key={String(z.value)} value={z.value === "fit" ? "fit" : String(z.value)}>
                    {z.label}
                  </option>
                ))}
              </select>
              {zoom === "fit" && (
                <span className="text-xs text-mute">{Math.round(scale * 100)} %</span>
              )}
            </label>
          )}
        </div>

        {previewHtml ? (
          <div
            key="preview"
            ref={previewBoxRef}
            className="mt-4 rounded-xl border border-line bg-white"
            style={previewBoxStyle}
          >
            {/* Spacer carries the SCALED size — a CSS transform does not affect
                layout, so without this the box would size itself to the
                unscaled email and scroll anyway. */}
            <div
              className="relative mx-auto"
              style={{ width: scaledWidth || "100%", height: scaledHeight }}
            >
              <iframe
                ref={iframeRef}
                onLoad={measurePreview}
                title="Forhåndsvisning"
                srcDoc={previewHtml}
                // allow-same-origin (and nothing else) so the height can be
                // measured. Scripts stay blocked, and every value the operator
                // types is escaped before it reaches this markup.
                sandbox="allow-same-origin"
                scrolling="no"
                style={{
                  width: PREVIEW_WIDTH,
                  // Its exact content height, so the iframe has nothing of its
                  // own left to scroll.
                  height: contentHeight,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                  border: 0,
                  position: "absolute",
                  top: 0,
                  left: 0,
                  overflow: "hidden",
                }}
              />
            </div>
          </div>
        ) : (
          <p
            key="preview-empty"
            className="mt-4 grid place-items-center rounded-xl border border-dashed border-line bg-cream text-sm text-mute"
            style={{ height: previewBoxHeight }}
          >
            Skriv en melding for å se den her.
          </p>
        )}
      </section>
    </div>
  );
}
