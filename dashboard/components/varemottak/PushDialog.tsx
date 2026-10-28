"use client";

/**
 * Preview and send. The first step is always a dry run: nothing leaves the building
 * until the operator has seen what would be sent. A real push against the live store
 * additionally needs the owner's switch (VAREMOTTAK_LIVE_WRITES) — without it the server
 * refuses, and this dialog says so up front instead of failing after a click.
 */
import { useEffect, useState } from "react";
import { Badge } from "./cells";
import { useTr } from "./useTr";

interface Row {
  lineId: string;
  idx: string;
  name: string;
  blocked: string[];
  warnings: string[];
}

interface Outcome {
  mode: "dry-run" | "fake" | "live";
  requested: number;
  sent: number;
  succeeded: number;
  failed: number;
  blocked: Row[];
  needsAcknowledgement: Row[];
  shipmentWarnings: string[];
  requests?: Array<{ query: string; variables: Record<string, unknown>; productIds: string[] }>;
  errors: Array<{ lineId: string; idx: string; userErrors: Array<{ field: string[] | null; message: string }> }>;
}

export default function PushDialog({
  shipmentId,
  doneCount,
  shopifyMode,
  liveWritesEnabled,
  onClose,
  onPushed,
}: {
  shipmentId: string;
  doneCount: number;
  shopifyMode: "live" | "fake";
  liveWritesEnabled: boolean;
  onClose: () => void;
  onPushed: () => void;
}) {
  const { t, m } = useTr();
  const [preview, setPreview] = useState<Outcome | null>(null);
  const [result, setResult] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [showPayload, setShowPayload] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/varemottak/shipments/${shipmentId}/push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setPreview(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [shipmentId]);

  const sendable = preview ? preview.requested - preview.blocked.length : 0;
  const warned = preview?.needsAcknowledgement ?? [];
  const shipWarn = preview?.shipmentWarnings ?? [];
  const needsAck = warned.length > 0 || shipWarn.length > 0;
  const liveBlocked = shopifyMode === "live" && !liveWritesEnabled;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/varemottak/shipments/${shipmentId}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false, acknowledgeWarnings: acknowledged }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);
      onPushed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl border border-line bg-cream-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-line bg-cream-2 p-4">
          <div>
            <h2 className="text-lg font-extrabold">{t("Send til Shopify", "Send to Shopify")}</h2>
            <p className="text-sm text-mute">{t(`${doneCount} rader er merket ferdige.`, `${doneCount} rows are marked done.`)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              tone={shopifyMode === "live" ? "red" : "green"}
              title={shopifyMode === "live" ? t("Den ekte butikken", "The live store") : t("Testbutikk – ingenting når den ekte", "Test store – nothing reaches the live one")}
            >
              {shopifyMode === "live" ? t("EKTE BUTIKK", "LIVE STORE") : t("TESTBUTIKK (fake)", "TEST STORE (fake)")}
            </Badge>
            <button onClick={onClose} className="rounded px-2 py-1 text-mute hover:bg-black/5" aria-label={t("Lukk", "Close")}>
              ✕
            </button>
          </div>
        </div>

        <div className="space-y-4 p-4 text-sm">
          {error && <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-red-800">{m(error)}</p>}
          {busy && !preview && <p className="text-mute">{t("Beregner …", "Calculating …")}</p>}

          {result ? (
            <div className="space-y-3">
              <p className={`rounded-lg border px-3 py-2 font-semibold ${result.failed ? "border-yellow-400 bg-yellow-50" : "border-green-400 bg-green-50"}`}>
                {t(
                  `${result.succeeded} av ${result.sent} varer er sendt${result.failed ? `, ${result.failed} feilet` : ""}.`,
                  `${result.succeeded} of ${result.sent} items sent${result.failed ? `, ${result.failed} failed` : ""}.`,
                )}
              </p>
              {result.errors.map((e) => (
                <div key={e.lineId} className="rounded-lg border border-red-300 bg-red-50 p-3">
                  <div className="font-semibold">{e.idx}</div>
                  <ul className="mt-1 list-disc pl-5 text-red-800">
                    {e.userErrors.map((u, i) => (
                      <li key={i}>
                        {u.field?.length ? `${u.field.join(".")}: ` : ""}
                        {m(u.message)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <button onClick={onClose} className="rounded-lg bg-orange px-4 py-2 font-bold text-cream">
                {t("Lukk", "Close")}
              </button>
            </div>
          ) : (
            preview && (
              <>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Stat label={t("Klare til sending", "Ready to send")} value={sendable} tone="green" />
                  <Stat label={t("Med advarsler", "With warnings")} value={warned.length} tone="yellow" />
                  <Stat label={t("Blokkert", "Blocked")} value={preview.blocked.length} tone="red" />
                </div>

                {preview.blocked.length > 0 && (
                  <Section title={t("Kan ikke sendes", "Cannot be sent")}>
                    {preview.blocked.map((r) => (
                      <RowLine key={r.lineId} row={r} reasons={r.blocked} tone="red" />
                    ))}
                  </Section>
                )}

                {needsAck && (
                  <Section title={t("Sjekk disse først", "Check these first")}>
                    {shipWarn.map((w) => (
                      <p key={w} className="text-xs font-semibold text-amber">{t("Forsendelsen:", "Shipment:")} {m(w)}</p>
                    ))}
                    {warned.map((r) => (
                      <RowLine key={r.lineId} row={r} reasons={r.warnings} tone="yellow" />
                    ))}
                    <label className="mt-2 flex items-center gap-2 font-semibold">
                      <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                      {t("Jeg har sett advarslene og vil sende likevel", "I have seen the warnings and want to send anyway")}
                    </label>
                  </Section>
                )}

                {preview.requests && preview.requests.length > 0 && (
                  <div>
                    <button onClick={() => setShowPayload((v) => !v)} className="text-xs font-semibold text-orange hover:underline">
                      {showPayload ? t("Skjul", "Hide") : t("Vis", "Show")}{" "}
                      {t(
                        `nøyaktig hva som sendes (${preview.requests.length} kall, maks 20 varer hver)`,
                        `exactly what is sent (${preview.requests.length} calls, max 20 items each)`,
                      )}
                    </button>
                    {showPayload && (
                      <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-ink p-3 text-[11px] text-cream">
                        {JSON.stringify(preview.requests[0].variables, null, 2)}
                      </pre>
                    )}
                    <p className="mt-1 text-xs text-mute">
                      {t(
                        "Sendes: stk-pris (produkttype), kartongpris, kost per stk, utkast → aktiv + Nettbutikk. Aldri lager, tagger eller ankomstdato.",
                        "Sent: unit price (product type), carton price, cost per unit, draft → active + Online Store. Never stock, tags or arrival date.",
                      )}
                    </p>
                  </div>
                )}

                {liveBlocked && (
                  <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-red-800">
                    {t(
                      "Skriving mot den ekte butikken er avslått. Den slås på av eieren (VAREMOTTAK_LIVE_WRITES=1) først når alt er godkjent.",
                      "Writing to the live store is switched off. The owner turns it on (VAREMOTTAK_LIVE_WRITES=1) only once everything is approved.",
                    )}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 font-semibold hover:bg-black/5">
                    {t("Avbryt", "Cancel")}
                  </button>
                  <button
                    onClick={send}
                    disabled={busy || sendable === 0 || liveBlocked || (needsAck && !acknowledged)}
                    className="rounded-lg bg-orange px-4 py-2 font-bold text-cream hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? t("Sender …", "Sending …") : t(`Send ${sendable} varer`, `Send ${sendable} items`)}
                  </button>
                </div>
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "green" | "yellow" | "red" }) {
  const tones = { green: "bg-green-100", yellow: "bg-yellow-100", red: "bg-red-100" } as const;
  return (
    <div className={`rounded-xl px-3 py-2 ${tones[tone]}`}>
      <div className="text-2xl font-extrabold tabular-nums">{value}</div>
      <div className="text-xs font-semibold">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 font-bold">{title}</h3>
      <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-line bg-white p-2">{children}</div>
    </div>
  );
}

function RowLine({ row, reasons, tone }: { row: Row; reasons: string[]; tone: "red" | "yellow" }) {
  const { m } = useTr();
  return (
    <div className="flex gap-2 text-xs">
      <Badge tone={tone}>{row.idx}</Badge>
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{row.name}</span> – {reasons.map((r) => m(r)).join("; ")}
      </span>
    </div>
  );
}
