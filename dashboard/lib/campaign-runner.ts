/**
 * The send loop.
 *
 * It used to run detached: the send route fired it and returned, so closing a
 * tab could not stop a campaign. That is exactly right on a machine you own and
 * fatal on a serverless host, where the instance is frozen the moment the
 * response is sent — the loop died before delivering anything while the API
 * reported success. A mail system that says "sent" and sends nothing is the
 * worst failure it can have.
 *
 * So nothing runs detached any more. Work happens inside a request that is
 * waiting for it, in bounded batches:
 *
 *   - the progress stream drives the send while someone is watching, which is
 *     also what makes a campaign start the moment it is created;
 *   - a cron sweep finishes anything left, so closing the tab now delays a
 *     campaign rather than abandoning it.
 *
 * Both call the same function, and a lease stops them sending the same
 * recipient twice. Resend's Idempotency-Key is the second layer under that,
 * covering the case where our own log lost the last write.
 *
 * Server-only.
 */
import { mailableEmails, markSent, recordPermanentFailure } from "./contacts";
import { isAllowedRecipient, maskEmail, RateLimiter, sendOne, type Attachment } from "./resend";
import { logError, logInfo, logWarn } from "./eventlog";
import { campaignHeaders, idempotencyKey } from "./campaign-shared";
import {
  appendRecipient,
  completedEmails,
  readCampaign,
  readRecipients,
  type CampaignManifest,
} from "./campaign-store";
import { readDropFile } from "./drops";
import { clearAppState, getAppState, setAppState } from "./app-state";
import { sbRpc, sbSelect } from "./supabase";

export interface RunnerEvent {
  event: "start" | "step" | "progress" | "log" | "done" | "error";
  data: Record<string, unknown>;
}

export type Emit = (event: RunnerEvent["event"], data: Record<string, unknown>) => void;

const MAX_ATTEMPTS = 3;
/** Lease TTL: long enough to cover a batch, short enough that a driver which
 *  dies mid-send does not block the campaign for long. */
const LEASE_SECONDS = 180;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function leaseKey(campaignId: string): string {
  return `campaign.send.${campaignId}`;
}

function cancelKey(campaignId: string): string {
  return `campaign.cancelled.${campaignId}`;
}

/**
 * Stop a campaign that is part-way through.
 *
 * Recorded as its own row rather than a column on the campaign, because a
 * campaign is immutable by design — the manifest a resume replays from must
 * never change. Cancelling is a fact ABOUT the campaign, not a revision of it.
 */
export async function cancelCampaign(campaignId: string): Promise<void> {
  await setAppState(cancelKey(campaignId), { at: new Date().toISOString() });
}

export async function isCancelled(campaignId: string): Promise<boolean> {
  try {
    return Boolean(await getAppState<{ at?: string }>(cancelKey(campaignId)));
  } catch {
    return false;
  }
}

/** Undo a cancellation, so an explicit resume can override it. */
export async function clearCancel(campaignId: string): Promise<void> {
  await clearAppState(cancelKey(campaignId));
}

export interface CampaignProgress {
  sent: number;
  failed: number;
  skipped: number;
  total: number;
  remaining: number;
  done: boolean;
}

/** Counts read from the recipient log — the only record that survives an
 *  instance disappearing mid-send. */
export async function campaignProgress(manifest: CampaignManifest): Promise<CampaignProgress> {
  const records = await readRecipients(manifest.id);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of records) {
    if (r.status === "sent") sent++;
    else if (r.status === "failed") failed++;
    else skipped++;
  }
  const handled = new Set(records.map((r) => r.email));
  const remaining = manifest.recipients.filter((e) => !handled.has(e)).length;
  return {
    sent,
    failed,
    skipped,
    total: manifest.recipients.length,
    remaining,
    done: remaining === 0,
  };
}

export interface BatchOptions {
  /** Stop starting new sends once this much time has gone. The caller's own
   *  deadline is always shorter than a campaign might need. */
  budgetMs: number;
  signal?: AbortSignal;
  emit?: Emit;
}

export interface BatchResult extends CampaignProgress {
  /** False when another driver holds the lease — not an error, just "later". */
  ran: boolean;
  /** True when the whole campaign is finished, not merely this batch. */
  complete: boolean;
  aborted: boolean;
}

const EMPTY: CampaignProgress = {
  sent: 0,
  failed: 0,
  skipped: 0,
  total: 0,
  remaining: 0,
  done: false,
};

