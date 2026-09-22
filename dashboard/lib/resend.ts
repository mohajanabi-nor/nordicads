/**
 * Resend REST client — no SDK, matching how the worker calls Shopify and
 * Anthropic with plain HTTP. The dashboard keeps its three dependencies.
 *
 * Two facts from Resend's docs shape everything here:
 *
 *  - "Emails with attachments cannot be sent using our batching endpoint."
 *    So there is no batching: one HTTPS request per recipient.
 *  - The API accepts an `Idempotency-Key` header, unique per request, valid for
 *    24 h. That is what makes an ambiguous timeout safe to retry and a resumed
 *    campaign incapable of delivering twice.
 *
 * Server-only: reads RESEND_API_KEY and must never reach the browser.
 */

const RESEND_URL = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 30_000;

export interface Attachment {
  filename: string;
  /** Base64-encoded file content. Encode ONCE per campaign, not per recipient. */
  content: string;
}

export interface SendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  attachment?: Attachment | null;
  idempotencyKey: string;
}

/**
 * How the caller should react — the whole point of classifying, rather than just
 * passing the status through:
 *   transient — retry this recipient with backoff
 *   permanent — this address will never work; record and move on
 *   fatal     — stop the campaign; retrying wastes time (bad key, quota gone)
 */
export type SendFailureKind = "transient" | "permanent" | "fatal";

export type SendResult =
  | { ok: true; id: string; dryRun?: boolean }
  | { ok: false; kind: SendFailureKind; status: number; message: string };

export function isDryRun(): boolean {
  return process.env.EMAIL_DRY_RUN === "1";
}

export function emailConfig() {
  return {
    apiKey: process.env.RESEND_API_KEY || "",
    from: process.env.EMAIL_FROM || "",
    replyTo: process.env.EMAIL_REPLY_TO || "post@nordicengros.no",
    ratePerSec: Number(process.env.EMAIL_RATE_PER_SEC || "6"),
  };
}

/** Problems the operator can fix, checked before a campaign starts rather than
 *  failing 500 times in a row. */
export function configProblems(): string[] {
  const cfg = emailConfig();
  const problems: string[] = [];
  if (!isDryRun() && !cfg.apiKey) {
    problems.push("RESEND_API_KEY mangler i dashboard/.env.local");
  }
  if (!cfg.from) {
    problems.push("EMAIL_FROM mangler (f.eks. \"Nordic Engros <nyhetsbrev@nyhetsbrev.nordicengros.no>\")");
  }
  return problems;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resend's documented error names, split by what the caller should do. Codes
 * alone are not enough: 429 means "slow down" for a rate limit but "stop" for a
 * spent daily quota, and retrying the latter just burns the whole campaign.
 */
const FATAL_NAMES = new Set([
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "email_above_quota",
  "missing_api_key",
  "restricted_api_key",
  "suspended_api_key",
  "invalid_permission",
]);

const TRANSIENT_NAMES = new Set([
  "rate_limit_exceeded",
  "concurrent_idempotent_requests",
  "resource_locked",
  "application_error",
  "service_unavailable",
]);

function classify(status: number, name: string): SendFailureKind {
  if (FATAL_NAMES.has(name)) return "fatal";
  if (TRANSIENT_NAMES.has(name)) return "transient";
  if (status === 401 || status === 403) return "fatal";
  if (status === 429) return "transient";
  if (status >= 500) return "transient";
  return "permanent"; // 422 validation, invalid attachment, bad recipient…
}

/** One send attempt. No retries here — the runner owns the retry policy. */
export async function sendOne(input: SendInput): Promise<SendResult> {
  const cfg = emailConfig();

  if (isDryRun()) {
    // Everything except the HTTP call still runs: throttling, logging, resume.
    await sleep(120);
    return { ok: true, id: `dry_${input.idempotencyKey.slice(0, 24)}`, dryRun: true };
  }

  const body: Record<string, unknown> = {
    from: cfg.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
  };
  if (cfg.replyTo) body.reply_to = cfg.replyTo;
  if (input.headers) body.headers = input.headers;
  if (input.attachment) body.attachments = [input.attachment];

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const raw = await res.text();
    let parsed: { id?: string; name?: string; message?: string } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* non-JSON body — fall back to the raw text below */
    }

    if (res.ok && parsed.id) return { ok: true, id: parsed.id };

    return {
      ok: false,
      kind: classify(res.status, parsed.name ?? ""),
      status: res.status,
      message: parsed.message || parsed.name || raw.slice(0, 200) || `HTTP ${res.status}`,
    };
  } catch (err) {
    // Timeout or connection reset: we do NOT know whether Resend accepted it.
    // Transient, and the retry reuses the same Idempotency-Key so a message that
    // did get through is never delivered a second time.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "transient", status: 0, message: `nettverksfeil: ${message}` };
  }
}

/**
 * Fixed-interval scheduler plus a concurrency gate.
 *
 * Resend allows 10 requests/second per team; we run below that so a test-send or
 * a second campaign never pushes the account over. The interval limiter is what
 * actually paces us for small mails; with a large attachment, bandwidth does,
 * and the limiter simply stops binding.
 */
export class RateLimiter {
  private intervalMs: number;
  private nextSlot = 0;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(perSecond: number, private readonly concurrency: number) {
    this.intervalMs = 1000 / Math.max(0.1, perSecond);
  }

  /** After a 429, halve the rate for the remainder of the run. */
  slowDown(): void {
    this.intervalMs = Math.min(this.intervalMs * 2, 5_000);
  }

  private release(): void {
    const next = this.queue.shift();
    // Hand the slot straight to the next waiter so `active` is never double-counted.
    if (next) next();
    else this.active--;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      const now = Date.now();
      const slot = Math.max(now, this.nextSlot);
      this.nextSlot = slot + this.intervalMs;
      const wait = slot - now;
      if (wait > 0) await sleep(wait);
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Mask an address for logs. The log panel keeps 200 lines in browser state, so
 *  a full customer list must never end up there. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  const head = user.slice(0, 1);
  return `${head}${"*".repeat(Math.max(2, user.length - 1))}@${domain}`;
}
