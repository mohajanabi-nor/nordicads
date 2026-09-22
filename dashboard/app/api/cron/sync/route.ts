/**
 * The nightly contact sync, triggered by Vercel Cron.
 *
 * Replaces an in-process `setInterval`, which on a serverless host is not a
 * scheduler at all: there is no process sitting between requests to fire it, and
 * where one briefly exists it belongs to a single instance that may vanish
 * mid-timer. It also fired on server start, which is how a sync ran the moment
 * a dev server booted.
 *
 * This only DISPATCHES the fetch. The runner does the Shopify call and posts the
 * result back to /api/internal/sync-customers, because a paginated customer
 * fetch does not fit in a serverless function's budget and the Shopify client
 * lives in the worker anyway.
 */
import { dispatchRender, usesGitHubActions } from "@/lib/github-actions";
import { createJob, newJobId } from "@/lib/worker-jobs";
import { logError, logInfo } from "@/lib/eventlog";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel sets this header on scheduled invocations when CRON_SECRET is
 * configured. Without the check the endpoint is a button anyone can press to
 * spend Actions minutes and Shopify quota.
 */
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
      { error: "GITHUB_TOKEN/GITHUB_REPO mangler — kan ikke starte synk" },
      { status: 503 },
    );
  }

  try {
    const jobId = newJobId();
    await createJob(jobId, "customers", { trigger: "cron" });
    await dispatchRender(jobId, { command: "customers" });
    await logInfo("scheduler", "sync.dispatched", "Nattlig synk startet.", { jobId });
    return Response.json({ ok: true, jobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logError("scheduler", "sync.dispatchFailed", `Kunne ikke starte synk: ${message}`);
    return Response.json({ error: message }, { status: 502 });
  }
}
