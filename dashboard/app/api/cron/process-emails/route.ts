/**
 * Read the supplier emails that have arrived.
 *
 * Polling rather than a push from the webhook, deliberately. Extraction is a
 * multi-step job — download attachments, run Claude over each, match every row
 * to a product — and pushing that from the webhook would mean Resend timing out
 * and redelivering the same email while the first copy was still being read.
 *
 * Each email is claimed with a conditional update, so overlapping runs cannot
 * process the same one twice, and anything left over is simply picked up on the
 * next tick.
 */
import { pendingEmails, processEmail } from "@/lib/price-pipeline";
import { logError } from "@/lib/eventlog";
import { verifyBearer } from "@/lib/webhook-verify";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/** Headroom under maxDuration, shared across the emails in this run. */
const TOTAL_BUDGET_MS = 600_000;
/** A scanned catalogue can take a minute on its own; stop starting new ones
 *  with less than this left rather than being cut off mid-extraction. */
const MIN_PER_EMAIL_MS = 90_000;

export async function GET(req: Request) {
  if (!verifyBearer(req, process.env.CRON_SECRET || "")) {
    return Response.json({ error: "ugyldig cron-token" }, { status: 401 });
  }

  try {
    const queue = await pendingEmails();
    if (!queue.length) return Response.json({ ok: true, processed: [] });

    const startedAt = Date.now();
    const processed = [];

    for (const email of queue) {
      if (TOTAL_BUDGET_MS - (Date.now() - startedAt) < MIN_PER_EMAIL_MS) break;
      processed.push(await processEmail(email.id));
    }

    return Response.json({ ok: true, processed });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logError("priser", "priser.sweepFailed", `Bakgrunnsjobb for prisepost feilet: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