/**
 * Send as much of a campaign as fits in the budget.
 *
 * Safe to call repeatedly and from more than one place: the recipient log is
 * the source of truth for what has already been attempted, so a second call
 * continues where the first stopped rather than starting over.
 */
export async function runCampaignBatch(
  campaignId: string,
  opts: BatchOptions,
): Promise<BatchResult> {
  const emit: Emit = opts.emit ?? (() => undefined);
  const manifest = await readCampaign(campaignId);
  if (!manifest) return { ...EMPTY, ran: false, complete: false, aborted: false };

  const before = await campaignProgress(manifest);
  if (before.done) return { ...before, ran: false, complete: true, aborted: false };

  // Cancelled campaigns are left exactly as they are — the recipients already
  // contacted stay recorded, the rest are simply never attempted.
  if (await isCancelled(campaignId)) {
    return { ...before, ran: false, complete: false, aborted: true };
  }

  // One driver at a time. Without this the stream and the cron sweep could both
  // pick up the same recipient in the gap before either records it.
  let claimed = false;
  try {
    claimed = await sbRpc<boolean>("try_claim_lease", {
      p_key: leaseKey(campaignId),
      p_seconds: LEASE_SECONDS,
    });
  } catch {
    claimed = false;
  }
  if (!claimed) return { ...before, ran: false, complete: false, aborted: false };

  try {
    return await sendLoop(manifest, before, opts, emit);
  } finally {
    // Released even on abort, so closing a tab hands the campaign straight back
    // to the cron sweep instead of stalling it until the lease expires.
    await sbRpc("release_lease", { p_key: leaseKey(campaignId) }).catch(() => undefined);
  }
}

