/**
 * Browser-side Sentry for the dashboard's own pages (the operator's browser).
 * The storefront wishlist reports separately, through /apps/onskeliste/client-error.
 */
import * as Sentry from "@sentry/nextjs";
import { baseOptions } from "./lib/sentry-options";

Sentry.init({
  ...baseOptions(),
  // Chrome's translate and browser extensions throw into the page; not our bugs.
  ignoreErrors: ["ResizeObserver loop", "Non-Error promise rejection captured"],
  denyUrls: [/^chrome-extension:\/\//, /^moz-extension:\/\//],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
