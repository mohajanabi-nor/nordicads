/**
 * The send loop.
 *
 * It deliberately does NOT live inside the request that starts it. The existing
 * SSE routes (api/select) kill their work when the client disconnects, which is
 * right for a render you can just run again — and wrong for a campaign, where
 * closing a tab halfway through would leave half a customer list mailed. So the
 * runner is registered on globalThis and the SSE route is a pure observer:
 * attaching and detaching a viewer never touches the send.
 *
 * (globalThis rather than a module-level map so Next.js dev hot-reload cannot
 * orphan a campaign mid-flight — the same idiom as the picker cache in
 * app/api/products/route.ts.)
 *
 * Server-only.
 */
import { mailableEmails, markSent, recordPermanentFailure } from "./contacts";
import { logError, logInfo, logWarn } from "./eventlog";
import { campaignHeaders, idempotencyKey } from "./campaign-shared";
import {
  appendRecipient,
  completedEmails,
  readCampaign,
  type CampaignManifest,
} from "./campaign-store";
import { type Attachment, maskEmail, RateLimiter, sendOne } from "./resend";

export interface RunnerEvent {
  event: "start" | "step" | "progress" | "log" | "done" | "error";
  data: Record<string, unknown>;
}

interface Runner {
  id: string;
  /** Replayed to any viewer that attaches late, so a reloaded page is not blank. */
  buffer: RunnerEvent[];
  subscribers: Set<(e: RunnerEvent) => void>;
  finished: boolean;
  cancelled: boolean;
}

const _g = globalThis as unknown as { _campaignRunners?: Map<string, Runner> };
const runners = (_g._campaignRunners ??= new Map<string, Runner>());

const MAX_BUFFER = 600; // plenty for 500 recipients + stages, bounded memory
const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emit(runner: Runner, event: RunnerEvent["event"], data: Record<string, unknown>): void {
  const frame: RunnerEvent = { event, data };
  runner.buffer.push(frame);
  if (runner.buffer.length > MAX_BUFFER) runner.buffer.shift();
  // forEach, not for..of: the project's tsconfig target predates Set iteration.
  runner.subscribers.forEach((fn) => {
    try {
      fn(frame);
    } catch {
      // A broken viewer must never disturb the send.
    }
  });
}

export function getRunner(id: string): Runner | undefined {
  return runners.get(id);
}

/** Attach a viewer: replay what already happened, then tail. Returns unsubscribe. */
export function subscribe(id: string, fn: (e: RunnerEvent) => void): (() => void) | null {
  const runner = runners.get(id);
  if (!runner) return null;
  for (const frame of runner.buffer) fn(frame);
  if (runner.finished) return () => undefined;
  runner.subscribers.add(fn);
  return () => runner.subscribers.delete(fn);
}

export function cancelCampaign(id: string): boolean {
  const runner = runners.get(id);
  if (!runner || runner.finished) return false;
  runner.cancelled = true;
  return true;
}

/** Mailable addresses, re-read periodically so an unsubscribe that lands
 *  mid-campaign is honoured for the recipients still to come. Uses the shared
 *  isMailable() rule, so this can never disagree with what the picker showed. */
function makeMailableLookup(ttlMs = 2000) {
  let cache: Set<string> | null = null;
  let at = 0;
  return async (): Promise<Set<string>> => {
    const now = Date.now();
    if (!cache || now - at > ttlMs) {
      // Asks the database for the mailable set directly rather than reading the
      // whole list and filtering — the rule is the same one isMailable encodes.
      cache = await mailableEmails();
      at = now;
    }
    return cache;
  };
}

/**
 * Start (or resume) sending. Returns as soon as the loop is registered; the work
 * continues in the background and is observed via subscribe().
 */
export function startCampaign(manifest: CampaignManifest, attachment: Attachment | null): void {
  if (runners.get(manifest.id) && !runners.get(manifest.id)!.finished) return; // already running

  const runner: Runner = {
    id: manifest.id,
    buffer: [],
    subscribers: new Set(),
    finished: false,
    cancelled: false,
  };
  runners.set(manifest.id, runner);

  // Fire and forget — deliberately not awaited by the caller.
  void runLoop(runner, manifest, attachment);
}

