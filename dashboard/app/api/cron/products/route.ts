/**
 * Keep the picker's product list current, on a schedule.
 *
 * Until now nothing refreshed it automatically: every sync in the job table was
 * someone pressing the refresh button in the picker. So the list was as current
 * as the last person who thought to press it, and on a morning when a delivery
 * landed and nobody did, the operator was picking from yesterday's catalogue
 * without anything on screen saying so.
 *
 * Runs through the working day rather than once at night, because goods are
 * booked into Shopify while people are at work — a 04:00 sync would be stale by
 * the time the first truck is unloaded. It is cheap to do: the fetch itself is
 * about a minute of runner time.
 *
 * Like the nightly contact sync this only DISPATCHES; the runner fetches from
 * Shopify and posts the result to /api/internal/sync-products.
 */
import { dispatchRender, usesGitHubActions } from "@/lib/github-actions";
import { activeJobFor, createJob, newJobId } from "@/lib/worker-jobs";
import { logError, logInfo } from "@/lib/eventlog";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Same check as the nightly sync: without it this is a button anyone can press
 *  to spend Actions minutes and Shopify quota. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  if (presented.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= presented.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "ugyldig cron-token" }, { status: 401 });
  }

  if (!usesGitHubActions()) {
    return Response.json(
      { error: "GITHUB_TOKEN/GITHUB_REPO mangler — kan ikke starte produktsynk" },
      { status: 503 },
    );
  }

  try {
    // The workflow holds one pending run per concurrency group, so a scheduled
    // sync landing on top of a render (or of someone's refresh click) would
    // cancel whatever was waiting. Skipping is the right answer: the next tick
    // is two hours away, and whatever is already running is fresher anyway.
    const running = await activeJobFor("products");
    if (running) {
      return Response.json({ ok: true, skipped: "allerede i gang", jobId: running.id });
    }

    const jobId = newJobId();
    await createJob(jobId, "products", { trigger: "cron" });
    await dispatchRender(jobId, { command: "products" });
    await logInfo("scheduler", "products.dispatched", "Produktsynk startet.", { jobId });
    return Response.json({ ok: true, jobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logError("scheduler", "products.dispatchFailed", `Kunne ikke starte produktsynk: ${message}`);
    return Response.json({ error: message }, { status: 502 });
  }
}
