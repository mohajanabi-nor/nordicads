/**
 * Server-side Sentry: API routes, cron jobs, webhooks, server components, middleware.
 * Loaded once per server instance by Next.js (instrumentation hook). See lib/sentry-options.ts.
 */
import * as Sentry from "@sentry/nextjs";
import { baseOptions } from "./lib/sentry-options";

export async function register() {
  // Same options on both runtimes; the edge one covers middleware.ts.
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(baseOptions());
  }
}

// Next.js calls this for errors thrown while rendering or in route handlers.
export const onRequestError = Sentry.captureRequestError;
