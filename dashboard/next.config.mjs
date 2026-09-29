// Since @sentry/nextjs v11 the build wrapper lives in its own entry point.
import { withSentryConfig } from "@sentry/nextjs/config";

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Build with one worker. The parallel default is what kept crashing the dev
    // server here ("Jest worker encountered 2 child process exceptions"), and a
    // slower build is a fair trade for one that finishes.
    //
    // `workerThreads: true` belongs with this and must NOT come back: it moves
    // page generation into a thread that never receives Next's internal
    // revalidation address, so the build fails at "Generating static pages"
    // with `Failed to parse URL from http://localhost:undefined`. Compilation
    // succeeds first, which makes it look like a late, unrelated failure.
    cpus: 1,
  },
};

// Sentry (lib/sentry-options.ts). At build time this uploads source maps, so a browser
// error points at the real line instead of minified code — only when SENTRY_AUTH_TOKEN,
// SENTRY_ORG and SENTRY_PROJECT are set in Vercel. Without them the build is unchanged.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // The EU region; the auth token would say so too, but explicit is clearer.
  sentryUrl: process.env.SENTRY_URL || "https://de.sentry.io/",
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN, deleteSourcemapsAfterUpload: true },
  telemetry: false,
});
