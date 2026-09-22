/**
 * The daily Shopify sync.
 *
 * Deliberately NOT a cron job or a system service: the dashboard is a localhost
 * app on one machine, so anything scheduled outside it would run only when
 * someone happened to have it open anyway. Instead this starts lazily on the
 * first API request and CATCHES UP — if the machine was asleep at 03:00, the
 * sync runs when the dashboard is next opened. That makes "every 24 hours" mean
 * something useful on a laptop rather than something aspirational.
 *
 * Server-only.
 */
import fs from "node:fs";
import path from "node:path";

import {
  EMAIL_STATE_DIR,
  syncFromShopify,
  type ShopifyCustomerRow,
  type SyncOutcome,
} from "./contacts";
import { logError, logInfo, logWarn } from "./eventlog";
import { runWorker } from "./worker";

const STATE_FILE = path.join(EMAIL_STATE_DIR, "sync-state.json");
const SENTINEL = "CUSTOMERS_JSON ";

/** How often to check whether a sync is due. The interval itself is 24 h; this
 *  is just the heartbeat, kept short enough that a catch-up is prompt. */
const TICK_MS = 30 * 60 * 1000;

/** Back off rather than logging the same failure every half hour. */
const RETRY_AFTER_FAILURE_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000];

/**
 * A sync that returns far fewer customers than last time is far more likely to
 * be a truncated fetch than a real mass deletion. Below this ratio we refuse to
 * treat "absent" as "deleted".
 */
const COMPLETENESS_RATIO = 0.8;

interface SyncState {
  lastSyncAt: string | null;
  lastResult: string | null;
  lastCustomerCount: number | null;
  consecutiveFailures: number;
}

interface Runtime {
  timer?: NodeJS.Timeout;
  running: boolean;
}

const _g = globalThis as unknown as { _syncRuntime?: Runtime };
const runtime = (_g._syncRuntime ??= { running: false });

function readState(): SyncState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastSyncAt: null, lastResult: null, lastCustomerCount: null, consecutiveFailures: 0 };
  }
}

