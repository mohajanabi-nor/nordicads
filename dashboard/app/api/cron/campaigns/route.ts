/**
 * Finish campaigns nobody is watching.
 *
 * A send is driven by whoever has the progress view open. That covers the
 * normal case and none of the others: the tab gets closed, the laptop sleeps,
 * the batch runs out of budget, an instance dies mid-send. Without this sweep
 * each of those leaves a customer list half-mailed with no one coming back for
 * it — which is worse than not sending at all, because it is invisible.
 *
 * Idempotent by construction: the recipient log records every attempt, so this
 * resumes rather than restarts, and a lease keeps it from colliding with a
 * browser that is driving the same campaign.
 */
import { runCampaignBatch, unfinishedCampaigns } from "@/lib/campaign-runner";
import { logError, logInfo } from "@/lib/eventlog";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/** Headroom under maxDuration, shared across however many campaigns are open. */
const TOTAL_BUDGET_MS = 600_000;

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

  try {
    const ids = await unfinishedCampaigns();
    if (!ids.length) return Response.json({ ok: true, campaigns: [] });

    const startedAt = Date.now();
    const results: Record<string, unknown>[] = [];

    for (const id of ids) {
      const left = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      if (left < 15_000) break; // not enough time to be useful; next tick takes it

      const r = await runCampaignBatch(id, { budgetMs: left, signal: req.signal });
      results.push({ id, ran: r.ran, sent: r.sent, remaining: r.remaining, complete: r.complete });

      if (r.ran && r.complete) {
        await logInfo("campaign", "campaign.resumedFinished", `Kampanje ${id} fullført av bakgrunnsjobb.`, {
          campaignId: id,
          sent: r.sent,
        });
      }
    }

    return Response.json({ ok: true, campaigns: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logError("campaign", "campaign.sweepFailed", `Bakgrunnsjobb for kampanjer feilet: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