async function sendLoop(
  manifest: CampaignManifest,
  before: CampaignProgress,
  opts: BatchOptions,
  emit: Emit,
): Promise<BatchResult> {
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > opts.budgetMs;

  // Rebuilt from the drop the campaign was created with, so a resumed send is
  // byte-identical to what the first recipients received.
  let attachment: Attachment | null = null;
  if (manifest.attachmentName && manifest.dropDir) {
    const pdf = await readDropFile(manifest.dropDir, "katalog.pdf");
    if (!pdf) {
      const message = `katalog.pdf mangler i ${manifest.dropDir} — kan ikke sende med vedlegg`;
      await logError("campaign", "campaign.attachmentMissing", message, {
        campaignId: manifest.id,
      });
      emit("error", { message });
      return { ...before, ran: true, complete: false, aborted: false };
    }
    attachment = { filename: manifest.attachmentName, content: pdf.toString("base64") };
  }

  const ratePerSec = Number(process.env.EMAIL_RATE_PER_SEC || "6");
  // With a multi-MB attachment the upload, not the rate limit, sets the pace —
  // one at a time keeps memory flat and avoids saturating a normal office line.
  const limiter = new RateLimiter(ratePerSec, attachment ? 1 : 3);

  const handled = await completedEmails(manifest.id);
  const queue = manifest.recipients.filter((e) => !handled.has(e));
  const mailable = await mailableEmails();

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const sentEmails: string[] = [];
  const permanentlyFailed: string[] = [];
  let fatal: string | null = null;
  let aborted = false;

  emit("start", {
    campaignId: manifest.id,
    total: before.total,
    remaining: queue.length,
    dryRun: manifest.dryRun,
    attached: Boolean(attachment),
  });
  const alreadyDone = before.sent + before.failed + before.skipped;
  if (alreadyDone > 0) {
    emit("log", { line: `Fortsetter — ${alreadyDone} av ${before.total} var allerede behandlet.` });
  }
  emit("step", { key: "send", label: "Sender", status: "active" });

  let lastProgressAt = 0;
  const progress = (current?: string, force = false) => {
    const now = Date.now();
    // Throttle: 500 frames at full speed would flood the stream for no benefit.
    if (!force && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    emit("progress", {
      sent: before.sent + sent,
      failed: before.failed + failed,
      skipped: before.skipped + skipped,
      total: before.total,
      current: current ? maskEmail(current) : undefined,
    });
  };

  for (const email of queue) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    if (outOfTime()) break;
    // Checked per recipient so a cancel lands within one send, not one batch.
    if (await isCancelled(manifest.id)) {
      aborted = true;
      emit("log", { line: "Avbrutt av operatør." });
      break;
    }

    // While an allowlist is set, anyone not on it is skipped and SAID to be
    // skipped — never recorded as sent, which would be a lie in the one log
    // that answers "did Kari get it?".
    if (!isAllowedRecipient(email)) {
      skipped++;
      await appendRecipient(manifest.id, {
        email,
        status: "skipped",
        at: new Date().toISOString(),
        error: "ikke i EMAIL_ALLOWLIST (testmodus)",
        attempt: 0,
      });
      emit("log", { line: `Hoppet over ${maskEmail(email)} — ikke i testlisten.` });
      progress(email);
      continue;
    }

    // Honour an unsubscribe that arrived after the campaign started.
    if (!mailable.has(email)) {
      skipped++;
      await appendRecipient(manifest.id, {
        email,
        status: "skipped",
        at: new Date().toISOString(),
        error: "avmeldt",
        attempt: 0,
      });
      emit("log", { line: `Hoppet over ${maskEmail(email)} — avmeldt.` });
      progress(email);
      continue;
    }

    let attempt = 0;
    let settled = false;

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
        emit("log", { line: `Feilet ${maskEmail(email)}: ${result.message}`, stderr: true });
        break;
      }

      // Transient: back off, and if we were rate-limited, slow the whole run
      // down rather than walking into the same wall on the next recipient.
      if (result.status === 429) limiter.slowDown();
      await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
    }

    if (fatal) break;
    progress(email);
  }

  progress(undefined, true);

  // Best-effort bookkeeping; never allowed to fail the run.
  try {
    if (sentEmails.length) await markSent(sentEmails);
    if (permanentlyFailed.length) {
      const unsubscribed = await recordPermanentFailure(permanentlyFailed);
      for (const email of unsubscribed) {
        // Consent changed without a human deciding it — that must never be
        // silent, which is the whole reason the Logg tab exists.
        await logWarn(
          "campaign",
          "contact.autoUnsubscribed",
          `Meldt av automatisk etter permanent avvisning: ${email}`,
          { email, campaignId: manifest.id },
        );
      }
      if (unsubscribed.length) {
        emit("log", {
          line: `${unsubscribed.length} adresser ble meldt av — permanent avvist av Resend.`,
        });
      }
    }
  } catch {
    /* ignore */
  }

  const after = await campaignProgress(manifest);

  if (fatal) {
    const message =
      `Utsendingen ble stoppet: ${fatal}. ` +
      "Ingen flere e-poster sendes. Sjekk API-nøkkel, domeneverifisering og kvote i Resend.";
    await logError("campaign", "campaign.aborted", message, {
      campaignId: manifest.id,
      sent: after.sent,
      remaining: after.remaining,
    });
    emit("error", { message });
    return { ...after, ran: true, complete: false, aborted };
  }

  if (after.done) {
    emit("step", { key: "send", label: "Sender", status: "done" });
    const label = manifest.dryRun ? " (testmodus — ingenting ble sendt)" : "";
    const summary = `${after.sent} sendt · ${after.failed} feilet · ${after.skipped} hoppet over av ${after.total}`;
    const log = after.failed > 0 ? logWarn : logInfo;
    await log("campaign", "campaign.finished", `Kampanje ferdig${label}: ${summary}`, {
      campaignId: manifest.id,
      dryRun: manifest.dryRun,
    });
    emit("done", {
      campaignId: manifest.id,
      sent: after.sent,
      failed: after.failed,
      skipped: after.skipped,
      total: after.total,
      dryRun: manifest.dryRun,
    });
  } else if (!aborted) {
    // Out of budget, not out of work. Say so plainly rather than looking done.
    emit("log", {
      line: `Pause — ${after.remaining} gjenstår. Fortsetter automatisk innen et minutt.`,
    });
  }

  return { ...after, ran: true, complete: after.done, aborted };
}

/** Campaigns with recipients still unprocessed, newest first — the cron sweep's
 *  work list. Only recent campaigns are considered; an old one that was
 *  abandoned deliberately should not spring back to life. */
export async function unfinishedCampaigns(limit = 3): Promise<string[]> {
  const rows = await sbSelect<{ id: string }>("campaigns", {
    select: "id",
    order: "created_at.desc",
    limit: 20,
  });
  const out: string[] = [];
  for (const row of rows) {
    const manifest = await readCampaign(row.id);
    if (!manifest) continue;
    const p = await campaignProgress(manifest);
    if (!p.done && !(await isCancelled(row.id))) out.push(row.id);
    if (out.length >= limit) break;
  }
  return out;
}
