/**
 * Sentry settings shared by the server, edge and browser setups, so an error reads the
 * same wherever it happened.
 *
 * Off until NEXT_PUBLIC_SENTRY_DSN is set (in Vercel): without it every Sentry call is
 * a no-op, so the code is safe to deploy before the Sentry project exists. Off in
 * `next dev` too, unless NEXT_PUBLIC_SENTRY_ENABLE_DEV=1 — a local experiment shouldn't page anyone.
 *
 * Customer email addresses are masked before an event leaves the app (scrub). Log lines
 * and error messages here carry addresses routinely — "Varsel til kari@… feilet" — and
 * the report is just as useful with k***@domain.no.
 */
import type { ErrorEvent } from "@sentry/nextjs";

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

export function maskEmails(s: string): string {
  return s.replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***@${domain}`);
}

/** Every string in the event, however deep, with addresses masked. */
function scrubValue<T>(value: T, depth = 0): T {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") return maskEmails(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubValue(v, depth + 1);
    return out as T;
  }
  return value;
}

export function scrub(event: ErrorEvent): ErrorEvent {
  return scrubValue(event);
}

export function sentryEnabled(): boolean {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return false;
  return process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_SENTRY_ENABLE_DEV === "1";
}

export function baseOptions() {
  return {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    enabled: sentryEnabled(),
    // "production" on Vercel's live deployment, "preview" on branch deploys.
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV,
    // The deployed commit, so an error says which version it came from.
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    // No cookies, IPs or request bodies by default; what's needed is attached on purpose.
    sendDefaultPii: false,
    // Errors only: performance tracing isn't what this is for, and it has its own quota.
    tracesSampleRate: 0,
    beforeSend: scrub,
  };
}