async function runLoop(
  runner: Runner,
  manifest: CampaignManifest,
  attachment: Attachment | null,
): Promise<void> {
  const started = Date.now();
  const ratePerSec = Number(process.env.EMAIL_RATE_PER_SEC || "6");
  // With a multi-MB attachment the upload, not the rate limit, sets the pace —
  // one at a time keeps memory flat and avoids saturating a normal office line.
  const limiter = new RateLimiter(ratePerSec, attachment ? 1 : 3);
  const mailableNow = makeMailableLookup();
  /** Addresses Resend rejected outright — unsubscribed at the end of the run. */
  const permanentlyFailed: string[] = [];

  // Resume: anything with a terminal outcome already recorded is not retried.
  const done = await completedEmails(manifest.id);
  const queue = manifest.recipients.filter((e) => !done.has(e));

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const total = manifest.recipients.length;
  const alreadyDone = total - queue.length;

  emit(runner, "start", {
    campaignId: manifest.id,
    total,
    remaining: queue.length,
    dryRun: manifest.dryRun,
    attached: Boolean(attachment),
  });
  if (alreadyDone > 0) {
    emit(runner, "log", { line: `Fortsetter — ${alreadyDone} av ${total} var allerede behandlet.` });
  }
  emit(runner, "step", { key: "send", label: "Sender", status: "active" });

  let lastProgressAt = 0;
  const sentEmails: string[] = [];

  const progress = (current?: string, force = false) => {
    const now = Date.now();
    // Throttle: 500 frames at full speed would flood the stream for no benefit.
    if (!force && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    emit(runner, "progress", {
      sent: sent + alreadyDone,
      failed,
      skipped,
      total,
      current: current ? maskEmail(current) : undefined,
    });
  };

  for (const email of queue) {
    if (runner.cancelled) {
      emit(runner, "log", { line: "Avbrutt av operatør." });
      break;
    }

    // Honour an unsubscribe that arrived after the campaign started.
    if (!(await mailableNow()).has(email)) {
      skipped++;
      await appendRecipient(manifest.id, {
        email,
        status: "skipped",
        at: new Date().toISOString(),
        error: "avmeldt",
        attempt: 0,
      });
      emit(runner, "log", { line: `Hoppet over ${maskEmail(email)} — avmeldt.` });
      progress(email);
      continue;
    }

    let attempt = 0;
    let settled = false;
    let fatal: string | null = null;

    while (attempt < MAX_ATTEMPTS && !settled) {
      attempt++;
      const result = await limiter.run(() =>
        sendOne({
          to: email,
          subject: manifest.subject,
          html: manifest.html,
          text: manifest.text,
          headers: campaignHeaders(),
          attachment,
          // Same key on every retry AND on a later resume: Resend will not
          // deliver twice within 24 h even if our log lost the last write.
          idempotencyKey: idempotencyKey(manifest.id, email),
        }),
      );

      if (result.ok) {
        sent++;
        sentEmails.push(email);
        settled = true;
        await appendRecipient(manifest.id, {
          email,
          status: "sent",
          at: new Date().toISOString(),
          resendId: result.id,
          attempt,
        });
        break;
      }

      if (result.kind === "fatal") {
        fatal = `${result.message} (HTTP ${result.status})`;
        break;
      }

      if (result.kind === "permanent" || attempt >= MAX_ATTEMPTS) {
        failed++;
        settled = true;
        // A permanent rejection is the only bounce signal available without a
        // webhook, so it is worth acting on: the address comes off the list
        // rather than being retried on every future campaign.
        if (result.kind === "permanent") permanentlyFailed.push(email);
        await appendRecipient(manifest.id, {
          email,
          status: "failed",
          at: new Date().toISOString(),
          error: `${result.message} (HTTP ${result.status})`,
          attempt,
        });
        emit(runner, "log", {
          line: `Feilet ${maskEmail(email)}: ${result.message}`,
          stderr: true,
        });
        break;
      }

      // Transient: back off, and if we were rate-limited, slow the whole run
      // down rather than walking into the same wall on the next recipient.
      if (result.status === 429) limiter.slowDown();
      await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
    }

    if (fatal) {
      const message =
        `Utsendingen ble stoppet: ${fatal}. ` +
        "Ingen flere e-poster sendes. Sjekk API-nøkkel, domeneverifisering og kvote i Resend.";
      logError("campaign", "campaign.aborted", message, {
        campaignId: manifest.id,
        sent: sent + alreadyDone,
        remaining: queue.length - (sent + failed + skipped),
      });
      emit(runner, "error", { message });
      break;
    }
    progress(email);
  }

  progress(undefined, true);
  emit(runner, "step", { key: "send", label: "Sender", status: "done" });

  // Best-effort bookkeeping; never allowed to fail the run.
  try {
    if (sentEmails.length) await markSent(sentEmails);
    if (permanentlyFailed.length) {
      const unsubscribed = await recordPermanentFailure(permanentlyFailed);
      for (const email of unsubscribed) {
        // Consent changed without a human deciding it — that must never be
        // silent, which is the whole reason the Logg tab exists.
        logWarn(
          "campaign",
          "contact.autoUnsubscribed",
          `Meldt av automatisk etter permanent avvisning: ${email}`,
          { email, campaignId: manifest.id },
        );
      }
      if (unsubscribed.length) {
        emit(runner, "log", {
          line: `${unsubscribed.length} adresser ble meldt av — permanent avvist av Resend.`,
        });
      }
    }
  } catch {
    /* ignore */
  }

  const label = manifest.dryRun ? " (testmodus — ingenting ble sendt)" : "";
  const summary =
    `${sent + alreadyDone} sendt · ${failed} feilet · ${skipped} hoppet over av ${total}`;
  if (failed > 0) {
    logWarn("campaign", "campaign.finished", `Kampanje ferdig${label}: ${summary}`, {
      campaignId: manifest.id,
      dryRun: manifest.dryRun,
    });
  } else {
    logInfo("campaign", "campaign.finished", `Kampanje ferdig${label}: ${summary}`, {
      campaignId: manifest.id,
      dryRun: manifest.dryRun,
    });
  }

  emit(runner, "done", {
    campaignId: manifest.id,
    sent: sent + alreadyDone,
    failed,
    skipped,
    total,
    durationMs: Date.now() - started,
    dryRun: manifest.dryRun,
  });

  runner.finished = true;
  runner.subscribers.clear();
}

/** Resume a campaign that was interrupted. Reuses the frozen manifest, so the
 *  message is identical to what the first recipients received. */
export async function resumeCampaign(id: string, attachment: Attachment | null): Promise<boolean> {
  const manifest = await readCampaign(id);
  if (!manifest) return false;
  const existing = runners.get(id);
  if (existing && !existing.finished) return false; // already running
  runners.delete(id);
  startCampaign(manifest, attachment);
  return true;
}
