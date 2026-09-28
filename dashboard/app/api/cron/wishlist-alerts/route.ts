/**
 * The wishlist's hourly run.
 *
 * Webhooks catch price and stock changes within seconds; this is the net under them.
 * Every hour it checks every saved product against Shopify (a missed webhook costs an
 * hour, not an alert) and sends alerts that waited out a customer's quiet period.
 */
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
    const checked = await checkAll();
    const waited = await deliver();
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
