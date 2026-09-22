/**
 * Receive a fetched Shopify customer list and merge it.
 *
 * Called by the GitHub Actions runner, not a browser. The split is deliberate:
 * the runner owns FETCHING (paginated GraphQL with a version-dependent field
 * spelling — logic not worth maintaining twice), and this owns DECIDING, because
 * consent may only ever be tightened and that rule needs exactly one home.
 *
 * Authenticated with the shared worker token rather than a session, since the
 * caller is a machine. Listed as an open route in the middleware for that
 * reason — open to the gate, not open to the world.
 */
import { syncFromShopify, type ShopifyCustomerRow } from "@/lib/contacts";
import { logError, logInfo, logWarn } from "@/lib/eventlog";
import { setAppState, getAppState } from "@/lib/app-state";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * A fetch returning far fewer customers than last time is far more likely to be
 * truncated than a real mass deletion. Below this ratio we refuse to treat
 * "absent" as "deleted" — unsubscribing hundreds of people on bad evidence is
 * the one mistake here that is expensive to undo.
 */
const COMPLETENESS_RATIO = 0.8;
const STATE_KEY = "sync.state";

interface SyncState {
  lastSyncAt: string | null;
  lastResult: string | null;
  lastCustomerCount: number | null;
  consecutiveFailures: number;
}

function authorized(req: Request): boolean {
  const expected = process.env.WORKER_SERVICE_TOKEN || "";
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  // Length check first so the comparison below cannot be a timing oracle.
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "ugyldig token" }, { status: 401 });
  }

  let payload: {
    customers?: ShopifyCustomerRow[];
    fetched?: number;
    store_domain?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "ugyldig JSON" }, { status: 400 });
  }

  const rows = payload.customers ?? [];
  const fetched = payload.fetched ?? rows.length;

  const state = (await getAppState<SyncState>(STATE_KEY)) ?? {
    lastSyncAt: null,
    lastResult: null,
    lastCustomerCount: null,
    consecutiveFailures: 0,
  };

  const previous = state.lastCustomerCount;
  const complete = previous === null || fetched >= previous * COMPLETENESS_RATIO;
  if (!complete) {
    await logWarn(
      "sync",
      "sync.incomplete",
      `Shopify returnerte ${fetched} kunder mot ${previous} sist — ` +
        "for stort fall til å stole på. Ingen ble merket som borte.",
      { fetched, previous },
    );
  }

  try {
    const day = new Date().toISOString().slice(0, 10);
    const outcome = await syncFromShopify(rows, `shopify-${day}`, { complete });

    // Per-row findings: invalid addresses, customers with no email, changed
    // addresses, vanished customers. This is what makes "nothing was skipped
    // silently" verifiable after the fact.
    for (const n of outcome.notices) {
      await (n.level === "warn" ? logWarn : logInfo)("sync", n.event, n.message, n.data);
    }

    const summary =
      `${outcome.added} nye · ${outcome.skippedExisting} kjente · ` +
      `${outcome.emailChanged} adresseendringer · ${outcome.markedMissing} borte · ` +
      `${outcome.flaggedInvalid} ugyldige · ${outcome.noEmail} uten e-post`;

    await logInfo("sync", "sync.finished", `Synkronisering ferdig: ${summary}`, {
      fetched,
      complete,
    });

    await setAppState<SyncState>(STATE_KEY, {
      lastSyncAt: new Date().toISOString(),
      lastResult: summary,
      lastCustomerCount: complete ? fetched : previous,
      consecutiveFailures: 0,
    });

    return Response.json({ ok: true, summary, ...outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setAppState<SyncState>(STATE_KEY, {
      ...state,
      lastSyncAt: new Date().toISOString(),
      lastResult: `Feilet: ${message.slice(0, 200)}`,
      consecutiveFailures: state.consecutiveFailures + 1,
    });
    await logError("sync", "sync.failed", `Synkronisering feilet: ${message}`, {
      consecutiveFailures: state.consecutiveFailures + 1,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