function writeState(state: SyncState): void {
  try {
    fs.mkdirSync(EMAIL_STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* a lost timestamp costs one extra sync, nothing more */
  }
}

export function isEnabled(): boolean {
  return process.env.AUTO_SYNC_ENABLED !== "0"; // on unless explicitly disabled
}

function intervalMs(): number {
  const hours = Number(process.env.AUTO_SYNC_INTERVAL_HOURS || "24");
  return Math.max(1, hours) * 60 * 60 * 1000;
}

/** When the next sync is due, accounting for failure backoff. */
function dueAt(state: SyncState): number {
  if (!state.lastSyncAt) return 0; // never synced — due immediately
  const last = new Date(state.lastSyncAt).getTime();
  if (state.consecutiveFailures > 0) {
    const idx = Math.min(state.consecutiveFailures - 1, RETRY_AFTER_FAILURE_MS.length - 1);
    return last + RETRY_AFTER_FAILURE_MS[idx];
  }
  return last + intervalMs();
}

export function syncStatus() {
  const state = readState();
  return {
    enabled: isEnabled(),
    running: runtime.running,
    lastSyncAt: state.lastSyncAt,
    lastResult: state.lastResult,
    nextDueAt: isEnabled() ? new Date(dueAt(state)).toISOString() : null,
    intervalHours: intervalMs() / 3_600_000,
  };
}

/**
 * Fetch from Shopify and merge. Shared by the scheduler and the manual button,
 * so both go through the same lock, the same completeness guard and the same
 * logging — a manual sync must not be able to do something the automatic one
 * cannot, or vice versa.
 */
export async function runSync(trigger: "auto" | "manual"): Promise<SyncOutcome> {
  if (runtime.running) throw new Error("En synkronisering kjører allerede.");
  runtime.running = true;
  const startedAt = Date.now();
  const state = readState();

  try {
    logInfo("sync", "sync.started", `Synkronisering startet (${trigger}).`);
    const { code, stdout, stderr } = await runWorker(["customers"], 240_000);
    if (code !== 0) {
      throw new Error((stderr || stdout).trim().slice(-500) || `worker exited ${code}`);
    }
    const line = stdout.split("\n").find((l) => l.startsWith(SENTINEL));
    if (!line) throw new Error("Fant ingen CUSTOMERS_JSON i svaret fra worker.");

    const payload = JSON.parse(line.slice(SENTINEL.length)) as {
      customers?: ShopifyCustomerRow[];
      fetched?: number;
      with_email?: number;
    };
    const rows = payload.customers ?? [];
    const fetched = payload.fetched ?? rows.length;

    // The completeness guard. Deleting/unsubscribing on the strength of a
    // partial fetch is the one mistake here that is expensive to undo.
    const previous = state.lastCustomerCount;
    const complete = previous === null || fetched >= previous * COMPLETENESS_RATIO;
    if (!complete) {
      logWarn(
        "sync",
        "sync.incomplete",
        `Shopify returnerte ${fetched} kunder mot ${previous} sist — ` +
          "for stort fall til å stole på. Ingen ble merket som borte.",
        { fetched, previous },
      );
    }

    const day = new Date().toISOString().slice(0, 10);
    // noEmail is counted per row inside syncFromShopify — the worker now emits
    // emailless customers too. Seeding it from (fetched - with_email) as well
    // double-counted them and broke the reconciliation.
    const outcome = await syncFromShopify(rows, `shopify-${day}`, { complete });

    // Per-row findings: invalid addresses, customers with no email, changed
    // addresses, vanished customers. This is what makes "nothing was skipped
    // silently" verifiable after the fact.
    for (const n of outcome.notices) {
      (n.level === "warn" ? logWarn : logInfo)("sync", n.event, n.message, n.data);
    }

    const summary =
      `${outcome.added} nye · ${outcome.skippedExisting} kjente · ` +
      `${outcome.emailChanged} adresseendringer · ${outcome.markedMissing} borte · ` +
      `${outcome.flaggedInvalid} ugyldige · ${outcome.noEmail} uten e-post`;
    logInfo("sync", "sync.finished", `Synkronisering ferdig (${trigger}): ${summary}`, {
      fetched,
      durationMs: Date.now() - startedAt,
      complete,
    });

    writeState({
      lastSyncAt: new Date().toISOString(),
      lastResult: summary,
      lastCustomerCount: complete ? fetched : previous,
      consecutiveFailures: 0,
    });
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeState({
      ...state,
      lastSyncAt: new Date().toISOString(),
      lastResult: `Feilet: ${message.slice(0, 200)}`,
      consecutiveFailures: state.consecutiveFailures + 1,
    });
    logError("sync", "sync.failed", `Synkronisering feilet (${trigger}): ${message}`, {
      trigger,
      consecutiveFailures: state.consecutiveFailures + 1,
    });
    throw err;
  } finally {
    runtime.running = false;
  }
}

function tick(): void {
  if (!isEnabled() || runtime.running) return;
  const state = readState();
  if (Date.now() < dueAt(state)) return;
  // Fire and forget: a sync takes tens of seconds and must never sit in front of
  // a page load. Failures are recorded by runSync itself.
  void runSync("auto").catch(() => undefined);
}

/**
 * Start the scheduler once per process. Called from the contacts route rather
 * than an instrumentation hook, which in Next 14 would need
 * `experimental.instrumentationHook` in next.config — and opening the dashboard
 * is itself a request, so there is nothing to gain from the extra config.
 */
export function ensureScheduler(): void {
  if (runtime.timer || !isEnabled()) return;
  runtime.timer = setInterval(tick, TICK_MS);
  // Node keeps the process alive for pending timers; this one should not.
  runtime.timer.unref?.();
  logInfo("scheduler", "scheduler.started", "Automatisk synkronisering er aktiv.", {
    intervalHours: intervalMs() / 3_600_000,
  });
  tick(); // catch up immediately if a sync is already overdue
}
