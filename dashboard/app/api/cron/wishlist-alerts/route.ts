/**
 * The wishlist's hourly run.
 *
 * Webhooks catch price and stock changes within seconds; this is the net under them.
 * Every hour it checks every saved product against Shopify (a missed webhook costs an
 * hour, not an alert) and sends alerts that waited out a customer's quiet period.
 *
 * It is also Sentry's cron monitor: each run checks in, so a run that fails, hangs, or
 * doesn't happen at all (Vercel cron stopped, deploy broke the route) raises an alert.
 */
import * as Sentry from "@sentry/nextjs";
import { checkAll, deliver } from "@/lib/wishlist-alerts";
import { logError, logInfo } from "@/lib/eventlog";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
    // Inside the monitor, so a failure marks the check-in as failed before it's caught below.
    const { checked, waited } = await Sentry.withMonitor(
      "wishlist-hourly",
      async () => ({ checked: await checkAll(), waited: await deliver() }),
      {
        schedule: { type: "crontab", value: "0 * * * *" },
        timezone: "Etc/UTC",
        checkinMargin: 10, // minutes late before it counts as missed
        maxRuntime: 10, // minutes before a run counts as hung
      },
    );
    // Emails sent the moment a change was found, plus ones that waited out a quiet period.
    const sent = checked.sent + waited.sent;
    if (checked.found || sent) {
      await logInfo(
        "wishlist",
        "wishlist.hourly",
        `Ønskeliste: ${checked.checked} varer sjekket, ${checked.found} endringer, ${sent} e-poster sendt.`,
        { checked, waited },
      );
    }
    return Response.json({ ok: true, checked, waited, sent });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logError("wishlist", "wishlist.hourlyFailed", `Timesjekk av ønskelister feilet: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
