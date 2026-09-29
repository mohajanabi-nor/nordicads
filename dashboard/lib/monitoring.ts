/**
 * Telling Sentry about failures the code already handles.
 *
 * Most failures here are caught on purpose — a campaign keeps going when one address
 * fails, a webhook answers 200 so Shopify doesn't retry into an outage — and written
 * to the Logg tab (lib/eventlog.ts). Caught means Sentry never sees them on its own, so
 * logEvent hands errors (and the few warnings that need a person) to report() here.
 *
 * The same failure repeating — a cron job every five minutes against a Supabase that's
 * down — is sent once per ten minutes per instance, not every time, so one outage can't
 * spend the month's free quota. Sentry groups the rest.
 *
 * Server-only.
 */
import * as Sentry from "@sentry/nextjs";

const THROTTLE_MS = 10 * 60 * 1000;
const lastSent = new Map<string, number>();

/** Warnings that mean "someone should look", not "worth knowing". */
const ALERTING_WARNINGS = new Set([
  "wishlist.alertFailed", // an alert email to a customer failed
  "wishlist.dropHeld", // a >70 % price cut held back: check the price in Shopify
  "attachment.uploadFailed",
]);

/**
 * Wait (briefly) for queued reports to leave. A serverless function can be frozen right
 * after it responds, taking unsent reports with it. Never throws, whatever the runtime.
 */
export async function flushReports(timeoutMs = 2000): Promise<void> {
  try {
    if (typeof Sentry.flush === "function") await Sentry.flush(timeoutMs);
  } catch {
    /* a report that didn't make it must not become a second failure */
  }
}

export function shouldReport(level: "info" | "warn" | "error", event: string): boolean {
  return level === "error" || (level === "warn" && ALERTING_WARNINGS.has(event));
}

/**
 * An error from the wishlist script on nordicengros.com, sent by the shopper's browser
 * through the App Proxy (/apps/onskeliste/client-error). Only our own script reports —
 * the theme's and other apps' errors never reach this — and each browser sends at most
 * a few per page view. Throttled per distinct error here as well.
 */
export function reportStorefrontError(e: {
  message: string;
  stack?: string;
  where?: string;
  page?: string;
  userAgent?: string;
  loggedIn: boolean;
}): void {
  try {
    const key = `storefront:${e.where}:${e.message}`;
    const now = Date.now();
    if (now - (lastSent.get(key) ?? 0) < THROTTLE_MS) return;
    lastSent.set(key, now);

    const err = new Error(e.message);
    err.name = "StorefrontError";
    if (e.stack) err.stack = `StorefrontError: ${e.message}\n${e.stack}`;
    Sentry.withScope((scope) => {
      scope.setTag("source", "storefront");
      scope.setTag("where", e.where ?? "unknown");
      scope.setTag("logged_in", e.loggedIn ? "yes" : "no");
      scope.setFingerprint(["storefront", e.where ?? "unknown", e.message]);
      scope.setContext("storefront", { page: e.page, userAgent: e.userAgent, where: e.where });
      Sentry.captureException(err);
    });
  } catch {
    /* never let a report fail the request */
  }
}

export function report(
  level: "warn" | "error",
  source: string,
  event: string,
  message: string,
  data?: Record<string, unknown>,
  error?: unknown,
): void {
  try {
    const key = `${source}:${event}`;
    const now = Date.now();
    if (now - (lastSent.get(key) ?? 0) < THROTTLE_MS) return;
    lastSent.set(key, now);

    Sentry.withScope((scope) => {
      scope.setLevel(level === "error" ? "error" : "warning");
      scope.setTag("source", source);
      scope.setTag("event", event);
      // Same source+event is one issue in Sentry, whatever the message details say.
      scope.setFingerprint([source, event]);
      if (data) scope.setContext("details", data);
      if (error instanceof Error) {
        scope.setExtra("logMessage", message);
        Sentry.captureException(error);
      } else {
        Sentry.captureMessage(`${event}: ${message}`);
      }
    });
  } catch {
    /* reporting must never break the thing it reports on */
  }
}
